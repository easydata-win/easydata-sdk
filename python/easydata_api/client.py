"""The EasyData client.

Zero dependencies, on purpose. It is one HTTP call shape against one envelope,
and a data-enrichment script is the last place anyone wants a transitive
dependency tree - so this is `urllib` and nothing else. Ed25519 webhook
verification is the single exception and is an optional extra; the HMAC scheme
is in the standard library and always available.
"""

from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterator, Mapping, Sequence

from .errors import EasyDataError, RateLimited, TransportError, error_for

__all__ = [
    "EasyData",
    "Batch",
    "ResultEntry",
    "ResultsPage",
    "SyncResult",
    "RateLimits",
    "OPERATIONS",
]

DEFAULT_BASE_URL = "https://api.easydata.win/v1"

#: Every operation, as `attribute name -> path`. The client builds one method
#: per entry rather than defining ten near-identical methods, because they ARE
#: identical: one request shape, one response shape, and the operation is the
#: path. A new operation is a row here.
OPERATIONS: dict[str, str] = {
    "profiles_enrich": "/profiles/enrich",
    "profiles_activity": "/profiles/activity",
    "profiles_posts": "/profiles/posts",
    "profiles_comments": "/profiles/comments",
    "profiles_reactions": "/profiles/reactions",
    "companies_enrich": "/companies/enrich",
    "posts_enrich": "/posts/enrich",
    "sales_search_people": "/sales/search/people",
    "sales_search_employees": "/sales/search/employees",
    "sales_search_companies": "/sales/search/companies",
}

# Statuses a batch can hold that mean it is still going to produce something.
_LIVE = ("queued", "processing")


@dataclass
class RateLimits:
    """The ceilings, read off the response headers of the last call.

    Every field is None when the deployment publishes no ceiling for it, which
    is what "no limit" looks like on the wire: an ABSENT header, never a zero.
    Treating a missing header as 0 would make an unlimited account look
    completely blocked.
    """

    limit: int | None = None
    remaining: int | None = None
    reset: int | None = None
    concurrent_batch_limit: int | None = None
    concurrent_batch_remaining: int | None = None
    sync_limit: int | None = None
    sync_remaining: int | None = None
    sync_reset: int | None = None
    sync_concurrent_limit: int | None = None
    sync_concurrent_remaining: int | None = None

    @classmethod
    def from_headers(cls, headers: Mapping[str, str]) -> "RateLimits":
        def num(name: str) -> int | None:
            raw = headers.get(name)
            if raw is None:
                return None
            try:
                return int(raw)
            except (TypeError, ValueError):
                return None

        return cls(
            limit=num("X-RateLimit-Limit"),
            remaining=num("X-RateLimit-Remaining"),
            reset=num("X-RateLimit-Reset"),
            concurrent_batch_limit=num("X-Concurrent-Batch-Limit"),
            concurrent_batch_remaining=num("X-Concurrent-Batch-Remaining"),
            sync_limit=num("X-Sync-Limit"),
            sync_remaining=num("X-Sync-Remaining"),
            sync_reset=num("X-Sync-Reset"),
            sync_concurrent_limit=num("X-Sync-Concurrent-Limit"),
            sync_concurrent_remaining=num("X-Sync-Concurrent-Remaining"),
        )


@dataclass
class ResultEntry:
    """One row of a batch's results, as the cursor returns it.

    `raw` is the whole entry as JSON. The named fields are the ones every
    operation has; `data` is the record itself and its shape is the
    operation's.
    """

    item_index: int
    input: Any
    status: str
    credits_used: float
    data: Any | None = None
    error: Mapping[str, Any] | None = None
    page: int | None = None
    created_at: str = ""
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "ResultEntry":
        return cls(
            item_index=int(d.get("item_index", 0)),
            input=d.get("input"),
            status=str(d.get("status", "")),
            credits_used=float(d.get("credits_used", 0) or 0),
            data=d.get("data"),
            error=d.get("error"),
            page=d.get("page"),
            created_at=str(d.get("created_at", "")),
            raw=d,
        )


@dataclass
class Batch:
    """A submission and its progress."""

    batch_id: str
    operation: str
    status: str
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    pending: int = 0
    results_available: int = 0
    credits_used: float = 0.0
    external_id: str = ""
    created_at: str = ""
    completed_at: str | None = None
    recommended_poll_ms: int = 2000
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def done(self) -> bool:
        """True once the batch will produce nothing further."""
        return self.status not in _LIVE

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "Batch":
        return cls(
            batch_id=str(d.get("batch_id", "")),
            operation=str(d.get("operation", "")),
            status=str(d.get("status", "")),
            total=int(d.get("total", 0) or 0),
            succeeded=int(d.get("succeeded", 0) or 0),
            failed=int(d.get("failed", 0) or 0),
            pending=int(d.get("pending", 0) or 0),
            results_available=int(d.get("results_available", 0) or 0),
            credits_used=float(d.get("credits_used", 0) or 0),
            external_id=str(d.get("external_id", "") or ""),
            created_at=str(d.get("created_at", "") or ""),
            completed_at=d.get("completed_at"),
            recommended_poll_ms=int(d.get("recommended_poll_ms", 2000) or 2000),
            raw=d,
        )


@dataclass
class SyncResult:
    """What a `/sync` call answers with: one batch, one entry.

    `complete` is the field to branch on. A synchronous request that ran out of
    deadline hands back what landed and leaves the target queued at priority -
    so `complete` is False, `result` may be None, and `batch_id` is still a real
    batch you can read later. It is never a timeout you have to parse, and
    nothing already paid for is lost.
    """

    batch_id: str
    operation: str
    status: str
    complete: bool
    result: ResultEntry | None
    credits_used: float = 0.0
    raw: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "SyncResult":
        entry = d.get("result")
        return cls(
            batch_id=str(d.get("batch_id", "")),
            operation=str(d.get("operation", "")),
            status=str(d.get("status", "")),
            complete=bool(d.get("complete", False)),
            result=ResultEntry.from_json(entry) if isinstance(entry, Mapping) else None,
            credits_used=float(d.get("credits_used", 0) or 0),
            raw=d,
        )


@dataclass
class ResultsPage:
    """One read of the results cursor.

    `recommended_poll_ms` is the server's own number and is 0 once the batch is
    terminal, which is the signal that there is nothing left to wait for.
    """

    status: str
    entries: list[ResultEntry]
    next_cursor: str
    has_more: bool
    recommended_poll_ms: int = 0

    @property
    def still_running(self) -> bool:
        return self.status in _LIVE


class _Operation:
    """One operation, callable three ways.

    `ed.profiles_enrich(targets)` submits a batch, `.sync(target)` does the
    blocking single lookup, and `.collect(targets)` submits and drains. They are
    the same operation, which is why they are one object rather than three
    method names that have to be kept in step.
    """

    def __init__(self, client: "EasyData", path: str) -> None:
        self._client = client
        self._path = path

    def __call__(self, targets: Sequence[Any], **kwargs: Any) -> Batch:
        return self._client.submit(self._path, targets, **kwargs)

    def sync(self, target: Any, **kwargs: Any) -> SyncResult:
        return self._client.submit_sync(self._path, target, **kwargs)

    def collect(self, targets: Sequence[Any], **kwargs: Any) -> list[ResultEntry]:
        """Submit and return every entry, blocking until the batch is done."""
        timeout = kwargs.pop("timeout", None)
        batch = self(targets, **kwargs)
        return list(self._client.results(batch.batch_id, timeout=timeout))


class EasyData:
    """The client.

    >>> ed = EasyData()                     # reads EASYDATA_API_KEY
    >>> r = ed.profiles_enrich.sync("https://linkedin.com/in/satyanadella")
    >>> r.result.data["full_name"]

    Retries are on by default and cover exactly the failures that are safe to
    repeat: 429, 5xx and a transport error. Submissions carry an
    `Idempotency-Key` so that repeating one is free - a retried submit resolves
    to the batch the first attempt created rather than creating a second one and
    charging for it twice.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = 120.0,
        max_retries: int = 3,
        user_agent: str = "easydata-python/1.0",
    ) -> None:
        key = api_key or os.environ.get("EASYDATA_API_KEY", "")
        if not key:
            raise ValueError(
                "no API key: pass api_key= or set EASYDATA_API_KEY in the environment"
            )
        self.api_key = key
        self.base_url = (base_url or os.environ.get("EASYDATA_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent

        #: The ceilings from the most recent response. Updated on every call,
        #: including a failed one - a 429 is where they matter most.
        self.rate_limits = RateLimits()

        for attr, path in OPERATIONS.items():
            setattr(self, attr, _Operation(self, path))

    # ---------------------------------------------------------------- submit

    def submit(
        self,
        path: str,
        targets: Sequence[Any],
        *,
        external_id: str | None = None,
        callback_url: str | None = None,
        webhook_tag: str | None = None,
        max_results: int | None = None,
        enrich: bool | None = None,
        find_emails: bool | None = None,
        include_results: bool | None = None,
        idempotency_key: str | None = None,
    ) -> Batch:
        """Submit a batch. Answers 202 with the batch; nothing has run yet.

        A batch of one is a batch. There is no separate single-target path and
        no ceiling to discover between one target and fifty thousand.
        """
        if not targets:
            raise ValueError("targets is empty: a batch needs at least one target")

        body: dict[str, Any] = {"targets": list(targets)}
        _put(body, external_id=external_id, callback_url=callback_url,
             webhook_tag=webhook_tag, max_results=max_results, enrich=enrich,
             find_emails=find_emails, include_results=include_results)

        data = self._request(
            "POST", path, body=body,
            # Minted here rather than left to the caller, because the retry
            # below is ours: without a key, our own retry of a submission that
            # actually succeeded creates a second batch and bills it.
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )
        return Batch.from_json(data)

    def submit_sync(
        self,
        path: str,
        target: Any,
        *,
        external_id: str | None = None,
        max_results: int | None = None,
        idempotency_key: str | None = None,
    ) -> SyncResult:
        """One entity, answered in this response, at twice the credits.

        `target`, singular - not a list of one. The bounds are refusals rather
        than downgrades: no `enrich`, no webhooks, and one upstream page for a
        paged operation.
        """
        if isinstance(target, (list, tuple, set)):
            raise ValueError(
                "sync takes ONE target, not a sequence - submit a batch for several"
            )

        body: dict[str, Any] = {"target": target}
        _put(body, external_id=external_id, max_results=max_results)

        data = self._request(
            "POST", path + "/sync", body=body,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )
        return SyncResult.from_json(data)

    # --------------------------------------------------------------- batches

    def batch(self, batch_id: str) -> Batch:
        """One batch's current state."""
        return Batch.from_json(self._request("GET", f"/batches/{batch_id}"))

    def batches(
        self,
        *,
        status: str | None = None,
        operation: str | None = None,
        external_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Batch]:
        """List your batches, newest first."""
        query = {"limit": limit, "offset": offset}
        _put(query, status=status, operation=operation, external_id=external_id)
        # `data` is the array itself, not an object wrapping one: the listing's
        # own pagination lives in `meta` (total, hasMore) like every other
        # response's does.
        data = self._request("GET", "/batches", query=query)
        return [Batch.from_json(b) for b in (data or [])]

    def cancel(self, batch_id: str) -> Batch:
        """Stop a batch. Entries already delivered stay delivered and charged."""
        return Batch.from_json(self._request("POST", f"/batches/{batch_id}/cancel"))

    def results_page(
        self,
        batch_id: str,
        *,
        cursor: str = "",
        page_size: int = 100,
    ) -> "ResultsPage":
        """One page of the cursor, and the cursor to continue from.

        `results()` is the loop you usually want. This is the layer under it,
        for a caller that owns its own paging - a worker that stores the cursor
        between runs, or a request handler that must return rather than block.
        The cursor is opaque: hand back exactly what you were given.
        """
        query: dict[str, Any] = {"limit": page_size}
        if cursor:
            query["cursor"] = cursor

        data, meta = self._request(
            "GET", f"/batches/{batch_id}/results", query=query, with_meta=True
        )
        return ResultsPage(
            status=str(data.get("status", "")),
            entries=[ResultEntry.from_json(e) for e in (data.get("entries") or [])],
            next_cursor=str(meta.get("nextCursor") or ""),
            has_more=bool(meta.get("hasMore")),
            recommended_poll_ms=int(meta.get("recommendedPollMs") or 0),
        )

    def results(
        self,
        batch_id: str,
        *,
        page_size: int = 100,
        wait: bool = True,
        timeout: float | None = None,
    ) -> Iterator[ResultEntry]:
        """Stream a batch's entries, yielding each one as it becomes readable.

        This is the whole point of the cursor: results are readable WHILE the
        batch is still processing, so a long batch starts producing rows
        immediately rather than after it finishes.

        With `wait=True` (the default) the iterator keeps the cursor open until
        the batch reaches a terminal state, sleeping for as long as the API's
        own `recommended_poll_ms` says between empty reads. With `wait=False` it
        yields what is readable right now and stops.

        The cursor is monotonic and gapless, so resuming is exact: an entry is
        yielded once, and a batch still filling in never re-delivers one you
        have already seen.
        """
        cursor = ""
        deadline = None if timeout is None else time.monotonic() + timeout

        while True:
            page = self.results_page(batch_id, cursor=cursor, page_size=page_size)
            yield from page.entries

            if page.next_cursor:
                cursor = page.next_cursor

            if page.has_more:
                continue

            if not wait or page.status not in _LIVE:
                return

            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(
                    f"batch {batch_id} was still {page.status} after {timeout}s; "
                    "its results remain readable - call results() again with the "
                    "same batch id"
                )

            # The server's own number. Polling faster than this does not make
            # the scrape finish sooner; it only spends the request budget the
            # rate limiter is counting.
            time.sleep((page.recommended_poll_ms or 2000) / 1000.0)

    def stream(
        self,
        batch_id: str,
        *,
        cursor: str = "",
        max_reconnects: int = 10,
    ) -> Iterator[ResultEntry]:
        """Stream a batch's entries over a held connection instead of polling.

        Same cursor, same entries, same order as `results()` - the difference
        is that the server pushes rather than the client asking, so a long
        batch costs one request instead of hundreds against your rate limit.

        Use webhooks instead if you run a server with a public URL. This is for
        a client with nowhere to deliver to: an agent on a laptop, a CLI, an
        edge function.

        Reconnects are handled here and are exact: the event id IS the cursor,
        so a dropped connection resumes where it stopped with no duplicates and
        no gaps. The iterator ends when the batch reaches a terminal state.

            for entry in ed.stream(batch.batch_id):
                if entry.ok:
                    save(entry.data)
        """
        reconnects = 0

        while True:
            url = f"{self.base_url}/batches/{batch_id}/results"
            if cursor:
                url += "?" + urllib.parse.urlencode({"cursor": cursor})

            headers = {
                "X-API-Key": self.api_key,
                "Accept": "text/event-stream",
                "User-Agent": self.user_agent,
            }
            if cursor:
                # Where to resume. The server prefers this over ?cursor= for
                # the same reason a browser sends it: it is the more recent of
                # the two.
                headers["Last-Event-ID"] = cursor

            req = urllib.request.Request(url, headers=headers, method="GET")
            complete = False

            try:
                # No read timeout: a stream that stays open is the point. The
                # server ends it with `timeout` after its own limit.
                with urllib.request.urlopen(req) as resp:
                    for event, data, event_id in _parse_sse(resp):
                        if event_id:
                            cursor = event_id

                        if event == "result":
                            yield ResultEntry.from_json(json.loads(data))
                        elif event == "complete":
                            complete = True
                            break
                        elif event == "error":
                            raise EasyDataError(
                                f"stream failed: {data}. Resume from cursor {cursor}."
                            )
                        # `timeout` is the server ending a long stream on
                        # purpose. Falling through re-opens from the cursor,
                        # which is what it asked for - a caller never sees it.
            except urllib.error.HTTPError as exc:
                raise error_for(exc.code, _decode(exc.read())) from exc
            except (urllib.error.URLError, OSError) as exc:
                # A dropped connection is the case reconnecting exists for.
                if reconnects >= max_reconnects:
                    raise TransportError(
                        f"stream dropped and could not be resumed from {cursor}: {exc}"
                    ) from exc
                reconnects += 1
                time.sleep(self._backoff(reconnects, None))
                continue

            if complete:
                return

            # Ended without a `complete`. Re-open from the cursor.
            reconnects += 1
            if reconnects > max_reconnects:
                raise TransportError(
                    f"stream dropped {reconnects} times without completing; last cursor {cursor}"
                )

    def wait(self, batch_id: str, *, timeout: float | None = None) -> Batch:
        """Block until a batch reaches a terminal state, and return it.

        Use `results()` instead when you want the rows: this polls the batch
        row, which tells you the counters and not the records.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            b = self.batch(batch_id)
            if b.done:
                return b
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"batch {batch_id} was still {b.status} after {timeout}s")
            time.sleep(b.recommended_poll_ms / 1000.0)

    # --------------------------------------------------------------- account

    def account(self) -> Mapping[str, Any]:
        """The allowance, the ceilings, and the webhook signing secret."""
        return self._request("GET", "/account")

    def usage(
        self,
        *,
        from_: str | None = None,
        to: str | None = None,
        external_id: str | None = None,
    ) -> Mapping[str, Any]:
        """Spend, by day and operation."""
        query: dict[str, Any] = {}
        _put(query, to=to, external_id=external_id)
        if from_:
            query["from"] = from_
        return self._request("GET", "/usage", query=query)

    # ------------------------------------------------------------- transport

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        with_meta: bool = False,
    ) -> Any:
        url = self.base_url + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)

        payload = json.dumps(body).encode() if body is not None else None
        headers = {
            "X-API-Key": self.api_key,
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        last: EasyDataError | None = None
        for attempt in range(self.max_retries + 1):
            try:
                status, out, resp_headers = self._once(method, url, payload, headers)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                # The request never produced a response. Safe to repeat: a
                # submission carries an idempotency key, and everything else
                # here is a read.
                last = TransportError(f"could not reach {url}: {exc}")
                if attempt >= self.max_retries:
                    raise last from exc
                time.sleep(self._backoff(attempt, None))
                continue

            self.rate_limits = RateLimits.from_headers(resp_headers)

            if 200 <= status < 300:
                envelope = out if isinstance(out, Mapping) else {}
                data = envelope.get("data", envelope)
                return (data, envelope.get("meta") or {}) if with_meta else data

            retry_after = _retry_after(resp_headers)
            err = error_for(status, out if isinstance(out, Mapping) else {}, retry_after=retry_after)

            # 429 and 5xx are the two the server is telling us to try again on.
            # Everything else is a refusal that repeating cannot fix, and
            # retrying it would only spend the rate budget on a certain no.
            if status != 429 and status < 500:
                raise err
            if attempt >= self.max_retries:
                raise err
            last = err
            time.sleep(self._backoff(attempt, retry_after))

        raise last or EasyDataError("request failed")  # pragma: no cover

    def _once(
        self, method: str, url: str, payload: bytes | None, headers: Mapping[str, str]
    ) -> tuple[int, Any, dict[str, str]]:
        req = urllib.request.Request(url, data=payload, method=method)
        for k, v in headers.items():
            req.add_header(k, v)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, _decode(resp.read()), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            # An HTTP error IS a response - the API said no, in the envelope -
            # so it is decoded here rather than raised as a transport failure.
            return exc.code, _decode(exc.read()), dict(exc.headers or {})

    def _backoff(self, attempt: int, retry_after: float | None) -> float:
        """The server's own number when it sent one, otherwise exponential.

        Jittered because the failure that produces a retry storm is the one
        every client sees at the same instant, and an unjittered backoff
        reconverges them on the same second.
        """
        if retry_after is not None:
            return min(retry_after, 60.0)
        return min(2.0**attempt, 30.0) * (0.5 + random.random() / 2)

    def verify_webhook(self, secret: str, headers: Mapping[str, str], body: bytes, **kw: Any):
        """Convenience for `easydata.webhooks.verify`. See that module."""
        from . import webhooks

        return webhooks.verify(secret, headers, body, **kw)


def _parse_sse(stream: Any) -> Iterator[tuple[str, str, str]]:
    """The wire format of Server-Sent Events, as (event, data, id) triples.

    Hand-rolled rather than a dependency, because this client has none and the
    format is three rules: events are separated by a blank line, fields are
    `name: value`, and a line starting with `:` is a comment.

    Fields accumulate until a blank line, so a `data:` split across two reads is
    reassembled rather than parsed as half an entry.
    """
    event, data, event_id = "message", [], ""

    for raw in stream:
        line = raw.decode("utf-8", "replace").rstrip("\n").rstrip("\r")

        if not line:
            if data or event != "message":
                yield event, "\n".join(data), event_id
            event, data, event_id = "message", [], ""
            continue

        if line.startswith(":"):
            continue  # keepalive comment

        field, _, value = line.partition(":")
        # One optional space after the colon is part of the framing.
        value = value[1:] if value.startswith(" ") else value

        if field == "event":
            event = value
        elif field == "data":
            data.append(value)
        elif field == "id":
            event_id = value

    if data or event != "message":
        yield event, "\n".join(data), event_id


def _put(d: dict[str, Any], **kwargs: Any) -> None:
    """Sets the keyword arguments that were actually given.

    Absent is not the same as false here: `enrich=False` is a caller saying so,
    and dropping it because it is falsy would silently send a different request
    than the one they wrote.
    """
    for k, v in kwargs.items():
        if v is not None:
            d[k] = v


def _decode(raw: bytes) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        # A body that is not JSON is a proxy or a gateway answering, not this
        # API. Keep it: it is the only evidence of what actually replied.
        return {"error": {"type": "", "message": raw[:500].decode("utf-8", "replace")}}


def _retry_after(headers: Mapping[str, str]) -> float | None:
    raw = headers.get("Retry-After") or headers.get("retry-after")
    if raw is None:
        return None
    try:
        return max(float(raw), 0.0)
    except (TypeError, ValueError):
        return None
