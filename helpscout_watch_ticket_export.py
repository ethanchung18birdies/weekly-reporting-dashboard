#!/usr/bin/env python3
"""
Export Help Scout tickets involving "apple watch" and "android watch".

Outputs:
- apple_watch_tickets.csv
- android_watch_tickets.csv

Columns:
- feedback
- date_submitted
- helpscout_url
- status
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen
import os


API_BASE = "https://api.helpscout.net/v2"
TOKEN_URL = f"{API_BASE}/oauth2/token"
MAX_RETRIES = 6
DEFAULT_LIMIT_PER_TERM = 500
SEARCH_TERMS = [
    ("apple watch", "apple_watch_tickets.csv"),
    ("android watch", "android_watch_tickets.csv"),
]


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

    def search_conversations(self, term: str, limit: int) -> List[dict]:
        results: List[dict] = []
        page = 1
        while len(results) < limit:
            payload = self._request_json(
                "/conversations",
                status="all",
                query=f'"{term}"',
                sortField="createdAt",
                sortOrder="desc",
                page=page,
                pageSize=100,
            )
            conversations = payload.get("_embedded", {}).get("conversations", []) or []
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            current_page = page_info.get("number") or page_info.get("page") or page
            results.extend(conversations[: limit - len(results)])
            render_progress(f"Loading {term:<13}", current_page, total_pages)
            if len(results) >= limit or current_page >= total_pages or not conversations:
                break
            page += 1
        finish_progress()
        return results[:limit]

    def get_conversation(self, conversation_id: int) -> dict:
        return self._request_json(f"/conversations/{conversation_id}", embed="threads")


def write_csv(path: Path, rows: List[dict]) -> None:
    fieldnames = ["feedback", "date_submitted", "helpscout_url", "status"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def export_term(client: HelpScoutClient, out_dir: Path, term: str, filename: str, limit: int) -> int:
    summaries = client.search_conversations(term, limit)
    rows: List[dict] = []
    total = len(summaries)

    for index, summary in enumerate(summaries, start=1):
        conversation_id = summary.get("id")
        if not conversation_id:
            render_progress(f"Fetching {term:<12}", index, total)
            continue

        full = client.get_conversation(int(conversation_id))
        status = str(full.get("status") or "").lower()
        if status not in {"active", "closed"}:
            render_progress(f"Fetching {term:<12}", index, total)
            continue

        rows.append(
            {
                "feedback": extract_feedback(full),
                "date_submitted": str(full.get("createdAt") or ""),
                "helpscout_url": conversation_url(full),
                "status": status,
            }
        )
        render_progress(f"Fetching {term:<12}", index, total)

    if total:
        finish_progress()

    write_csv(out_dir / filename, rows)
    return len(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export Help Scout tickets involving apple watch and android watch."
    )
    parser.add_argument(
        "--out-dir",
        default="helpscout-watch-ticket-export",
        help="Directory to write output.",
    )
    parser.add_argument(
        "--pause-seconds",
        type=float,
        default=0.1,
        help="Delay between API requests.",
    )
    parser.add_argument(
        "--limit-per-term",
        type=int,
        default=DEFAULT_LIMIT_PER_TERM,
        help="Maximum tickets to export for each watch search (default: 500).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.limit_per_term < 1:
        print("--limit-per-term must be at least 1.", file=sys.stderr)
        return 2

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
    out_dir.mkdir(parents=True, exist_ok=True)

    client = HelpScoutClient(client_id=client_id, client_secret=client_secret, pause_seconds=args.pause_seconds)
    client.authenticate()

    counts: List[str] = []
    for term, filename in SEARCH_TERMS:
        count = export_term(
            client=client,
            out_dir=out_dir,
            term=term,
            filename=filename,
            limit=args.limit_per_term,
        )
        counts.append(f"{filename}: {count}")

    print(f"Wrote exports to {out_dir}. " + ", ".join(counts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
