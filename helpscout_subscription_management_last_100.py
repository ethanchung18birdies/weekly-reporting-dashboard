#!/usr/bin/env python3
"""Export the 100 most recently created Subscription Management tickets.

The CSV contains the created date, Help Scout URL, and customer-authored
feedback with HTML converted to readable plain text. It includes both active
and closed conversations.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


API_BASE = "https://api.helpscout.net/v2"
TOKEN_URL = f"{API_BASE}/oauth2/token"
DEFAULT_TEAM = "Subscription Management"
DEFAULT_LIMIT = 100
MAX_RETRIES = 6


class HTMLTextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "address", "article", "aside", "blockquote", "br", "div", "dl", "dt", "dd",
        "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
        "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
        "table", "tr", "td", "th", "thead", "tbody", "tfoot", "ul",
    }

    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style"}:
            self.skip_depth += 1
        elif self.skip_depth == 0 and tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.skip_depth:
            self.skip_depth -= 1
        elif self.skip_depth == 0 and tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth == 0 and data:
            self.parts.append(data)

    def get_text(self) -> str:
        text = unescape("".join(self.parts)).replace("\r", "\n")
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n[ \t]+", "\n", text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def strip_html(value: str) -> str:
    parser = HTMLTextExtractor()
    parser.feed(value or "")
    parser.close()
    return parser.get_text()


def normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def render_progress(current: int, total: int) -> None:
    width = 28
    filled = int(width * current / max(total, 1))
    print(f"\rFetching ticket details [{'#' * filled}{'-' * (width - filled)}] {current}/{total}", end="", file=sys.stderr, flush=True)


def thread_is_customer(thread: dict) -> bool:
    created_by = thread.get("createdBy") or {}
    return str(created_by.get("type") or "").lower() == "customer" or bool(thread.get("customer"))


def customer_feedback(conversation: dict) -> str:
    feedback: List[str] = []
    threads = conversation.get("_embedded", {}).get("threads", []) or []
    for thread in sorted(threads, key=lambda item: item.get("createdAt") or ""):
        if str(thread.get("state") or "").lower() not in {"", "published"}:
            continue
        if str(thread.get("type") or "").lower() in {"note", "lineitem", "chatline"}:
            continue
        if not thread_is_customer(thread):
            continue
        body = strip_html(str(thread.get("body") or thread.get("plaintext") or thread.get("bodyPreview") or ""))
        if body:
            feedback.append(body)
    return "\n\n---\n\n".join(feedback)


def conversation_url(conversation: dict) -> str:
    href = ((conversation.get("_links") or {}).get("web") or {}).get("href")
    if href:
        return str(href)
    conversation_id = conversation.get("id")
    number = conversation.get("number")
    return f"https://secure.helpscout.net/conversation/{conversation_id}/{number}/" if conversation_id and number else ""


class HelpScoutClient:
    def __init__(self, client_id: str, client_secret: str, pause_seconds: float) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.pause_seconds = pause_seconds
        self.access_token: Optional[str] = None

    def authenticate(self) -> None:
        payload = urlencode({"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret}).encode("utf-8")
        request = Request(TOKEN_URL, data=payload, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=30) as response:
                response_data = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise RuntimeError(f"Help Scout sign-in failed with HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}") from exc
        except URLError as exc:
            raise RuntimeError(f"Could not reach Help Scout sign-in: {exc}") from exc
        self.access_token = response_data.get("access_token")
        if not self.access_token:
            raise RuntimeError("Help Scout did not return an access token.")

    def _request_json(self, path: str, **params) -> dict:
        if not self.access_token:
            raise RuntimeError("The Help Scout client is not authenticated.")
        url = urljoin(f"{API_BASE}/", path.lstrip("/"))
        query = urlencode({key: value for key, value in params.items() if value is not None})
        if query:
            url = f"{url}?{query}"
        request = Request(url, headers={"Authorization": f"Bearer {self.access_token}", "Accept": "application/json"})

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                with urlopen(request, timeout=60) as response:
                    response_data = json.loads(response.read().decode("utf-8"))
                if self.pause_seconds:
                    time.sleep(self.pause_seconds)
                return response_data
            except HTTPError as exc:
                if exc.code == 404:
                    return {}
                if exc.code not in {429, 500, 502, 503, 504} or attempt == MAX_RETRIES:
                    raise RuntimeError(f"Help Scout API error {exc.code} for {url}: {exc.read().decode('utf-8', errors='replace')}") from exc
                reason = f"HTTP {exc.code}"
            except (URLError, ConnectionResetError, TimeoutError) as exc:
                if attempt == MAX_RETRIES:
                    raise RuntimeError(f"Could not reach Help Scout API at {url}: {exc}") from exc
                reason = "network error"
            wait_seconds = min(30, 2 ** attempt)
            print(f"\nRetrying {url} after {reason} in {wait_seconds}s...", file=sys.stderr)
            time.sleep(wait_seconds)
        raise RuntimeError(f"Exceeded retries for {url}")

    def list_users(self) -> Iterable[dict]:
        page = 1
        while True:
            payload = self._request_json("/users", page=page, pageSize=100)
            users = payload.get("_embedded", {}).get("users", []) or []
            yield from users
            page_info = payload.get("page", {}) or {}
            if page >= (page_info.get("totalPages") or page_info.get("pages") or 1) or not users:
                break
            page += 1

    def list_recent_conversations(self, assignee_id: int, limit: int) -> List[dict]:
        results: List[dict] = []
        page = 1
        while len(results) < limit:
            payload = self._request_json(
                "/conversations",
                status="all",
                assigned_to=assignee_id,
                page=page,
                pageSize=min(100, limit),
                sortField="createdAt",
                sortOrder="desc",
            )
            conversations = payload.get("_embedded", {}).get("conversations", []) or []
            results.extend(conversations)
            page_info = payload.get("page", {}) or {}
            if page >= (page_info.get("totalPages") or page_info.get("pages") or 1) or not conversations:
                break
            page += 1
        return results[:limit]

    def get_conversation(self, conversation_id: int) -> dict:
        return self._request_json(f"/conversations/{conversation_id}", embed="threads")


def user_display_name(user: dict) -> str:
    return str(user.get("name") or " ".join(part for part in (user.get("firstName") or "", user.get("lastName") or "") if part) or user.get("email") or "")


def resolve_team_id(client: HelpScoutClient, team_name: str) -> int:
    matches = [user for user in client.list_users() if normalize_name(user_display_name(user)) == normalize_name(team_name)]
    if len(matches) == 1:
        return int(matches[0]["id"])
    if not matches:
        raise RuntimeError(f"Could not find a Help Scout team/user named '{team_name}'.")
    raise RuntimeError(f"More than one Help Scout team/user matches '{team_name}'. Use --team-id to specify one.")


def write_csv(output_path: Path, rows: List[dict]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["date_created", "helpscout_url", "customer_feedback"])
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the newest Subscription Management tickets with cleaned customer feedback.")
    parser.add_argument("--team", default=DEFAULT_TEAM, help=f"Help Scout team/user name (default: {DEFAULT_TEAM}).")
    parser.add_argument("--team-id", type=int, help="Help Scout team/user ID; overrides --team.")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Number of recent tickets to export (default: 100).")
    parser.add_argument("--out-dir", type=Path, default=Path.home() / "Desktop" / "helpscout-subscription-management-last-100", help="Folder for tickets.csv.")
    parser.add_argument("--pause-seconds", type=float, default=0.1, help="Delay between API requests (default: 0.1).")
    args = parser.parse_args()

    if args.limit < 1:
        print("--limit must be at least 1.", file=sys.stderr)
        return 2
    client_id = os.environ.get("HELPSCOUT_APP_ID") or os.environ.get("HELPSCOUT_CLIENT_ID")
    client_secret = os.environ.get("HELPSCOUT_APP_SECRET") or os.environ.get("HELPSCOUT_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("Missing Help Scout credentials. Set HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET first.", file=sys.stderr)
        return 2

    client = HelpScoutClient(client_id, client_secret, args.pause_seconds)
    client.authenticate()
    team_id = args.team_id or resolve_team_id(client, args.team)
    summaries = client.list_recent_conversations(team_id, args.limit)
    rows: List[dict] = []
    for index, summary in enumerate(summaries, start=1):
        conversation_id = summary.get("id")
        if conversation_id:
            full = client.get_conversation(int(conversation_id))
            if full:
                rows.append({"date_created": str(full.get("createdAt") or ""), "helpscout_url": conversation_url(full), "customer_feedback": customer_feedback(full)})
        render_progress(index, len(summaries))
    print(file=sys.stderr)
    output_path = args.out_dir.expanduser().resolve() / "tickets.csv"
    write_csv(output_path, rows)
    print(f"Wrote {len(rows)} tickets to {output_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
