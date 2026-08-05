#!/usr/bin/env python3
"""Export the 500 most recent Golf Course Scorecard Data tickets with images.

The export includes active and closed conversations assigned to the Help Scout
team/user named ``Golf Course Scorecard Data``. A ticket qualifies when one or
more of its thread attachments is an image. The CSV contains cleaned
customer feedback plus image filenames and secure Help Scout download links.
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
DEFAULT_TEAM = "Golf Course Scorecard Data"
DEFAULT_LIMIT = 200
MAX_RETRIES = 6
IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


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
    return str(created_by.get("type") or "").lower() == "customer" or bool(thread.get("customer"))


def customer_feedback(conversation: dict) -> str:
    parts: List[str] = []
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
            parts.append(body)
    return "\n\n---\n\n".join(parts)


def conversation_url(conversation: dict) -> str:
    href = ((conversation.get("_links") or {}).get("web") or {}).get("href")
    if href:
        return str(href)
    conversation_id = conversation.get("id")
    number = conversation.get("number")
    return f"https://secure.helpscout.net/conversation/{conversation_id}/{number}/" if conversation_id and number else ""


def is_image_attachment(attachment: dict) -> bool:
    mime_type = str(attachment.get("mimeType") or attachment.get("mime_type") or "").lower()
    filename = str(attachment.get("fileName") or attachment.get("filename") or attachment.get("name") or "").lower()
    return mime_type.startswith("image/") or any(filename.endswith(extension) for extension in IMAGE_EXTENSIONS)


def image_attachments(conversation: dict) -> List[dict]:
    images: List[dict] = []
    threads = conversation.get("_embedded", {}).get("threads", []) or []
    for thread in threads:
        # Help Scout returns thread attachments inside _embedded.attachments.
        # The direct fallback supports older response shapes.
        attachments = (thread.get("_embedded") or {}).get("attachments") or thread.get("attachments") or []
        for attachment in attachments:
            if not isinstance(attachment, dict) or not is_image_attachment(attachment):
                continue
            download_url = ((attachment.get("_links") or {}).get("download") or {}).get("href")
            images.append(
                {
                    "filename": str(attachment.get("fileName") or attachment.get("filename") or attachment.get("name") or "image"),
                    "mime_type": str(attachment.get("mimeType") or attachment.get("mime_type") or ""),
                    "download_url": str(download_url or ""),
                }
            )
    return images


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
                    data = json.loads(response.read().decode("utf-8"))
                if self.pause_seconds:
                    time.sleep(self.pause_seconds)
                return data
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
            print(f"Retrying {url} after {reason} in {wait_seconds}s...", file=sys.stderr)
            time.sleep(wait_seconds)
        raise RuntimeError(f"Exceeded retries for {url}")

    def list_users(self) -> Iterable[dict]:
        page = 1
        while True:
            payload = self._request_json("/users", page=page, pageSize=100)
            users = payload.get("_embedded", {}).get("users", []) or []
            yield from users
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            if page >= total_pages or not users:
                break
            page += 1

    def list_recent_conversations(self, assignee_id: int) -> Iterable[dict]:
        page = 1
        while True:
            payload = self._request_json(
                "/conversations",
                status="all",
                assigned_to=assignee_id,
                page=page,
                pageSize=100,
                sortField="createdAt",
                sortOrder="desc",
            )
            conversations = payload.get("_embedded", {}).get("conversations", []) or []
            if not conversations:
                break
            yield from conversations
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            if page >= total_pages:
                break
            page += 1

    def get_conversation(self, conversation_id: int) -> dict:
        return self._request_json(f"/conversations/{conversation_id}")

    def get_threads(self, conversation_id: int) -> List[dict]:
        """Load full thread records, including attachment metadata."""
        threads: List[dict] = []
        # Despite the API documentation example, this endpoint rejects page 0
        # and requires a positive page number.
        page = 1
        while True:
            payload = self._request_json(
                f"/conversations/{conversation_id}/threads",
                page=page,
                pageSize=100,
            )
            page_threads = payload.get("_embedded", {}).get("threads", []) or []
            threads.extend(page_threads)
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            if page >= total_pages or not page_threads:
                break
            page += 1
        return threads

    def get_conversation_with_threads(self, conversation_id: int) -> dict:
        conversation = self.get_conversation(conversation_id)
        if not conversation:
            return {}
        conversation["_embedded"] = {"threads": self.get_threads(conversation_id)}
        return conversation


def user_display_name(user: dict) -> str:
    first = str(user.get("firstName") or "")
    last = str(user.get("lastName") or "")
    return str(user.get("name") or " ".join(part for part in (first, last) if part) or user.get("email") or "")


def resolve_team_id(client: HelpScoutClient, team_name: str) -> int:
    target = normalize_name(team_name)
    matches = [user for user in client.list_users() if normalize_name(user_display_name(user)) == target]
    if len(matches) == 1:
        return int(matches[0]["id"])
    if not matches:
        raise RuntimeError(f"Could not find a Help Scout user/team named '{team_name}'.")
    raise RuntimeError(f"More than one Help Scout user/team matched '{team_name}'. Use --team-id to specify one.")


def write_csv(output_path: Path, rows: List[dict]) -> None:
    fieldnames = ["ticket_id", "helpscout_url", "created_at", "status", "subject", "customer_feedback", "image_count", "image_filenames", "image_download_links"]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def export_tickets(client: HelpScoutClient, team_id: int, limit: int, output_path: Path) -> int:
    rows: List[dict] = []
    inspected = 0
    for summary in client.list_recent_conversations(team_id):
        if len(rows) >= limit:
            break
        conversation_id = summary.get("id")
        if not conversation_id:
            continue
        inspected += 1
        # The dedicated threads endpoint includes attachment metadata that
        # embedded conversation threads can omit or truncate.
        full = client.get_conversation_with_threads(int(conversation_id))
        if not full:
            print(f"\rInspecting tickets: {inspected} checked, {len(rows)}/{limit} with images", end="", file=sys.stderr, flush=True)
            continue
        images = image_attachments(full)
        if images:
            rows.append(
                {
                    "ticket_id": str(full.get("number") or full.get("id") or ""),
                    "helpscout_url": conversation_url(full),
                    "created_at": str(full.get("createdAt") or ""),
                    "status": str(full.get("status") or ""),
                    "subject": strip_html(str(full.get("subject") or "")),
                    "customer_feedback": customer_feedback(full),
                    "image_count": len(images),
                    "image_filenames": " | ".join(image["filename"] for image in images),
                    "image_download_links": " | ".join(image["download_url"] for image in images if image["download_url"]),
                }
            )
        print(f"\rInspecting tickets: {inspected} checked, {len(rows)}/{limit} with images", end="", file=sys.stderr, flush=True)
    finish_progress()
    write_csv(output_path, rows)
    return len(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export recent image-containing tickets assigned to Golf Course Scorecard Data.")
    parser.add_argument("--team", default=DEFAULT_TEAM, help=f"Help Scout team/user name (default: {DEFAULT_TEAM}).")
    parser.add_argument("--team-id", type=int, help="Help Scout team/user ID; overrides --team.")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Number of qualifying image tickets to export (default: 200).")
    parser.add_argument("--out-dir", type=Path, default=Path.home() / "Desktop" / "helpscout-golf-course-scorecard-data-images", help="Export folder.")
    parser.add_argument("--pause-seconds", type=float, default=0.1, help="Delay between API requests (default: 0.1).")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit < 1:
        print("--limit must be at least 1.", file=sys.stderr)
        return 2
    client_id = os.environ.get("HELPSCOUT_CLIENT_ID")
    client_secret = os.environ.get("HELPSCOUT_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("Missing Help Scout credentials. Set HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET first.", file=sys.stderr)
        return 2
    client = HelpScoutClient(client_id, client_secret, args.pause_seconds)
    client.authenticate()
    team_id = args.team_id or resolve_team_id(client, args.team)
    output_path = args.out_dir.expanduser().resolve() / "tickets.csv"
    count = export_tickets(client, team_id, args.limit, output_path)
    print(f"Wrote {count} image-containing tickets to {output_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
