#!/usr/bin/env python3
"""Safely send prepared course-match replies through Help Scout.

The script is intentionally a dry run unless one of the explicit send modes is
selected. It fetches each current conversation before sending, which means it
will never rely on a possibly stale email address from the source CSV.

Examples:
  # Inspect all rows without sending anything.
  python3 helpscout_send_course_match_replies.py

  # Send at most the first five currently eligible replies.
  python3 helpscout_send_course_match_replies.py --send-pilot --confirm-send

  # After reviewing the pilot results, send the remaining eligible replies.
  python3 helpscout_send_course_match_replies.py --send-all --confirm-send
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


API_BASE = "https://api.helpscout.net/v2"
TOKEN_URL = f"{API_BASE}/oauth2/token"
DEFAULT_INPUT = Path.home() / "Downloads" / "Existing Match Courses - Existing Matches.csv"
REQUIRED_COLUMNS = {"Ticket ID", "HelpScout Link"}
RESPONSE_COLUMNS = ("Reverified Customer Response Email", "Customer Response Email")
RESULT_COLUMNS = (
    "run_at",
    "mode",
    "row_number",
    "ticket_id",
    "conversation_id",
    "helpscout_link",
    "outcome",
    "reason",
    "thread_id",
    "reply_sha256",
    "customer_reference",
)
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
MAX_RETRIES = 6
PILOT_LIMIT = 5
LOW_REMAINING_THRESHOLD = 5
LOW_REMAINING_SLEEP_SECONDS = 5.0


class InputValidationError(RuntimeError):
    """Raised when the input CSV cannot be used safely."""


class ApiRequestError(RuntimeError):
    """A Help Scout response that could not be completed."""

    def __init__(self, status_code: Optional[int], message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class HTMLToText(HTMLParser):
    """Small HTML normalizer used to compare existing Help Scout replies."""

    BLOCK_TAGS = {"br", "div", "p", "li", "tr", "td", "th", "blockquote"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag.lower() in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return "".join(self.parts)


def normalize_text(value: str) -> str:
    """Normalize plain text or Help Scout HTML for exact-message comparison."""
    parser = HTMLToText()
    parser.feed(value or "")
    parser.close()
    text = unescape(parser.text()).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def reply_sha256(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def parse_conversation_id(helpscout_link: str) -> int:
    """Get Help Scout's internal conversation ID from a secure web URL."""
    parsed = urlparse((helpscout_link or "").strip())
    if parsed.scheme != "https" or parsed.netloc.lower() != "secure.helpscout.net":
        raise InputValidationError("HelpScout Link must be a secure.helpscout.net URL.")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 3 or parts[0] != "conversation" or not parts[1].isdigit() or not parts[2].isdigit():
        raise InputValidationError("HelpScout Link must look like https://secure.helpscout.net/conversation/<id>/<ticket>.")
    return int(parts[1])


def select_response(row: dict[str, str]) -> str:
    """Prefer the reverified response while retaining compatibility with older files."""
    for column in RESPONSE_COLUMNS:
        value = (row.get(column) or "").strip()
        if value:
            return value
    return ""


def is_published_support_reply(thread: dict[str, Any]) -> bool:
    """Return true only for a published outbound support reply, never a note/draft."""
    if str(thread.get("state") or "").lower() != "published":
        return False
    thread_type = str(thread.get("type") or "").lower()
    if thread_type in {"note", "customer", "chatline", "lineitem"}:
        return False
    if thread_type in {"reply", "forward"}:
        return True
    creator_type = str((thread.get("createdBy") or {}).get("type") or "").lower()
    return creator_type in {"user", "system_user"}


def thread_text(thread: dict[str, Any]) -> str:
    return str(thread.get("body") or thread.get("plaintext") or thread.get("bodyPreview") or "")


def support_reply_reason(threads: Iterable[dict[str, Any]], prepared_reply: str) -> Optional[str]:
    """Classify an existing support response, prioritizing idempotency detection."""
    support_threads = [thread for thread in threads if is_published_support_reply(thread)]
    expected = normalize_text(prepared_reply)
    for thread in support_threads:
        if normalize_text(thread_text(thread)) == expected:
            return "already_sent"
    return "agent_reply_present" if support_threads else None


def primary_customer_payload(conversation: dict[str, Any]) -> tuple[Optional[dict[str, Any]], str]:
    """Return the current primary customer in the API's accepted reply format."""
    embedded = conversation.get("_embedded") or {}
    customer = conversation.get("primaryCustomer") or embedded.get("primaryCustomer")
    if not isinstance(customer, dict):
        return None, ""
    customer_id = customer.get("id")
    if customer_id not in (None, ""):
        try:
            return {"id": int(customer_id)}, f"id:{int(customer_id)}"
        except (TypeError, ValueError):
            return None, ""
    email = str(customer.get("email") or "").strip()
    if email:
        # Do not put customer email addresses in the durable report.
        return {"email": email}, "email-sha256:" + hashlib.sha256(email.lower().encode("utf-8")).hexdigest()[:12]
    return None, ""


def default_report_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}_helpscout_reply_results.csv")


def load_input_rows(input_path: Path) -> list[dict[str, str]]:
    if not input_path.is_file():
        raise InputValidationError(f"Input CSV was not found: {input_path}")
    with input_path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        headers = set(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - headers
        if missing:
            raise InputValidationError(f"Input CSV is missing required column(s): {', '.join(sorted(missing))}")
        if not headers.intersection(RESPONSE_COLUMNS):
            raise InputValidationError(f"Input CSV needs one of: {', '.join(RESPONSE_COLUMNS)}")
        return [dict(row) for row in reader]


def load_previously_sent(report_path: Path) -> set[int]:
    if not report_path.is_file():
        return set()
    with report_path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        sent_ids: set[int] = set()
        for row in reader:
            if str(row.get("outcome") or "").lower() != "sent":
                continue
            try:
                sent_ids.add(int(str(row.get("conversation_id") or "").strip()))
            except ValueError:
                continue
        return sent_ids


class ResultWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a", newline="", encoding="utf-8")
        self.writer = csv.DictWriter(self.handle, fieldnames=RESULT_COLUMNS, extrasaction="ignore")
        if self.path.stat().st_size == 0:
            self.writer.writeheader()
            self.handle.flush()

    def write(self, record: dict[str, str]) -> None:
        self.writer.writerow(record)
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


class HelpScoutClient:
    def __init__(self, client_id: str, client_secret: str, pause_seconds: float = 0.15, sleep: Callable[[float], None] = time.sleep) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.pause_seconds = max(0.0, pause_seconds)
        self.sleep = sleep
        self.access_token: Optional[str] = None
        self.last_remaining_minute: Optional[int] = None

    def authenticate(self) -> None:
        data = urlencode({"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret}).encode("utf-8")
        payload, _ = self._request_json("POST", TOKEN_URL, data, {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, authenticated=False)
        token = str(payload.get("access_token") or "")
        if not token:
            raise ApiRequestError(None, "Help Scout OAuth response did not include an access token.")
        self.access_token = token

    def get_conversation(self, conversation_id: int) -> dict[str, Any]:
        payload, _ = self._request_json("GET", f"{API_BASE}/conversations/{conversation_id}?embed=threads")
        return payload

    def create_reply(self, conversation_id: int, customer: dict[str, Any], text: str) -> str:
        body = json.dumps({"customer": customer, "text": text, "status": "closed"}).encode("utf-8")
        _, headers = self._request_json("POST", f"{API_BASE}/conversations/{conversation_id}/reply", body, {"Content-Type": "application/json", "Accept": "application/json"})
        return str(headers.get("Resource-Id") or headers.get("Resource-ID") or "")

    def _respect_rate_headers(self, headers: Any) -> None:
        """Slow down before a burst reaches Help Scout's per-minute limit."""
        remaining = headers.get("X-RateLimit-Remaining-Minute") if headers else None
        if remaining is None:
            return
        try:
            self.last_remaining_minute = int(remaining)
        except (TypeError, ValueError):
            self.last_remaining_minute = None
            return
        if self.last_remaining_minute <= LOW_REMAINING_THRESHOLD:
            self.sleep(LOW_REMAINING_SLEEP_SECONDS)

    def _request_json(self, method: str, url: str, data: Optional[bytes] = None, extra_headers: Optional[dict[str, str]] = None, authenticated: bool = True) -> tuple[dict[str, Any], Any]:
        headers = dict(extra_headers or {})
        if authenticated:
            if not self.access_token:
                raise ApiRequestError(None, "Help Scout client is not authenticated.")
            headers["Authorization"] = f"Bearer {self.access_token}"
        request = Request(url, data=data, headers=headers, method=method)
        last_error: Optional[ApiRequestError] = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                with urlopen(request, timeout=60) as response:
                    raw = response.read().decode("utf-8")
                    payload = json.loads(raw) if raw else {}
                    self._respect_rate_headers(response.headers)
                    if self.pause_seconds:
                        self.sleep(self.pause_seconds)
                    return payload, response.headers
            except HTTPError as exc:
                error = ApiRequestError(exc.code, f"Help Scout API returned HTTP {exc.code} for {method} {url}.")
                if exc.code not in RETRYABLE_STATUS_CODES or attempt == MAX_RETRIES:
                    raise error from exc
                retry_after = exc.headers.get("Retry-After") or exc.headers.get("X-RateLimit-Retry-After")
                try:
                    delay = max(0.1, float(retry_after)) if retry_after is not None else min(30.0, float(2 ** attempt))
                except ValueError:
                    delay = min(30.0, float(2 ** attempt))
                last_error = error
                self.sleep(delay + 0.1)
            except (URLError, TimeoutError, ConnectionResetError) as exc:
                error = ApiRequestError(None, f"Could not reach Help Scout for {method} {url}.")
                if attempt == MAX_RETRIES:
                    raise error from exc
                last_error = error
                self.sleep(min(30.0, float(2 ** attempt)))
        raise last_error or ApiRequestError(None, "Help Scout request did not complete.")


@dataclass
class Candidate:
    row: dict[str, str]
    row_number: int
    conversation_id: int
    response: str
    customer: dict[str, Any]
    customer_reference: str


def record_for(row: dict[str, str], row_number: int, mode: str, outcome: str, reason: str, conversation_id: Optional[int] = None, response: str = "", thread_id: str = "", customer_reference: str = "") -> dict[str, str]:
    return {
        "run_at": datetime.now(UTC).isoformat(),
        "mode": mode,
        "row_number": str(row_number),
        "ticket_id": str(row.get("Ticket ID") or "").strip(),
        "conversation_id": str(conversation_id or ""),
        "helpscout_link": str(row.get("HelpScout Link") or "").strip(),
        "outcome": outcome,
        "reason": reason,
        "thread_id": thread_id,
        "reply_sha256": reply_sha256(response) if response else "",
        "customer_reference": customer_reference,
    }


def inspect_row(row: dict[str, str], row_number: int, mode: str, client: HelpScoutClient, previously_sent: set[int]) -> tuple[Optional[Candidate], dict[str, str]]:
    response = select_response(row)
    if not response:
        return None, record_for(row, row_number, mode, "skipped", "missing_response")
    try:
        conversation_id = parse_conversation_id(str(row.get("HelpScout Link") or ""))
    except InputValidationError:
        return None, record_for(row, row_number, mode, "skipped", "invalid_helpscout_link", response=response)
    if conversation_id in previously_sent:
        return None, record_for(row, row_number, mode, "skipped", "previously_sent", conversation_id, response)
    try:
        conversation = client.get_conversation(conversation_id)
    except ApiRequestError as exc:
        reason = "conversation_unavailable" if exc.status_code in {404, 410} else f"get_api_http_{exc.status_code or 'network'}"
        return None, record_for(row, row_number, mode, "skipped" if exc.status_code in {404, 410} else "failed", reason, conversation_id, response)
    threads = (conversation.get("_embedded") or {}).get("threads") or []
    if not isinstance(threads, list):
        threads = []
    existing_reason = support_reply_reason((thread for thread in threads if isinstance(thread, dict)), response)
    if existing_reason:
        return None, record_for(row, row_number, mode, "skipped", existing_reason, conversation_id, response)
    customer, customer_reference = primary_customer_payload(conversation)
    if not customer:
        return None, record_for(row, row_number, mode, "skipped", "missing_primary_customer", conversation_id, response)
    candidate = Candidate(row, row_number, conversation_id, response, customer, customer_reference)
    return candidate, record_for(row, row_number, mode, "eligible", "ready_to_send", conversation_id, response, customer_reference=customer_reference)


def send_candidate(candidate: Candidate, mode: str, client: HelpScoutClient) -> dict[str, str]:
    try:
        thread_id = client.create_reply(candidate.conversation_id, candidate.customer, candidate.response)
        return record_for(candidate.row, candidate.row_number, mode, "sent", "reply_sent_and_closed", candidate.conversation_id, candidate.response, thread_id, candidate.customer_reference)
    except ApiRequestError as exc:
        if exc.status_code in {404, 410}:
            outcome, reason = "skipped", "conversation_unavailable"
        elif exc.status_code == 412:
            outcome, reason = "skipped", "conversation_locked"
        else:
            outcome, reason = "failed", f"send_api_http_{exc.status_code or 'network'}"
        return record_for(candidate.row, candidate.row_number, mode, outcome, reason, candidate.conversation_id, candidate.response, customer_reference=candidate.customer_reference)


def render_progress(mode: str, completed: int, total: int, summary: dict[str, int], stream: Any = sys.stdout) -> None:
    """Render a compact, in-place batch progress bar without exposing customer data."""
    total = max(total, 1)
    width = 24
    filled = min(width, int(width * completed / total))
    outcomes = " ".join(f"{name}={summary[name]}" for name in sorted(summary))
    print(f"\r{mode}: [{'#' * filled}{'-' * (width - filled)}] {completed}/{total} {outcomes}", end="", file=stream, flush=True)


def run_rows(rows: list[dict[str, str]], client: HelpScoutClient, mode: str, writer: ResultWriter, previously_sent: set[int], progress: Optional[Callable[[int, int, dict[str, int]], None]] = None) -> dict[str, int]:
    """Inspect every row in dry-run/full modes; stop the pilot after five send attempts."""
    summary: dict[str, int] = {}
    seen_conversations: set[int] = set()
    send_attempts = 0
    processed = 0

    def save(record: dict[str, str]) -> None:
        nonlocal processed
        writer.write(record)
        summary[record["outcome"]] = summary.get(record["outcome"], 0) + 1
        processed += 1
        if progress:
            progress(processed, len(rows), summary)

    for row_number, row in enumerate(rows, start=2):
        response = select_response(row)
        try:
            input_conversation_id = parse_conversation_id(str(row.get("HelpScout Link") or ""))
        except InputValidationError:
            input_conversation_id = None
        if input_conversation_id is not None and input_conversation_id in seen_conversations:
            record = record_for(row, row_number, mode, "skipped", "duplicate_input_conversation", input_conversation_id, response)
            save(record)
            continue
        if input_conversation_id is not None:
            seen_conversations.add(input_conversation_id)

        candidate, record = inspect_row(row, row_number, mode, client, previously_sent)
        if candidate and mode != "dry-run":
            send_attempts += 1
            record = send_candidate(candidate, mode, client)
            if record["outcome"] == "sent":
                previously_sent.add(candidate.conversation_id)
        save(record)
        if mode == "pilot" and send_attempts >= PILOT_LIMIT:
            break
    return summary


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Safely send prepared course-match replies through Help Scout.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help=f"Source CSV (default: {DEFAULT_INPUT})")
    parser.add_argument("--report", type=Path, help="Append-only result CSV; defaults beside the input file.")
    parser.add_argument("--pause-seconds", type=float, default=0.15, help="Pause after successful API requests (default: 0.15).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--send-pilot", action="store_true", help=f"Send at most the first {PILOT_LIMIT} eligible replies.")
    mode.add_argument("--send-all", action="store_true", help="Send all eligible replies not already recorded as sent.")
    parser.add_argument("--confirm-send", action="store_true", help="Required together with a send mode.")
    args = parser.parse_args(argv)
    if args.confirm_send and not (args.send_pilot or args.send_all):
        parser.error("--confirm-send requires --send-pilot or --send-all.")
    if (args.send_pilot or args.send_all) and not args.confirm_send:
        parser.error("A send mode requires --confirm-send.")
    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    mode = "pilot" if args.send_pilot else "send-all" if args.send_all else "dry-run"
    try:
        rows = load_input_rows(args.input)
        report_path = args.report or default_report_path(args.input)
        client_id = os.environ.get("HELPSCOUT_CLIENT_ID") or os.environ.get("HELPSCOUT_APP_ID")
        client_secret = os.environ.get("HELPSCOUT_CLIENT_SECRET") or os.environ.get("HELPSCOUT_APP_SECRET")
        if not client_id or not client_secret:
            raise InputValidationError("Set HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET before running this script.")
        client = HelpScoutClient(client_id, client_secret, args.pause_seconds)
        client.authenticate()
        previously_sent = load_previously_sent(report_path)
        writer = ResultWriter(report_path)
        try:
            summary = run_rows(rows, client, mode, writer, previously_sent, lambda completed, total, counts: render_progress(mode, completed, total, counts))
        finally:
            writer.close()
    except (InputValidationError, ApiRequestError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print()
    total = sum(summary.values())
    counts = " ".join(f"{key}={summary[key]}" for key in sorted(summary))
    print(f"Completed {mode}: processed={total} {counts}")
    print(f"Results: {report_path}")
    if mode == "dry-run":
        print("No emails were sent. Use --send-pilot --confirm-send only after reviewing the report.")
    elif mode == "pilot":
        print(f"Pilot is capped at {PILOT_LIMIT} send attempts. Review the report before --send-all --confirm-send.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
