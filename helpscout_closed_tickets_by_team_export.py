#!/usr/bin/env python3
"""
Export recently closed Help Scout tickets for an explicit list of teams.

Help Scout's conversations endpoint does not support sortField=closedAt, so
this script requests closed tickets sorted by modifiedAt desc as the closest
available proxy for "most recently closed".

Only tickets with at least one non-empty agent response are exported.
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
from typing import List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


API_BASE = "https://api.helpscout.net/v2"
TOKEN_URL = f"{API_BASE}/oauth2/token"
MAX_RETRIES = 6
DEFAULT_LIMIT_PER_TEAM = 50
DEFAULT_SCAN_PER_TEAM = 500

TEAM_NAMES = [
    "10 Million User Campaign",
    "Account Management",
    "Add Golf Clubs",
    "Coach Connect",
    "Community",
    "Golf School",
    "In App Feedback",
    "Mark as Spam",
    "Messaging",
    "Meta Glasses",
    "Newsletter Unsub",
    "No Action Feedback",
    "Partnerships",
    "Player Stats",
    "Subscription Management",
    "Tournaments",
    "Unresolved Bugs",
    "Usability",
    "Watch Wear",
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
    if str(created_by.get("type") or "").lower() == "customer":
        return True
    return bool(thread.get("customer"))


def thread_text(thread: dict) -> str:
    raw = thread.get("body") or thread.get("plaintext") or thread.get("bodyPreview") or ""
    return strip_html(str(raw)).strip()


def collect_thread_texts(conversation: dict) -> tuple[str, str]:
    threads = conversation.get("_embedded", {}).get("threads", []) or []
    sorted_threads = sorted(threads, key=lambda item: item.get("createdAt") or "")
    customer_parts: List[str] = []
    agent_parts: List[str] = []

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
        else:
            agent_parts.append(body)

    return "\n\n---\n\n".join(customer_parts), "\n\n---\n\n".join(agent_parts)


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


def extract_tag_values(conversation: dict) -> tuple[str, str]:
    category_tags: List[str] = []
    subcategory_tags: List[str] = []

    for raw_tag in conversation.get("tags") or []:
        if isinstance(raw_tag, dict):
            tag = str(raw_tag.get("tag") or raw_tag.get("name") or "").strip()
        else:
            tag = str(raw_tag or "").strip()
        lower = tag.lower()
        if lower.startswith("category:"):
            category_tags.append(tag)
        elif lower.startswith("subcategory:"):
            subcategory_tags.append(tag)

    return " | ".join(category_tags), " | ".join(subcategory_tags)


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
            except (URLError, ConnectionResetError) as exc:
                if attempt < MAX_RETRIES:
                    wait_seconds = min(30, 2 ** attempt)
                    print(f"Retrying {url} after network error in {wait_seconds}s...", file=sys.stderr)
                    time.sleep(wait_seconds)
                    last_error = exc
                    continue
                raise RuntimeError(f"Could not reach Help Scout API at {url}: {exc}") from exc

        raise RuntimeError(f"Exceeded max retries for {url}: {last_error}")

    def list_users(self) -> List[dict]:
        users: List[dict] = []
        page = 1
        total_pages = 1

        while page <= total_pages:
            payload = self._request_json("/users", page=page, pageSize=100)
            users.extend(payload.get("_embedded", {}).get("users", []) or [])
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or 1
            render_progress("Loading teams ", page, total_pages)
            page += 1

        finish_progress()
        deduped = {int(user["id"]): user for user in users if user.get("id")}
        return list(deduped.values())

    def list_closed_conversations_for_user(self, assignee_id: int, scan_limit: int) -> List[dict]:
        results: List[dict] = []
        page = 1
        estimated_total_pages = max(1, (scan_limit + 99) // 100)

        while len(results) < scan_limit:
            payload = self._request_json(
                "/conversations",
                status="closed",
                assigned_to=assignee_id,
                page=page,
                pageSize=100,
                sortField="modifiedAt",
                sortOrder="desc",
            )
            conversations = payload.get("_embedded", {}).get("conversations", []) or []
            page_info = payload.get("page", {}) or {}
            total_pages = page_info.get("totalPages") or page_info.get("pages") or estimated_total_pages
            current_page = page_info.get("number") or page_info.get("page") or page

            for conversation in conversations:
                results.append(conversation)
                if len(results) >= scan_limit:
                    break

            render_progress("Loading tickets", min(current_page, total_pages), max(total_pages, estimated_total_pages))
            if current_page >= total_pages or not conversations:
                break
            page += 1

        finish_progress()
        return results[:scan_limit]

    def get_conversation(self, conversation_id: int) -> dict:
        return self._request_json(f"/conversations/{conversation_id}", embed="threads")


def user_display_name(user: dict) -> str:
    first = user.get("firstName") or user.get("first") or ""
    last = user.get("lastName") or user.get("last") or ""
    first_last = " ".join(part for part in [first, last] if part).strip()
    return str(user.get("name") or first_last or user.get("email") or f"User {user.get('id')}")


def select_team_users(all_users: List[dict]) -> tuple[List[dict], List[str]]:
    by_name: dict[str, dict] = {}
    for user in all_users:
        by_name.setdefault(normalize_name(user_display_name(user)), user)

    selected: List[dict] = []
    missing: List[str] = []
    for team_name in TEAM_NAMES:
        user = by_name.get(normalize_name(team_name))
        if user:
            selected.append(user)
        else:
            missing.append(team_name)

    return selected, missing


def write_csv(path: Path, rows: List[dict]) -> None:
    fieldnames = [
        "team_id",
        "team_name",
        "ticket_id",
        "helpscout_url",
        "created_at",
        "category_tag",
        "subcategory_tag",
        "customer_content",
        "agent_response",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def export_tickets(client: HelpScoutClient, out_dir: Path, limit_per_team: int, scan_per_team: int) -> int:
    all_users = client.list_users()
    team_users, missing_teams = select_team_users(all_users)

    if missing_teams:
        print("Could not find these team names in Help Scout:", file=sys.stderr)
        for name in missing_teams:
            print(f"  - {name}", file=sys.stderr)

    rows: List[dict] = []
    skipped_without_agent_response = 0
    total_teams = len(team_users)

    for team_index, user in enumerate(team_users, start=1):
        assignee_id = int(user["id"])
        assignee_name = user_display_name(user)
        print(f"Processing team {team_index}/{total_teams}: {assignee_name} ({assignee_id})", file=sys.stderr)

        summaries = client.list_closed_conversations_for_user(assignee_id, scan_per_team)
        total_summaries = len(summaries)
        exported_for_team = 0
        skipped_for_team = 0

        for ticket_index, summary in enumerate(summaries, start=1):
            if exported_for_team >= limit_per_team:
                break

            conversation_id = summary.get("id")
            if not conversation_id:
                render_progress(f"Details {assignee_name[:14]:<14}", ticket_index, total_summaries)
                continue

            full = client.get_conversation(int(conversation_id))
            if str(full.get("status") or "").lower() != "closed":
                render_progress(f"Details {assignee_name[:14]:<14}", ticket_index, total_summaries)
                continue

            category_tag, subcategory_tag = extract_tag_values(full)
            customer_content, agent_response = collect_thread_texts(full)
            if not agent_response.strip():
                skipped_without_agent_response += 1
                skipped_for_team += 1
                render_progress(f"Details {assignee_name[:14]:<14}", ticket_index, total_summaries)
                continue

            rows.append(
                {
                    "team_id": assignee_id,
                    "team_name": assignee_name,
                    "ticket_id": str(full.get("number") or full.get("id") or ""),
                    "helpscout_url": conversation_url(full),
                    "created_at": str(full.get("createdAt") or ""),
                    "category_tag": category_tag,
                    "subcategory_tag": subcategory_tag,
                    "customer_content": customer_content,
                    "agent_response": agent_response,
                }
            )
            exported_for_team += 1
            render_progress(f"Details {assignee_name[:14]:<14}", ticket_index, total_summaries)

        if total_summaries:
            finish_progress()
        print(
            f"Team result: inspected {min(total_summaries, ticket_index if total_summaries else 0)}, "
            f"exported {exported_for_team}, skipped no-agent-response {skipped_for_team}",
            file=sys.stderr,
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "tickets.csv", rows)
    print(f"Skipped {skipped_without_agent_response} tickets with no agent response.", file=sys.stderr)
    return len(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export recently closed Help Scout tickets for the configured team list."
    )
    parser.add_argument("--limit-per-team", type=int, default=DEFAULT_LIMIT_PER_TEAM, help="How many qualifying tickets to export per team.")
    parser.add_argument("--scan-per-team", type=int, default=DEFAULT_SCAN_PER_TEAM, help="How many recently closed tickets to inspect per team while looking for agent responses.")
    parser.add_argument("--out-dir", default="helpscout-closed-tickets-by-team-export", help="Directory to write output.")
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

    print("Using configured Help Scout team-name whitelist.", file=sys.stderr)
    print("Skipping Archive and Golf Course queue teams per request.", file=sys.stderr)
    print("Only exporting tickets that include at least one agent response.", file=sys.stderr)
    print("Using status=closed sorted by modifiedAt desc because Help Scout does not support closedAt sorting.", file=sys.stderr)

    out_dir = Path(args.out_dir).expanduser().resolve()
    client = HelpScoutClient(client_id=client_id, client_secret=client_secret, pause_seconds=args.pause_seconds)
    client.authenticate()
    count = export_tickets(
        client=client,
        out_dir=out_dir,
        limit_per_team=args.limit_per_team,
        scan_per_team=args.scan_per_team,
    )
    print(f"Wrote {count} rows to {out_dir / 'tickets.csv'}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
