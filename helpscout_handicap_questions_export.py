#!/usr/bin/env python3
"""Export the 150 newest Help Scout tickets involving handicap questions."""

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
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


API_BASE = "https://api.helpscout.net/v2"
TOKEN_URL = f"{API_BASE}/oauth2/token"
SEARCH_TERM = "handicap"
DEFAULT_LIMIT = 150
MAX_RETRIES = 6


class HTMLTextExtractor(HTMLParser):
    BLOCK_TAGS = {"address", "article", "aside", "blockquote", "br", "div", "dl", "dt", "dd", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "td", "th", "thead", "tbody", "tfoot", "ul"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
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

    def text(self) -> str:
        value = unescape("".join(self.parts)).replace("\r", "\n")
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n[ \t]+", "\n", value)
        value = re.sub(r"[ \t]+", " ", value)
        return re.sub(r"\n{3,}", "\n\n", value).strip()


def strip_html(value: str) -> str:
    parser = HTMLTextExtractor()
    parser.feed(value or "")
    parser.close()
    return parser.text()


def customer_feedback(conversation: dict) -> str:
    messages: list[str] = []
    threads = conversation.get("_embedded", {}).get("threads", []) or []
    for thread in sorted(threads, key=lambda item: item.get("createdAt") or ""):
        created_by = thread.get("createdBy") or {}
        is_customer = str(created_by.get("type") or "").lower() == "customer" or bool(thread.get("customer"))
        if not is_customer or str(thread.get("state") or "").lower() not in {"", "published"}:
            continue
        if str(thread.get("type") or "").lower() in {"note", "lineitem", "chatline"}:
            continue
        message = strip_html(str(thread.get("body") or thread.get("plaintext") or thread.get("bodyPreview") or ""))
        if message:
            messages.append(message)
    return "\n\n---\n\n".join(messages)


def conversation_url(conversation: dict) -> str:
    href = ((conversation.get("_links") or {}).get("web") or {}).get("href")
    if href:
        return str(href)
    conversation_id, number = conversation.get("id"), conversation.get("number")
    return f"https://secure.helpscout.net/conversation/{conversation_id}/{number}/" if conversation_id and number else ""


def render_progress(current: int, total: int) -> None:
    width = 28
    filled = int(width * current / max(total, 1))
    print(f"\rFetching tickets [{'#' * filled}{'-' * (width - filled)}] {current}/{total}", end="", file=sys.stderr, flush=True)


class HelpScoutClient:
    def __init__(self, client_id: str, client_secret: str, pause_seconds: float) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.pause_seconds = pause_seconds
        self.access_token: str | None = None

    def authenticate(self) -> None:
        payload = urlencode({"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret}).encode("utf-8")
        request = Request(TOKEN_URL, data=payload, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, method="POST")
        with urlopen(request, timeout=30) as response:
            self.access_token = json.loads(response.read().decode("utf-8")).get("access_token")
        if not self.access_token:
            raise RuntimeError("Help Scout did not return an access token.")

    def request_json(self, path: str, **params) -> dict:
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
                    payload = json.loads(response.read().decode("utf-8"))
                if self.pause_seconds:
                    time.sleep(self.pause_seconds)
                return payload
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
            print(f"\nRetrying after {reason} in {wait_seconds}s...", file=sys.stderr)
            time.sleep(wait_seconds)
        raise RuntimeError(f"Exceeded retries for {url}")

    def search_handicap(self, limit: int) -> list[dict]:
        results: list[dict] = []
        page = 1
        while len(results) < limit:
            payload = self.request_json("/conversations", status="all", query=f'"{SEARCH_TERM}"', sortField="createdAt", sortOrder="desc", page=page, pageSize=100)
            conversations = payload.get("_embedded", {}).get("conversations", []) or []
            results.extend(conversations)
            page_info = payload.get("page", {}) or {}
            if page >= (page_info.get("totalPages") or page_info.get("pages") or 1) or not conversations:
                break
            page += 1
        return results[:limit]

    def get_conversation(self, conversation_id: int) -> dict:
        return self.request_json(f"/conversations/{conversation_id}", embed="threads")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the newest handicap-related Help Scout questions.")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Number of tickets to export (default: 150).")
    parser.add_argument("--out-dir", type=Path, default=Path.home() / "Desktop" / "helpscout-handicap-questions-export", help="Folder for tickets.csv.")
    parser.add_argument("--pause-seconds", type=float, default=0.1, help="Delay between Help Scout requests (default: 0.1).")
    args = parser.parse_args()
    if args.limit < 1:
        print("--limit must be at least 1.", file=sys.stderr)
        return 2
    client_id, client_secret = os.environ.get("HELPSCOUT_CLIENT_ID"), os.environ.get("HELPSCOUT_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("Missing Help Scout credentials. Set HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET first.", file=sys.stderr)
        return 2

    client = HelpScoutClient(client_id, client_secret, args.pause_seconds)
    client.authenticate()
    summaries = client.search_handicap(args.limit)
    rows: list[dict] = []
    for index, summary in enumerate(summaries, start=1):
        conversation = client.get_conversation(int(summary["id"])) if summary.get("id") else {}
        if conversation:
            rows.append({"ticket_id": str(conversation.get("number") or conversation.get("id") or ""), "date_created": str(conversation.get("createdAt") or ""), "helpscout_url": conversation_url(conversation), "customer_feedback": customer_feedback(conversation), "status": str(conversation.get("status") or "")})
        render_progress(index, len(summaries))
    print(file=sys.stderr)

    output_path = args.out_dir.expanduser().resolve() / "tickets.csv"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["ticket_id", "date_created", "helpscout_url", "customer_feedback", "status"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} handicap-related tickets to {output_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
