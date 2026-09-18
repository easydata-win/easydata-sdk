"""The error vocabulary, as exceptions.

One class per `error.type` the API publishes, all under `EasyDataError`, so a
caller can catch the family or the one case they know how to handle. The type
string is the contract - the class is a convenience over it - which is why
`EasyDataError.type` is always the string the API sent, including for a type
this version of the SDK has never heard of.
"""

from __future__ import annotations

from typing import Any, Mapping


class EasyDataError(Exception):
    """Any error the API reported, or any failure to reach it."""

    #: The `error.type` string. Empty only for a transport failure.
    type: str = ""

    def __init__(
        self,
        message: str,
        *,
        type: str = "",
        status: int = 0,
        request_id: str = "",
        field: str = "",
        retry_after: float | None = None,
        body: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if type:
            self.type = type
        self.status = status
        self.request_id = request_id
        self.field = field
        self.retry_after = retry_after
        self.body = dict(body or {})

    def __str__(self) -> str:  # pragma: no cover - formatting only
        parts = [self.message]
        if self.type:
            parts.append(f"type={self.type}")
        if self.status:
            parts.append(f"status={self.status}")
        if self.request_id:
            # Quote this at support and the request can be found in one query.
            parts.append(f"request_id={self.request_id}")
        if self.field:
            parts.append(f"field={self.field}")
        return " ".join(parts)


class InvalidRequest(EasyDataError):
    """400. `field` names the offending key when the API could identify one.

    An unknown key in the body is refused rather than ignored, so this is also
    what a typo looks like - which is the point of refusing it.
    """

    type = "invalid_request"


class InvalidAPIKey(EasyDataError):
    """401. Missing, malformed, revoked or expired. Never metered."""

    type = "invalid_api_key"


class QuotaExhausted(EasyDataError):
    """403. The monthly allowance is spent. Waiting is the fix."""

    type = "quota_exhausted"


class EmailUnverified(EasyDataError):
    """403, and NOT the same as a spent allowance.

    The default allowance is gated on somebody on the organization having
    confirmed their email address. Clicking the link fixes it; waiting for next
    month does not.
    """

    type = "email_unverified"


class InsufficientScope(EasyDataError):
    """403. The key is valid and is the WRONG one.

    It does not carry the scope this route needs - `read` to page results,
    `write` to submit, cancel or change the account. The message names which.

    Never retried, by this client or by you: no amount of waiting gives a
    credential a scope it was not minted with. Mint a key that carries it.
    `EasyData.account()["scopes"]` reports what the current key holds.
    """

    type = "insufficient_scope"


class NotFound(EasyDataError):
    """404. A batch id that is not yours, or is not a batch."""

    type = "not_found"


class Conflict(EasyDataError):
    """409. Most often an `Idempotency-Key` replayed with a different body."""

    type = "conflict"


class UnprocessableTarget(EasyDataError):
    """422. The request was well-formed and the target was not usable."""

    type = "unprocessable_target"


class RateLimited(EasyDataError):
    """429. `retry_after` carries the server's own number, in seconds.

    The client retries this for you by default - see `EasyData(max_retries=)`.
    Seeing it means the retries were exhausted or were switched off.
    """

    type = "rate_limited"


class NotImplementedYet(EasyDataError):
    """501. The operation is published and its scraper is not live yet."""

    type = "not_implemented"


class InternalError(EasyDataError):
    """500. Ours. Retried by default."""

    type = "internal_error"


class UpstreamTimeout(EasyDataError):
    """504-shaped: the upstream did not answer in time."""

    type = "upstream_timeout"


class CapacityUnavailable(EasyDataError):
    """No worker in the pool can run this operation right now."""

    type = "capacity_unavailable"


class TransportError(EasyDataError):
    """The request never produced an API response: DNS, TLS, socket, timeout.

    Distinct from every class above, which all mean "the API answered and said
    no". A caller retrying on its own needs to know which of the two it got.
    """


#: Built from the classes rather than typed out again - a table written twice
#: is a table that disagrees with itself after one rename.
_BY_TYPE = {
    cls.type: cls
    for cls in (
        InvalidRequest,
        InvalidAPIKey,
        QuotaExhausted,
        EmailUnverified,
        InsufficientScope,
        NotFound,
        Conflict,
        UnprocessableTarget,
        RateLimited,
        NotImplementedYet,
        InternalError,
        UpstreamTimeout,
        CapacityUnavailable,
    )
}


def error_for(
    status: int,
    body: Mapping[str, Any],
    *,
    retry_after: float | None = None,
) -> EasyDataError:
    """Builds the exception for one error response.

    An unrecognised `error.type` becomes a plain `EasyDataError` carrying that
    string, never a crash: the vocabulary is allowed to grow, and an SDK a
    version behind should still hand the caller something they can read and
    report.
    """
    err = body.get("error") if isinstance(body, Mapping) else None
    if not isinstance(err, Mapping):
        err = {}

    etype = str(err.get("type") or "")
    message = str(err.get("message") or f"HTTP {status}")
    cls = _BY_TYPE.get(etype, EasyDataError)

    return cls(
        message,
        type=etype,
        status=status,
        request_id=str(err.get("requestId") or err.get("request_id") or ""),
        field=str(err.get("field") or ""),
        retry_after=retry_after,
        body=body,
    )
