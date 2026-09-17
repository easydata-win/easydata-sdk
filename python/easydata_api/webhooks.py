"""Verifying a webhook delivery.

Two schemes ride on every delivery and you need only one of them.

`X-EasyData-Signature: t=<unix>,v1=<hex>` is an HMAC-SHA256 over
`<t>.<raw body>`, keyed with your webhook secret. It needs nothing but the
standard library.

`X-EasyData-Signature-Ed25519: t=<unix>,kid=<key id>,wid=<endpoint id>,v1b=<b64url>`
signs `<t>.<wid>.<raw body>` and is checked against the public key published at
`https://api.easydata.win/.well-known/webhook-keys.json`. Verifying it needs no
secret at all, so a partner, a queue consumer or an edge function can check a
delivery you forwarded to them. It needs `cryptography`, which is why it is an
optional extra rather than a dependency.

Two rules that are easy to get wrong and silent when you do:

* **Verify against the RAW body**, exactly the bytes that arrived. Re-serialising
  the parsed JSON changes key order and whitespace, and the signature will not
  match a body you rebuilt.
* **Never verify against `X-EasyData-Timestamp`.** It carries the same unix
  seconds, but it sits OUTSIDE both signed messages - anyone replaying a captured
  delivery can set it to whatever passes a freshness check. The `t` inside the
  signature header is the only copy that cannot be edited without breaking the
  signature, and it is the one both functions here read.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Mapping, NamedTuple

__all__ = ["Delivery", "verify", "verify_ed25519", "VerificationError"]

#: The default freshness window, in seconds. Generous enough for a retry and a
#: clock that is a little out, short enough that a captured delivery goes stale.
DEFAULT_TOLERANCE = 300


class VerificationError(Exception):
    """The delivery did not verify. Answer 400 and do not process it."""


class Delivery(NamedTuple):
    """A verified delivery, unpacked."""

    id: str
    event: str
    created_at: str
    data: Mapping[str, Any]
    #: The whole parsed body, for anything this tuple does not name.
    body: Mapping[str, Any]


def verify(
    secret: str,
    headers: Mapping[str, str],
    body: bytes,
    *,
    tolerance: int = DEFAULT_TOLERANCE,
) -> Delivery:
    """Verifies the HMAC signature and returns the delivery.

    Raises `VerificationError` on anything wrong - a missing header, a stale
    timestamp, a bad digest - because there is nothing useful a caller can do
    with a delivery that half-verified.

        @app.post("/webhooks/easydata")
        def hook():
            try:
                d = verify(SECRET, request.headers, request.get_data())
            except VerificationError:
                return "", 400
            if seen(d.id):        # X-EasyData-Delivery, stable across retries
                return "", 200
            handle(d.event, d.data)
            return "", 200
    """
    if not secret:
        raise VerificationError("no signing secret: read it from GET /v1/account")

    raw = _header(headers, "X-EasyData-Signature")
    if not raw:
        raise VerificationError("no X-EasyData-Signature header")

    parts = _parse(raw)
    ts, sig = parts.get("t"), parts.get("v1")
    if not ts or not sig:
        raise VerificationError(f"malformed signature header: {raw!r}")

    _check_age(ts, tolerance)

    expected = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    # Constant time: a byte-at-a-time comparison leaks where the first
    # difference is, which is enough to forge a digest given enough attempts.
    if not hmac.compare_digest(expected, sig):
        raise VerificationError("signature does not match")

    return _delivery(body)


def verify_ed25519(
    public_key_b64: str,
    headers: Mapping[str, str],
    body: bytes,
    *,
    webhook_id: str,
    tolerance: int = DEFAULT_TOLERANCE,
) -> Delivery:
    """Verifies the Ed25519 signature. Needs `pip install easydata-api[ed25519]`.

    `webhook_id` is YOUR endpoint's id, and passing it is not optional.

    One key signs for every customer on the deployment, so a delivery another
    customer legitimately received is a genuinely signed message. Without
    checking that `wid` is your endpoint, replaying theirs against your receiver
    verifies. The HMAC scheme needs no equivalent check, because your secret is
    only yours.
    """
    # Everything that can be decided without the optional dependency is decided
    # first. The `wid` check below is the security-relevant one and it is pure
    # string comparison; importing ahead of it turned "this delivery is not
    # yours" into "you have not installed cryptography", which is the wrong
    # answer to the more important question.
    if not webhook_id:
        raise VerificationError(
            "webhook_id is required: one key signs for every customer, so a "
            "delivery is only yours if wid matches your endpoint"
        )

    raw = _header(headers, "X-EasyData-Signature-Ed25519")
    if not raw:
        raise VerificationError("no X-EasyData-Signature-Ed25519 header")

    parts = _parse(raw)
    ts, wid, sig = parts.get("t"), parts.get("wid"), parts.get("v1b")
    if not ts or not wid or not sig:
        raise VerificationError(f"malformed signature header: {raw!r}")

    if not hmac.compare_digest(wid, webhook_id):
        raise VerificationError(
            f"delivery was addressed to endpoint {wid}, not to {webhook_id}"
        )

    _check_age(ts, tolerance)

    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:  # pragma: no cover - depends on the extra
        raise VerificationError(
            "Ed25519 verification needs the `cryptography` package: "
            "pip install easydata-api[ed25519]. The HMAC scheme in verify() needs nothing."
        ) from exc

    key = Ed25519PublicKey.from_public_bytes(_b64(public_key_b64))
    message = f"{ts}.{wid}.".encode() + body
    try:
        key.verify(_b64(sig), message)
    except InvalidSignature as exc:
        raise VerificationError("signature does not match") from exc

    return _delivery(body)


def _delivery(body: bytes) -> Delivery:
    try:
        parsed = json.loads(body)
    except ValueError as exc:
        raise VerificationError("body is not JSON") from exc
    if not isinstance(parsed, dict):
        raise VerificationError("body is not an object")

    # The event's own fields are in `data`, one level down. Reading the top
    # level instead is the quietest bug this API can hand you: the signature
    # still verifies, the handler still returns 2xx, and every field is None.
    return Delivery(
        id=str(parsed.get("id", "")),
        event=str(parsed.get("event", "")),
        created_at=str(parsed.get("createdAt", "")),
        data=parsed.get("data") or {},
        body=parsed,
    )


def _check_age(ts: str, tolerance: int) -> None:
    try:
        sent = int(ts)
    except ValueError as exc:
        raise VerificationError(f"signature timestamp is not a number: {ts!r}") from exc
    if tolerance > 0 and abs(time.time() - sent) > tolerance:
        raise VerificationError(f"signature timestamp is outside {tolerance}s")


def _parse(header: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in header.split(","):
        k, _, v = part.strip().partition("=")
        if k:
            out[k] = v
    return out


def _header(headers: Mapping[str, str], name: str) -> str:
    """HTTP header names are case-insensitive and half the frameworks lowercase
    them, so look the obvious ways before giving up."""
    for key in (name, name.lower(), name.upper(), name.replace("-", "_").upper()):
        if key in headers:
            return str(headers[key])
    for key, value in headers.items():
        if key.lower() == name.lower():
            return str(value)
    return ""


def _b64(s: str) -> bytes:
    """Decodes base64 in whichever of the four spellings arrived.

    The signature is base64url without padding and a public key is pasted into
    an env file by a human, so which alphabet and whether it is padded is not
    worth failing a deployment over.
    """
    import base64

    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        for candidate in (s, s + "=" * (-len(s) % 4)):
            try:
                return decoder(candidate)
            except Exception:  # noqa: BLE001 - trying the next spelling
                continue
    raise VerificationError(f"could not decode base64: {s[:16]!r}...")
