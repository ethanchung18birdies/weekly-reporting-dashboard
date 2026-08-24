import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import helpscout_send_course_match_replies as sender


def sample_row(**overrides):
    row = {
        "Ticket ID": "337240",
        "HelpScout Link": "https://secure.helpscout.net/conversation/3416752037/337240",
        "Customer Response Email": "Original reply",
        "Reverified Customer Response Email": "Verified reply",
    }
    row.update(overrides)
    return row


def conversation(customer=None, threads=None):
    data = {"_embedded": {"threads": threads or []}}
    if customer is not None:
        data["primaryCustomer"] = customer
    return data


class FakeClient:
    def __init__(self, result):
        self.result = result
        self.sent = []

    def get_conversation(self, conversation_id):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def create_reply(self, conversation_id, customer, text):
        self.sent.append((conversation_id, customer, text))
        return "1234"


class SenderTests(unittest.TestCase):
    def test_parses_internal_id_from_help_scout_link(self):
        self.assertEqual(sender.parse_conversation_id(sample_row()["HelpScout Link"]), 3416752037)
        with self.assertRaises(sender.InputValidationError):
            sender.parse_conversation_id("https://example.com/conversation/1/2")

    def test_reverified_response_wins_and_original_is_fallback(self):
        self.assertEqual(sender.select_response(sample_row()), "Verified reply")
        self.assertEqual(sender.select_response(sample_row(**{"Reverified Customer Response Email": ""})), "Original reply")

    def test_published_support_reply_ignores_notes_and_drafts(self):
        self.assertFalse(sender.is_published_support_reply({"type": "note", "state": "published"}))
        self.assertFalse(sender.is_published_support_reply({"type": "reply", "state": "draft"}))
        self.assertTrue(sender.is_published_support_reply({"type": "reply", "state": "published"}))
        self.assertEqual(sender.support_reply_reason([{"type": "reply", "state": "published", "body": "Verified reply"}], "Verified reply"), "already_sent")

    def test_inspection_uses_primary_customer_and_send_closes(self):
        client = FakeClient(conversation({"id": 91, "email": "customer@example.com"}))
        candidate, record = sender.inspect_row(sample_row(), 2, "pilot", client, set())
        self.assertEqual(record["outcome"], "eligible")
        self.assertEqual(candidate.customer, {"id": 91})
        sent = sender.send_candidate(candidate, "pilot", client)
        self.assertEqual(sent["outcome"], "sent")
        self.assertEqual(client.sent, [(3416752037, {"id": 91}, "Verified reply")])

    def test_missing_customer_and_existing_agent_reply_are_skipped(self):
        missing = FakeClient(conversation())
        _, record = sender.inspect_row(sample_row(), 2, "dry-run", missing, set())
        self.assertEqual(record["reason"], "missing_primary_customer")
        replied = FakeClient(conversation({"id": 1}, [{"type": "reply", "state": "published", "body": "Different response"}]))
        _, record = sender.inspect_row(sample_row(), 2, "dry-run", replied, set())
        self.assertEqual(record["reason"], "agent_reply_present")

    def test_missing_and_locked_conversations_are_flagged(self):
        missing = FakeClient(sender.ApiRequestError(404, "not found"))
        _, record = sender.inspect_row(sample_row(), 2, "dry-run", missing, set())
        self.assertEqual((record["outcome"], record["reason"]), ("skipped", "conversation_unavailable"))
        locked = FakeClient(conversation({"id": 1}))
        locked.create_reply = lambda *args: (_ for _ in ()).throw(sender.ApiRequestError(412, "locked"))
        candidate, _ = sender.inspect_row(sample_row(), 2, "pilot", locked, set())
        record = sender.send_candidate(candidate, "pilot", locked)
        self.assertEqual((record["outcome"], record["reason"]), ("skipped", "conversation_locked"))

    def test_previously_sent_conversation_is_not_retried(self):
        client = FakeClient(conversation({"id": 1}))
        _, record = sender.inspect_row(sample_row(), 2, "send-all", client, {3416752037})
        self.assertEqual(record["reason"], "previously_sent")

    def test_csv_validation_and_sent_log_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.csv"
            path.write_text("Ticket ID,HelpScout Link\n1,https://secure.helpscout.net/conversation/1/1\n", encoding="utf-8")
            with self.assertRaises(sender.InputValidationError):
                sender.load_input_rows(path)
            report = Path(directory) / "results.csv"
            with report.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=sender.RESULT_COLUMNS)
                writer.writeheader()
                writer.writerow({"conversation_id": "42", "outcome": "sent"})
            self.assertEqual(sender.load_previously_sent(report), {42})

    def test_rate_limit_response_retries(self):
        response = type("Response", (), {"headers": {}, "read": lambda self: json.dumps({"ok": True}).encode(), "__enter__": lambda self: self, "__exit__": lambda self, *args: None})()
        rate_limited = HTTPError("https://example.test", 429, "rate limit", {"Retry-After": "0"}, io.BytesIO(b"{}"))
        client = sender.HelpScoutClient("id", "secret", pause_seconds=0, sleep=lambda _: None)
        client.access_token = "token"
        with patch("helpscout_send_course_match_replies.urlopen", side_effect=[rate_limited, response]) as open_mock:
            payload, _ = client._request_json("GET", "https://example.test")
        self.assertEqual(payload, {"ok": True})
        self.assertEqual(open_mock.call_count, 2)

    def test_low_remaining_rate_header_pauses_proactively(self):
        pauses = []
        client = sender.HelpScoutClient("id", "secret", sleep=pauses.append)
        client._respect_rate_headers({"X-RateLimit-Remaining-Minute": "5"})
        self.assertEqual(client.last_remaining_minute, 5)
        self.assertEqual(pauses, [sender.LOW_REMAINING_SLEEP_SECONDS])

    def test_progress_bar_reports_completed_work_without_customer_details(self):
        stream = io.StringIO()
        sender.render_progress("dry-run", 2, 5, {"eligible": 1, "skipped": 1}, stream)
        self.assertIn("dry-run: [#########---------------] 2/5 eligible=1 skipped=1", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
