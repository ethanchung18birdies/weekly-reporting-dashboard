#!/usr/bin/env python3
"""
Export active Help Scout tickets assigned to "golf course gps data".

Output:
- tickets.csv

Columns:
- feedback
- date_submitted
- helpscout_url
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
DEFAULT_ASSIGNEE = "golf course gps data"
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
            return
        if self.skip_depth == 0 and tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if self.skip_depth == 0 and tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth == 0 and data:
            self.parts.append(data)

    def get_text(self) -> str:
        text = unescape("".join(self.parts))
        text = text.replace("\r", "\n")
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
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def render_progress(label: str, current: int, total: int) -> None:
    total = max(total, 1)
    current = min(current, total)
    width = 28
    filled = int(width * current / total)
    bar = "#" * filled + "-" * (width - filled)
    print(f"\r{label} [{bar}] {current}/{total}", end="", file=sys.stderr, flush=True)


def finish_progress() -> None:
    print(file=sys.stderr, flush=True)


def thread_is_customer(thread: dict) -> bool:
    created_by = thread.get("createdBy") or {}
    if str(created_by.get("type") or "").lower() == "customer":
        return True
    return bool(thread.get("customer"))


def thread_text(thread: dict) -> str:
    raw = thread.get("body") or thread.get("plaintext") or thread.get("bodyPreview") or ""
    return strip_html(str(raw)).strip()


def extract_feedback(conversation: dict) -> str:
    threads = conversation.get("_embedded", {}).get("threads", []) or []
    sorted_threads = sorted(threads, key=lambda item: item.get("createdAt") or "")

    customer_parts: List[str] = []
    fallback_parts: List[str] = []

    for thread in sorted_threads:
        thread_type = str(thread.get("type") or "").strip().lower()
        state = str(thread.get("state") or "").strip().lower()
        if state and state != "published":
            continue
        if thread_type in {"note", "lineitem", "chatline"}:
            continue

        body = thread_text(thread)
        if not body:
            continue

        if thread_is_customer(thread):
            customer_parts.append(body)
        fallback_parts.append(body)

    if customer_parts:
        return "\n\n---\n\n".join(customer_parts)

    subject = strip_html(str(conversation.get("subject") or "")).strip()
    if fallback_parts:
        if subject:
            return f"Subject: {subject}\n\n---\n\n" + "\n\n---\n\n".join(fallback_parts)
        return "\n\n---\n\n".join(fallback_parts)

    return subject


def conversation_url(conversation: dict) -> str:
    links = conversation.get("_links") or {}
    web = links.get("web") or {}
    href = web.get("href")
    if href:
        return str(href)

    conversation_id = conversation.get("id")
    number = conversation.get("number")
    if conversation_id and number:
        return f"https://secure.helpscout.net/conversation/{conversation_id}/{number}/"
    return ""


class HelpScoutClient:
    def __init__(self, client_id: str, client_secret: str, pause_seconds: float = 0.1) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.pause_seconds = pause_seconds
        self.access_token: Optional[str] = None

    def authenticate(self) -> None:
        payload = urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode("utf-8")
        request = Request(
            TOKEN_URL,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OAuth failed with HTTP {exc.code}: {body}") from exc
        except URLError as exc:
            raise RuntimeError(f"Could not reach Help Scout OAuth endpoint: {exc}") from exc

        token = data.get("access_token")
        if not token:
            raise RuntimeError(f"Help Scout OAuth response did not include an access token: {data}")
        self.access_token = token

    def _request_json(self, path: str, **params) -> dict:
        if not self.access_token:
            raise RuntimeError("Client is not authenticated")

        query = urlencode({k: v for k, v in params.items() if v is not None})
        url = urljoin(f"{API_BASE}/", path.lstrip("/"))
        if query:
            url = f"{url}?{query}"

        request = Request(
            url,
            headers={"Authorization": f"Bearer {self.access_token}", "Accept": "application/json"},
        )

        last_error: Optional[Exception] = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                with urlopen(request, timeout=60) as response:
                    if self.pause_seconds:
                        time.sleep(self.pause_seconds)
                    return json.loads(response.read().decode("utf-8"))
            except HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                if exc.code in {429, 500, 502, 503, 504} and attempt < MAX_RETRIES:
                    wait_seconds = min(30, 2 ** attempt)
                    print(f"Retrying {url} after HTTP {exc.code} in {wait_seconds}s...", file=sys.stderr)
                    time.sleep(wait_seconds)
                    last_error = exc
                    continue
                raise RuntimeError(f"Help Scout API error {exc.code} for {url}: {body}") from exc
            except URLError as exc:
                if attempt < MAX_RETRIES:
                    wait_seconds = min(30, 2 ** attempt)
                    print(f"Retrying {url} after network error in {wait_seconds}s...", file=sys.stderr)
                    time.sleep(wait_seconds)
                    last_error = exc
                    continue
                raise RuntimeError(f"Could not reach Help Scout API at {url}: {exc}") from exc
            except ConnectionResetError as exc:
                if attempt < MAX_RETRIES:
                    wait_seconds = min(30, 2 ** attempt)
                    print(f"Retrying {url} after connection reset in {wait_seconds}s...", file=sys.stderr)
                    time.sleep(wait_seconds)
                    last_error = exc
                    continue
                raise RuntimeError(f"Connection reset while reaching Help Scout API at {url}: {exc}") from exc

        raise RuntimeError(f"Exceeded max retries for {url}: {last_error}")

    def list_users(self) -> Iterable[dict]:
        page = 1
        while True:
            payload = self._request_json("/users", page=page)
            users = payload.get("_embedded", {}).get("users", []) or []
            for user in users:
                yield user

            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            current_page = page_info.get("number") or page_info.get("page") or page
            if current_page >= total_pages or not users:
                break
            page += 1

    def list_active_conversations(self, assigned_to: Optional[int], query: Optional[str]) -> List[dict]:
        results: List[dict] = []
        page = 1
        while True:
            payload = self._request_json(
                "/conversations",
                status="active",
                assigned_to=assigned_to,
                query=query,
                sortField="createdAt",
                sortOrder="asc",
                page=page,
            )
            conversations = payload.get("_embedded", {}).get("conversations", []) or []
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            current_page = page_info.get("number") or page_info.get("page") or page
            results.extend(conversations)
            render_progress("Loading pages ", current_page, total_pages)
            if current_page >= total_pages or not conversations:
                break
            page += 1
        finish_progress()
        return results

    def get_conversation(self, conversation_id: int) -> dict:
        return self._request_json(f"/conversations/{conversation_id}", embed="threads")


def resolve_assignee_user_id(client: HelpScoutClient, assignee_name: str) -> Optional[int]:
    target = normalize_name(assignee_name)
    matches: List[dict] = []

    for user in client.list_users():
        first = str(user.get("firstName") or "")
        last = str(user.get("lastName") or "")
        mention = str(user.get("mention") or "")
        full_name = normalize_name(" ".join(part for part in [first, last] if part))
        candidates = {
            normalize_name(first),
            normalize_name(last),
            full_name,
            normalize_name(mention),
        }
        if target in candidates:
            matches.append(user)

    if len(matches) == 1:
        return int(matches[0]["id"])
    return None


def assignee_matches(conversation: dict, assignee_name: str) -> bool:
    assignee = conversation.get("assignee") or {}
    first = normalize_name(str(assignee.get("firstName") or ""))
    last = normalize_name(str(assignee.get("lastName") or ""))
    full = normalize_name(f"{first} {last}".strip())
    target = normalize_name(assignee_name)
    return target in {first, last, full}


def write_csv(path: Path, rows: List[dict]) -> None:
    fieldnames = ["feedback", "date_submitted", "helpscout_url"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def export_feedback(client: HelpScoutClient, out_dir: Path, assignee_name: str) -> int:
    assignee_id = resolve_assignee_user_id(client, assignee_name)
    query = None if assignee_id is not None else f'(assigned:"{assignee_name}")'
    summaries = client.list_active_conversations(assigned_to=assignee_id, query=query)

    rows: List[dict] = []
    total = len(summaries)
    for index, summary in enumerate(summaries, start=1):
        conversation_id = summary.get("id")
        if not conversation_id:
            render_progress("Fetching tickets", index, total)
            continue

        full = client.get_conversation(int(conversation_id))
        if str(full.get("status") or "").lower() != "active":
            render_progress("Fetching tickets", index, total)
            continue
        if assignee_id is None and not assignee_matches(full, assignee_name):
            render_progress("Fetching tickets", index, total)
            continue

        rows.append(
            {
                "feedback": extract_feedback(full),
                "date_submitted": str(full.get("createdAt") or ""),
                "helpscout_url": conversation_url(full),
            }
        )
        render_progress("Fetching tickets", index, total)

    if total:
        finish_progress()

    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "tickets.csv", rows)
    return len(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Export cleaned feedback, date, and Help Scout URL for active tickets assigned to "golf course gps data".'
    )
    parser.add_argument("--assignee", default=DEFAULT_ASSIGNEE, help="Help Scout assignee name.")
    parser.add_argument("--out-dir", default="helpscout-golf-course-gps-data-export", help="Directory to write output.")
    parser.add_argument("--pause-seconds", type=float, default=0.1, help="Delay between API requests.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    client_id = os.environ.get("HELPSCOUT_APP_ID") or os.environ.get("HELPSCOUT_CLIENT_ID")
    client_secret = os.environ.get("HELPSCOUT_APP_SECRET") or os.environ.get("HELPSCOUT_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Missing Help Scout credentials. Set HELPSCOUT_APP_ID/HELPSCOUT_APP_SECRET "
            "or HELPSCOUT_CLIENT_ID/HELPSCOUT_CLIENT_SECRET.",
            file=sys.stderr,
        )
        return 2

    out_dir = Path(args.out_dir).expanduser().resolve()
    client = HelpScoutClient(client_id=client_id, client_secret=client_secret, pause_seconds=args.pause_seconds)
    client.authenticate()
    count = export_feedback(client=client, out_dir=out_dir, assignee_name=args.assignee)
    print(f"Wrote {count} rows to {out_dir / 'tickets.csv'}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
