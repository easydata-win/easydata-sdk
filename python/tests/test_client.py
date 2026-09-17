"""The client against a real socket.

A fake HTTP server rather than a mocked urllib, because what is worth testing
here IS the transport: that a retried submit carries the same idempotency key,
that the cursor stops when the batch does, that a 4xx is not retried. Mocking
the layer under test would assert the mock.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from easydata_api import EasyData, InvalidRequest, RateLimited, webhooks  # noqa: E402
from easydata_api.errors import TransportError  # noqa: E402


class _Handler(BaseHTTPRequestHandler):
    """Replies from the script its server was given, and records what it saw."""

    def log_message(self, *args):  # noqa: D102 - silence the test output
        pass

    def _respond(self):
        script = self.server.script
        self.server.seen.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": dict(self.headers),
                "body": self._read_body(),
            }
        )
        status, body, headers = script.pop(0) if script else (200, {"data": {}, "meta": {}}, {})
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n)) if n else None

    do_GET = _respond
    do_POST = _respond


class ServerCase(unittest.TestCase):
    def serve(self, script):
        server = HTTPServer(("127.0.0.1", 0), _Handler)
        server.script = list(script)
        server.seen = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        host, port = server.server_address
        client = EasyData("pk_test_key", base_url=f"http://{host}:{port}")
        return client, server


def batch(**kw):
    d = {
        "batch_id": "b-1",
        "operation": "profiles.enrich",
        "status": "queued",
        "total": 1,
        "succeeded": 0,
        "failed": 0,
        "pending": 1,
        "results_available": 0,
        "credits_used": 0,
        "recommended_poll_ms": 1,
    }
    d.update(kw)
    return {"data": d, "meta": {"requestId": "req_1"}}


def results(entries, *, status="completed", cursor="", has_more=False):
    return {
        "data": {"batch_id": "b-1", "status": status, "entries": entries},
        "meta": {"nextCursor": cursor, "hasMore": has_more, "recommendedPollMs": 1},
    }


def entry(i, status="succeeded", **kw):
    d = {
        "item_index": i,
        "input": f"https://linkedin.com/in/p{i}",
        "status": status,
        "credits_used": 1,
        "data": {"full_name": f"Person {i}"},
        "created_at": "2026-09-01T10:00:00Z",
    }
    d.update(kw)
    return d


class TestSubmit(ServerCase):
    def test_a_submission_carries_an_idempotency_key(self):
        client, server = self.serve([(202, batch(), {})])
        client.profiles_enrich(["https://linkedin.com/in/x"])

        key = server.seen[0]["headers"].get("Idempotency-Key")
        self.assertTrue(key, "a submission must carry an Idempotency-Key")

    def test_a_retried_submit_reuses_the_same_key(self):
        """The whole reason the key is minted by the client and not the caller.

        Without it, our own retry of a submission that actually succeeded
        creates a second batch and bills for it.
        """
        client, server = self.serve([(500, {"error": {"type": "internal_error"}}, {}), (202, batch(), {})])
        client.profiles_enrich(["https://linkedin.com/in/x"])

        self.assertEqual(len(server.seen), 2, "the 500 should have been retried")
        first = server.seen[0]["headers"]["Idempotency-Key"]
        second = server.seen[1]["headers"]["Idempotency-Key"]
        self.assertEqual(first, second, "a retry sent a different key and would double-bill")

    def test_sync_refuses_a_sequence(self):
        client, _ = self.serve([])
        with self.assertRaises(ValueError):
            client.profiles_enrich.sync(["one", "two"])

    def test_sync_sends_target_not_targets(self):
        client, server = self.serve(
            [(200, {"data": {"batch_id": "b-1", "complete": True, "result": entry(0)}, "meta": {}}, {})]
        )
        out = client.profiles_enrich.sync("https://linkedin.com/in/x")

        self.assertIn("target", server.seen[0]["body"])
        self.assertNotIn("targets", server.seen[0]["body"])
        self.assertTrue(out.complete)
        self.assertEqual(out.result.data["full_name"], "Person 0")

    def test_an_empty_batch_never_reaches_the_wire(self):
        client, server = self.serve([])
        with self.assertRaises(ValueError):
            client.profiles_enrich([])
        self.assertEqual(server.seen, [])

    def test_false_is_sent_and_none_is_not(self):
        """`enrich=False` is the caller saying so; dropping it as falsy would
        send a different request than the one they wrote."""
        client, server = self.serve([(202, batch(), {})])
        client.profiles_enrich(["x"], enrich=False, external_id="run-7")

        body = server.seen[0]["body"]
        self.assertIs(body["enrich"], False)
        self.assertEqual(body["external_id"], "run-7")
        self.assertNotIn("find_emails", body)


class TestRetries(ServerCase):
    def test_429_is_retried_and_honours_retry_after(self):
        client, server = self.serve(
            [(429, {"error": {"type": "rate_limited"}}, {"Retry-After": "0"}), (202, batch(), {})]
        )
        started = time.monotonic()
        client.profiles_enrich(["x"])

        self.assertEqual(len(server.seen), 2)
        self.assertLess(time.monotonic() - started, 5, "Retry-After: 0 should not have slept")

    def test_a_4xx_is_not_retried(self):
        client, server = self.serve(
            [(400, {"error": {"type": "invalid_request", "message": "bad", "field": "targets"}}, {})]
        )
        with self.assertRaises(InvalidRequest) as ctx:
            client.profiles_enrich(["x"])

        self.assertEqual(len(server.seen), 1, "a refusal repeating cannot fix was retried")
        self.assertEqual(ctx.exception.field, "targets")
        self.assertEqual(ctx.exception.status, 400)

    def test_retries_are_finite(self):
        client, server = self.serve([(429, {"error": {"type": "rate_limited"}}, {"Retry-After": "0"})] * 8)
        client.max_retries = 2
        with self.assertRaises(RateLimited):
            client.profiles_enrich(["x"])
        self.assertEqual(len(server.seen), 3, "one attempt plus two retries")

    def test_an_unreachable_host_is_a_transport_error(self):
        client = EasyData("pk_test", base_url="http://127.0.0.1:1", max_retries=0)
        with self.assertRaises(TransportError):
            client.account()

    def test_rate_limits_are_read_off_every_response(self):
        client, _ = self.serve(
            [(202, batch(), {"X-RateLimit-Limit": "600", "X-RateLimit-Remaining": "599"})]
        )
        client.profiles_enrich(["x"])

        self.assertEqual(client.rate_limits.limit, 600)
        self.assertEqual(client.rate_limits.remaining, 599)
        # An absent ceiling is None, never 0: "no limit" is an ABSENT header,
        # and reading it as zero makes an unlimited account look blocked.
        self.assertIsNone(client.rate_limits.sync_limit)


class TestResultsCursor(ServerCase):
    def test_it_pages_until_hasmore_is_false(self):
        client, server = self.serve(
            [
                (200, results([entry(0)], status="processing", cursor="c1", has_more=True), {}),
                (200, results([entry(1)], status="completed", cursor="c2"), {}),
            ]
        )
        got = list(client.results("b-1"))

        self.assertEqual([e.item_index for e in got], [0, 1])
        self.assertIn("cursor=c1", server.seen[1]["path"])

    def test_it_keeps_waiting_while_the_batch_is_live(self):
        """Results stream: an empty read of a processing batch is not the end."""
        client, _ = self.serve(
            [
                (200, results([], status="processing"), {}),
                (200, results([entry(0)], status="processing"), {}),
                (200, results([entry(1)], status="completed"), {}),
            ]
        )
        got = list(client.results("b-1"))
        self.assertEqual([e.item_index for e in got], [0, 1])

    def test_wait_false_stops_at_what_is_readable_now(self):
        client, server = self.serve([(200, results([entry(0)], status="processing"), {})])
        got = list(client.results("b-1", wait=False))

        self.assertEqual(len(got), 1)
        self.assertEqual(len(server.seen), 1, "wait=False polled again")

    def test_a_failed_entry_is_yielded_with_its_error(self):
        client, _ = self.serve(
            [
                (
                    200,
                    results([entry(0, "failed", data=None, credits_used=0,
                                   error={"type": "unprocessable_target", "message": "no such profile"})]),
                    {},
                )
            ]
        )
        (got,) = list(client.results("b-1"))

        self.assertFalse(got.ok)
        self.assertEqual(got.credits_used, 0, "a failure costs nothing")
        self.assertEqual(got.error["type"], "unprocessable_target")

    def test_a_timeout_names_the_batch_that_is_still_readable(self):
        client, _ = self.serve([(200, results([], status="processing"), {})] * 50)
        with self.assertRaises(TimeoutError) as ctx:
            list(client.results("b-1", timeout=0.05))
        self.assertIn("b-1", str(ctx.exception))


class TestWebhookVerification(unittest.TestCase):
    SECRET = "whsec_test"

    def signed(self, body: bytes, ts: int | None = None):
        import hashlib
        import hmac

        ts = ts or int(time.time())
        mac = hmac.new(self.SECRET.encode(), f"{ts}.".encode() + body, hashlib.sha256)
        return {"X-EasyData-Signature": f"t={ts},v1={mac.hexdigest()}"}

    def test_a_good_signature_unpacks_the_delivery(self):
        body = json.dumps(
            {"id": "d-1", "event": "batch.completed", "createdAt": "2026-09-01T10:00:00Z",
             "data": {"batch_id": "b-1", "succeeded": 494}}
        ).encode()

        d = webhooks.verify(self.SECRET, self.signed(body), body)

        self.assertEqual(d.id, "d-1")
        self.assertEqual(d.event, "batch.completed")
        # The fields are in `data`, one level down. Reading the top level is the
        # quietest bug this API can hand you.
        self.assertEqual(d.data["succeeded"], 494)

    def test_a_tampered_body_fails(self):
        body = b'{"id":"d-1","event":"batch.completed","data":{}}'
        headers = self.signed(body)
        with self.assertRaises(webhooks.VerificationError):
            webhooks.verify(self.SECRET, headers, body + b" ")

    def test_a_stale_timestamp_fails(self):
        body = b'{"id":"d-1","event":"batch.completed","data":{}}'
        headers = self.signed(body, ts=int(time.time()) - 4000)
        with self.assertRaises(webhooks.VerificationError):
            webhooks.verify(self.SECRET, headers, body)

    def test_headers_are_case_insensitive(self):
        body = b'{"id":"d-1","event":"batch.result","data":{"result":{"status":"succeeded"}}}'
        headers = {k.lower(): v for k, v in self.signed(body).items()}

        d = webhooks.verify(self.SECRET, headers, body)
        self.assertEqual(d.data["result"]["status"], "succeeded")

    def test_the_go_signers_own_output_verifies(self):
        """A vector produced by backend/internal/webhooks.Sign itself.

        Every other test here signs with this file's own HMAC, which would keep
        passing if both sides were wrong in the same way. This one is the output
        of the server that will actually sign your deliveries, pinned - so a
        change to either implementation that breaks the other fails here rather
        than in a customer's receiver.

        Regenerate by calling Sign("whsec_cross_check", time.Unix(1789000000, 0),
        body) in a Go test.
        """
        body = (
            b'{"id":"d-1","event":"batch.result","createdAt":"2026-09-01T10:00:00Z",'
            b'"data":{"batch_id":"b-1"}}'
        )
        sig = "t=1789000000,v1=f58f4775db8b4ddd9a99b8a8ed28fc2ea6a58cc888a433526f244c5140e8022b"

        # tolerance=0 switches the freshness check off: the vector is fixed in
        # time and the thing under test is the digest.
        d = webhooks.verify("whsec_cross_check", {"X-EasyData-Signature": sig}, body, tolerance=0)

        self.assertEqual(d.event, "batch.result")
        self.assertEqual(d.data["batch_id"], "b-1")

    def test_ed25519_refuses_a_delivery_addressed_elsewhere(self):
        """One key signs for every customer, so wid is the whole check."""
        body = b"{}"
        headers = {"X-EasyData-Signature-Ed25519": f"t={int(time.time())},kid=k1,wid=other,v1b=AAAA"}
        with self.assertRaises(webhooks.VerificationError) as ctx:
            webhooks.verify_ed25519("AAAA", headers, body, webhook_id="mine")
        self.assertIn("other", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
