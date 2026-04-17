#!/usr/bin/env python3
from __future__ import annotations

import csv
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from html import unescape
from typing import Any, Dict, List, Optional

BASE_URL = "https://api.helpscout.net/v2"

TEAM_ID = 908054
TEAM_NAME = "No Action Feedback"
STATUS_FILTER = "active"
TARGET_STATUS = "closed"

APPLY_CHANGES = os.getenv("APPLY_CHANGES", "0") == "1"
TEST_LIMIT = int(os.getenv("TEST_LIMIT", "0"))
BASE_PAUSE_MS = int(os.getenv("BASE_PAUSE_MS", "250"))
LOW_REMAINING_THRESHOLD = int(os.getenv("LOW_REMAINING_THRESHOLD", "5"))
LOW_REMAINING_SLEEP_SEC = int(os.getenv("LOW_REMAINING_SLEEP_SEC", "15"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "8"))
MIN_CONFIDENCE_TO_CLOSE = float(os.getenv("MIN_CONFIDENCE_TO_CLOSE", "0.74"))
CSV_SAMPLE_LIMIT = int(os.getenv("CSV_SAMPLE_LIMIT", "50"))
SELF_TEST = os.getenv("SELF_TEST", "0") == "1"


def default_output_path() -> str:
    stamp = datetime.now().strftime("%Y-%m-%d")
    return f"helpscout_low_signal_examples_908054_{stamp}.csv"


OUTPUT_PATH = os.getenv("OUTPUT_PATH", default_output_path())

KEEP_PHRASES = (
    "too expensive",
    "expensive",
    "worth it",
    "make app better",
    "less is more",
    "personal coach",
)

KEEP_KEYWORDS = {
    "app",
    "price",
    "pricing",
    "expensive",
    "worth",
    "better",
    "problem",
    "issue",
    "cancel",
    "cancelled",
    "subscription",
    "watch",
    "gps",
    "distance",
    "disconnect",
    "feature",
    "bug",
    "coach",
    "handicap",
    "ghin",
    "slow",
    "crash",
    "support",
    "phone",
}

CLOSE_EXACT = {
    "good",
    "ok",
    "okay",
    "nice",
    "cool",
    "h",
    "k",
}

COMMON_WORDS = {
    "a", "an", "and", "app", "bad", "better", "but", "cancelled", "coach", "distance",
    "expensive", "for", "get", "ghin", "good", "gps", "handicap", "have", "how", "i",
    "in", "is", "issue", "it", "less", "like", "make", "more", "my", "not", "of",
    "on", "price", "problem", "slow", "so", "subscription", "the", "too", "use",
    "watch", "with", "worth", "why", "you", "your",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def sleep_sec(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def progress_bar(done: int, total: int, width: int = 24) -> str:
    total = max(total, 1)
    pct = min(done / total, 1.0)
    filled = int(round(width * pct))
    return "[" + ("#" * filled) + ("-" * (width - filled)) + f"] {round(pct * 100)}%"


class HelpScoutClient:
    def __init__(self, client_id: str, client_secret: str) -> None:
        try:
            import requests  # type: ignore
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "Missing Python dependency 'requests'. Install it before running this script."
            ) from exc

        self.client_id = client_id
        self.client_secret = client_secret
        self.access_token: Optional[str] = None
        self.api_calls = 0
        self.requests = requests
        self.session = requests.Session()
        self.last_remaining_minute: Optional[int] = None

    def authenticate(self) -> None:
        resp = self.session.post(
            f"{BASE_URL}/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
        if not resp.ok:
            raise RuntimeError(f"OAuth failed: HTTP {resp.status_code} {resp.text}")
        payload = resp.json()
        token = payload.get("access_token")
        if not token:
            raise RuntimeError(f"No access_token in OAuth response: {payload}")
        self.access_token = token

    def _headers(self) -> Dict[str, str]:
        if not self.access_token:
            raise RuntimeError("Client not authenticated")
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Accept": "application/json",
        }

    def _respect_rate_headers(self, resp: Any) -> None:
        remaining = resp.headers.get("X-RateLimit-Remaining-Minute")
        if remaining is not None:
            try:
                self.last_remaining_minute = int(remaining)
            except ValueError:
                self.last_remaining_minute = None

        if (
            self.last_remaining_minute is not None
            and self.last_remaining_minute <= LOW_REMAINING_THRESHOLD
        ):
            log(
                f"Rate limit getting low: remaining/minute={self.last_remaining_minute}. "
                f"Sleeping {LOW_REMAINING_SLEEP_SEC}s to avoid 429s."
            )
            sleep_sec(LOW_REMAINING_SLEEP_SEC)

    def get_json(self, url: str) -> Dict[str, Any]:
        if not self.access_token:
            raise RuntimeError("Client not authenticated")

        for attempt in range(1, MAX_RETRIES + 1):
            self.api_calls += 1
            resp = self.session.get(url, headers=self._headers(), timeout=60)

            if resp.status_code == 429:
                retry_after = resp.headers.get("X-RateLimit-Retry-After") or resp.headers.get("Retry-After")
                try:
                    wait_sec = int(retry_after) + 1 if retry_after is not None else min(60, 2 ** attempt)
                except ValueError:
                    wait_sec = min(60, 2 ** attempt)
                log(f"Hit 429 rate limit on GET attempt {attempt}/{MAX_RETRIES}. Sleeping {wait_sec}s, then retrying.")
                sleep_sec(wait_sec)
                continue

            if 500 <= resp.status_code < 600 and attempt < MAX_RETRIES:
                wait_sec = min(30, 2 ** attempt)
                log(f"Server error {resp.status_code} on GET attempt {attempt}/{MAX_RETRIES}. Sleeping {wait_sec}s, then retrying.")
                sleep_sec(wait_sec)
                continue

            if not resp.ok:
                raise RuntimeError(f"GET failed: HTTP {resp.status_code} {url}\n{resp.text[:1000]}")

            self._respect_rate_headers(resp)

            if BASE_PAUSE_MS > 0:
                sleep_sec(BASE_PAUSE_MS / 1000.0)

            return resp.json()

        raise RuntimeError(f"Exceeded max retries for {url}")

    def patch_json(self, url: str, patch_op: Dict[str, Any]) -> None:
        if not self.access_token:
            raise RuntimeError("Client not authenticated")

        for attempt in range(1, MAX_RETRIES + 1):
            self.api_calls += 1
            resp = self.session.patch(
                url,
                headers={**self._headers(), "Content-Type": "application/json"},
                json=patch_op,
                timeout=60,
            )

            if resp.status_code == 429:
                retry_after = resp.headers.get("X-RateLimit-Retry-After") or resp.headers.get("Retry-After")
                try:
                    wait_sec = int(retry_after) + 1 if retry_after is not None else min(60, 2 ** attempt)
                except ValueError:
                    wait_sec = min(60, 2 ** attempt)
                log(f"Hit 429 rate limit on PATCH attempt {attempt}/{MAX_RETRIES}. Sleeping {wait_sec}s, then retrying.")
                sleep_sec(wait_sec)
                continue

            if 500 <= resp.status_code < 600 and attempt < MAX_RETRIES:
                wait_sec = min(30, 2 ** attempt)
                log(f"Server error {resp.status_code} on PATCH attempt {attempt}/{MAX_RETRIES}. Sleeping {wait_sec}s, then retrying.")
                sleep_sec(wait_sec)
                continue

            if resp.status_code not in (200, 204):
                raise RuntimeError(f"PATCH failed: HTTP {resp.status_code} {url}\n{resp.text[:1000]}")

            self._respect_rate_headers(resp)

            if BASE_PAUSE_MS > 0:
                sleep_sec(BASE_PAUSE_MS / 1000.0)

            return

        raise RuntimeError(f"Exceeded max retries for {url}")

    def get_active_conversations_page(self, assignee_id: int, page: int) -> Dict[str, Any]:
        url = f"{BASE_URL}/conversations?status={STATUS_FILTER}&assigned_to={assignee_id}&page={page}"
        return self.get_json(url)

    def get_conversation_with_threads(self, conversation_id: int) -> Dict[str, Any]:
        url = f"{BASE_URL}/conversations/{conversation_id}?embed=threads"
        return self.get_json(url)

    def close_conversation(self, conversation_id: int) -> None:
        url = f"{BASE_URL}/conversations/{conversation_id}"
        patch_op = {
            "op": "replace",
            "path": "/status",
            "value": TARGET_STATUS,
        }
        self.patch_json(url, patch_op)


def strip_html(value: str) -> str:
    text = unescape(value or "")
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = text.replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def combine_relevant_text(conversation: Dict[str, Any]) -> str:
    parts: List[str] = []
    for key in ("subject", "preview"):
        if conversation.get(key):
            parts.append(strip_html(str(conversation[key])))

    threads = conversation.get("_embedded", {}).get("threads", []) or []
    for thread in threads:
        body = thread.get("body") or thread.get("bodyPreview") or thread.get("plaintext") or ""
        if body:
            parts.append(strip_html(str(body)))
    return "\n\n---\n\n".join(part for part in parts if part)


def extract_feedback_text(full_text: str) -> str:
    match = re.search(r"Feedback:\s*([\s\S]*)", full_text, re.I)
    if match:
        return clean_text(match.group(1))

    chunks = [clean_text(chunk) for chunk in re.split(r"\n\s*---\s*\n", full_text) if clean_text(chunk)]
    if chunks:
        return max(chunks, key=len)
    return clean_text(full_text)


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = strip_html(str(value))
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_for_tokens(text: str) -> str:
    text = text.lower().replace("\r", "\n")
    text = re.sub(r"[^\w\s']", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def alpha_ratio(text: str) -> float:
    if not text:
        return 0.0
    alpha = sum(1 for ch in text if ch.isalpha())
    visible = sum(1 for ch in text if not ch.isspace())
    return alpha / visible if visible else 0.0


def repeated_char_ratio(text: str) -> float:
    chars = [ch.lower() for ch in text if ch.isalpha()]
    if len(chars) < 3:
        return 0.0
    repeated = sum(1 for idx in range(1, len(chars)) if chars[idx] == chars[idx - 1])
    return repeated / len(chars)


def non_ascii_ratio(text: str) -> float:
    visible = [ch for ch in text if not ch.isspace()]
    if not visible:
        return 0.0
    non_ascii = sum(1 for ch in visible if ord(ch) > 127)
    return non_ascii / len(visible)


@dataclass
class Classification:
    decision: str
    reason: str
    confidence: float


def classify_feedback(feedback: str) -> Classification:
    cleaned = clean_text(feedback)
    lowered = cleaned.lower()
    normalized = normalize_for_tokens(cleaned)
    tokens = normalized.split() if normalized else []
    unique_tokens = set(tokens)
    char_count = len(cleaned)
    line_count = len([line for line in cleaned.splitlines() if line.strip()])
    alpha = alpha_ratio(cleaned)
    repeat_ratio = repeated_char_ratio(cleaned)
    non_ascii = non_ascii_ratio(cleaned)
    keyword_hits = sorted(word for word in KEEP_KEYWORDS if word in unique_tokens)
    common_hits = sum(1 for word in tokens if word in COMMON_WORDS)
    coverage = common_hits / len(tokens) if tokens else 0.0

    if not cleaned:
        return Classification("close", "empty feedback", 0.99)

    if any(phrase in lowered for phrase in KEEP_PHRASES):
        return Classification("keep", "matched meaningful keep phrase", 0.98)

    if non_ascii >= 0.25:
        return Classification("keep", "non-english or hard-to-parse text kept for manual review", 0.96)

    if line_count >= 3:
        return Classification("keep", "multi-line detailed feedback", 0.95)

    if re.search(r"\b\d+\.", cleaned):
        return Classification("keep", "structured list feedback", 0.95)

    if len(keyword_hits) >= 2:
        return Classification("keep", "multiple product-context keywords detected", 0.92)

    if len(tokens) >= 8 and (coverage >= 0.45 or len(keyword_hits) >= 1):
        return Classification("keep", "sentence-length feedback with product signal", 0.87)

    if re.search(r"\b(too|very|so|really)\s+\w+", lowered) and len(tokens) >= 2:
        return Classification("keep", "short sentiment phrase with clear stance", 0.85)

    if re.search(r"\b(make|fix|add|remove|improve|improved|better|worse)\b", lowered):
        return Classification("keep", "request or quality judgment detected", 0.9)

    if re.search(r"\b(problem|issue|bug|watch|gps|price|pricing|subscription|cancel|handicap|ghin)\b", lowered):
        return Classification("keep", "specific issue or topic detected", 0.9)

    if lowered in CLOSE_EXACT:
        return Classification("close", "generic one-word low-signal feedback", 0.96)

    if char_count <= 1:
        return Classification("close", "single-character feedback", 0.99)

    if len(tokens) <= 1 and char_count <= 6:
        return Classification("close", "extremely short low-signal feedback", 0.97)

    if len(tokens) <= 2 and char_count <= 4:
        return Classification("close", "very short fragment", 0.95)

    if len(tokens) <= 2 and coverage < 0.34 and alpha >= 0.7:
        return Classification("close", "very short text without clear meaning", 0.89)

    if len(tokens) >= 4 and coverage < 0.2 and len(keyword_hits) == 0 and non_ascii < 0.25:
        return Classification("close", "gibberish-like text with weak word coverage", 0.88)

    if repeat_ratio > 0.45 and len(tokens) <= 3:
        return Classification("close", "repetitive low-signal text", 0.9)

    if alpha < 0.45 and len(keyword_hits) == 0:
        return Classification("close", "noise-heavy text without product context", 0.84)

    if len(tokens) <= 3 and len(keyword_hits) == 0:
        return Classification("close", "short feedback without product meaning", 0.76)

    return Classification("keep", "uncertain classification kept for manual review", 0.6)


def tags_as_text(conversation: Dict[str, Any]) -> str:
    raw_tags = conversation.get("tags") or []
    names: List[str] = []
    for tag in raw_tags:
        if isinstance(tag, dict):
            value = tag.get("tag") or tag.get("name")
            if value:
                names.append(str(value))
    return ", ".join(names)


def write_close_sample_csv(rows: List[Dict[str, Any]], output_path: str) -> None:
    fieldnames = [
        "conversationId",
        "conversationNumber",
        "subject",
        "tags",
        "url",
        "feedback",
        "decision",
        "reason",
        "confidence",
    ]

    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows[:CSV_SAMPLE_LIMIT]:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def build_close_row(full: Dict[str, Any], feedback: str, classification: Classification) -> Dict[str, Any]:
    return {
        "conversationId": full.get("id"),
        "conversationNumber": full.get("number"),
        "subject": clean_text(full.get("subject") or ""),
        "tags": tags_as_text(full),
        "url": ((full.get("_links") or {}).get("web") or {}).get("href", ""),
        "feedback": feedback,
        "decision": classification.decision,
        "reason": classification.reason,
        "confidence": f"{classification.confidence:.2f}",
    }


def run_self_test() -> int:
    keep_cases = [
        "Too expensive",
        "Make app better",
        "less is more",
        "In order to keep a handicap,\nI use GHIN",
        (
            "Hi , I purchased the full package on trial , I don't have an issue with the price.\n"
            "My biggest problem and why I've cancelled my subscription is the very poor interaction "
            "with my new latest addition ultra watch.\n1. Watch keeps turning off\n2. Disconnects from app"
        ),
    ]
    close_cases = [
        "I'm 75 yummy",
        "The",
        "good",
        "H",
        "She as Mo n B m",
    ]

    failures: List[str] = []

    for text in keep_cases:
        result = classify_feedback(text)
        if result.decision != "keep":
            failures.append(f"Expected keep, got {result.decision}: {text!r} ({result.reason})")

    for text in close_cases:
        result = classify_feedback(text)
        if result.decision != "close":
            failures.append(f"Expected close, got {result.decision}: {text!r} ({result.reason})")

    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    log("Self-test passed")
    return 0


def main() -> int:
    if SELF_TEST:
        return run_self_test()

    client_id = os.getenv("HELPSCOUT_CLIENT_ID")
    client_secret = os.getenv("HELPSCOUT_CLIENT_SECRET")

    if not client_id or not client_secret:
        print("Missing HELPSCOUT_CLIENT_ID or HELPSCOUT_CLIENT_SECRET", file=sys.stderr)
        return 2

    started = time.time()
    client = HelpScoutClient(client_id, client_secret)
    dry_run_target = CSV_SAMPLE_LIMIT if not APPLY_CHANGES else 0

    mode = "APPLY" if APPLY_CHANGES else "DRY RUN"
    log(f"Starting Help Scout low-signal closer ({mode})")
    log(f"Scope: active tickets assigned to {TEAM_ID} ({TEAM_NAME})")
    log("Rule: close only tickets with clearly low-signal or gibberish feedback; otherwise keep active.")
    log(f"Minimum confidence to close: {MIN_CONFIDENCE_TO_CLOSE:.2f}")
    if not APPLY_CHANGES:
        log(f"Dry run will stop as soon as it finds {dry_run_target} closable tickets for the CSV sample.")
    if APPLY_CHANGES and TEST_LIMIT > 0:
        log(f"TEST LIMIT enabled: stop scanning once {TEST_LIMIT} closable tickets are found.")
    if not APPLY_CHANGES:
        log(f"Dry run CSV sample path: {OUTPUT_PATH} (up to first {CSV_SAMPLE_LIMIT} closable tickets)")
    log("This script WILL modify Help Scout only when APPLY_CHANGES=1.")
    client.authenticate()
    log("Authenticated successfully")

    to_close: List[Dict[str, Any]] = []
    keep_open = 0
    errors = 0
    scanned = 0

    page = 1
    total_pages = 1
    stop_early = False

    while page <= total_pages and not stop_early:
        payload = client.get_active_conversations_page(TEAM_ID, page)
        conversations = payload.get("_embedded", {}).get("conversations", [])
        page_info = payload.get("page", {})
        total_pages = int(page_info.get("totalPages", total_pages or 1))

        extra = ""
        if client.last_remaining_minute is not None:
            extra = f" | remaining/min={client.last_remaining_minute}"

        log(
            f"Fetched page {page}/{max(total_pages,1)} | conversations on page={len(conversations)} "
            f"| scanned so far={scanned} | closable found={len(to_close)}{extra}"
        )

        for convo in conversations:
            convo_id = convo.get("id")
            if convo_id is None:
                continue

            try:
                full = client.get_conversation_with_threads(convo_id)
                scanned += 1
                body_text = combine_relevant_text(full)
                feedback = extract_feedback_text(body_text)
                classification = classify_feedback(feedback)

                if (
                    classification.decision == "close"
                    and classification.confidence >= MIN_CONFIDENCE_TO_CLOSE
                ):
                    to_close.append(build_close_row(full, feedback, classification))
                else:
                    keep_open += 1

                if scanned % 25 == 0:
                    extra = ""
                    if client.last_remaining_minute is not None:
                        extra = f" | remaining/min={client.last_remaining_minute}"
                    log(
                        f"Scanning bodies {scanned} scanned | matches to close={len(to_close)} "
                        f"| keep open={keep_open}{extra}"
                    )

                if not APPLY_CHANGES and dry_run_target > 0 and len(to_close) >= dry_run_target:
                    stop_early = True
                    log(
                        f"Dry run sample target reached: found {len(to_close)} closable tickets. "
                        "Stopping early and writing CSV sample."
                    )
                    break

                if APPLY_CHANGES and TEST_LIMIT > 0 and len(to_close) >= TEST_LIMIT:
                    stop_early = True
                    log(f"TEST LIMIT reached: found {len(to_close)} closable tickets. Stopping early.")
                    break

            except Exception as e:
                errors += 1
                log(f"Skipped conversation {convo_id}: {e}")

        page += 1

    log("")
    log(f"Tickets to close before limit trim: {len(to_close)}")
    log(f"Tickets kept active: {keep_open}")
    log(f"Conversations scanned: {scanned}")
    log(f"Errors while scanning: {errors}")

    if APPLY_CHANGES and TEST_LIMIT > 0:
        to_close = to_close[:TEST_LIMIT]
        log(f"TEST LIMIT enabled: only the first {len(to_close)} matching tickets will be changed.")

    if not APPLY_CHANGES:
        write_close_sample_csv(to_close, OUTPUT_PATH)
        log(f"Wrote dry run CSV sample: {OUTPUT_PATH}")

    if to_close:
        for row in to_close[:50]:
            log(
                f"- #{row['conversationNumber']} | id={row['conversationId']} | "
                f"{str(row['subject'])[:90]} | {row['reason']} | {row['url']}"
            )
        if len(to_close) > 50:
            log(f"...and {len(to_close) - 50} more")

    log("")
    if not APPLY_CHANGES:
        log("DRY RUN ONLY: no changes were made.")
        log("To preview only 5 matching tickets, run:")
        log("  TEST_LIMIT=5 python3 helpscout_close_low_signal_908054.py")
        log("To actually close only 5 matching tickets, run:")
        log("  TEST_LIMIT=5 APPLY_CHANGES=1 python3 helpscout_close_low_signal_908054.py")
        log("To actually close all matching tickets, run:")
        log("  APPLY_CHANGES=1 python3 helpscout_close_low_signal_908054.py")
        return 0

    success = 0
    failures = 0

    for idx, row in enumerate(to_close, start=1):
        cid = int(row["conversationId"])
        try:
            client.close_conversation(cid)
            success += 1
            extra = ""
            if client.last_remaining_minute is not None:
                extra = f" | remaining/min={client.last_remaining_minute}"
            log(
                f"Closed {progress_bar(idx, len(to_close))} {idx}/{len(to_close)} "
                f"| conversation {cid}{extra}"
            )
        except Exception as e:
            failures += 1
            log(f"FAILED conversation {cid}: {e}")

    elapsed = round(time.time() - started)
    log("")
    log("Done")
    log(f"Closed: {success}")
    log(f"Failures: {failures}")
    log(f"API calls: {client.api_calls}")
    log(f"Elapsed seconds: {elapsed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
