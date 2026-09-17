"""EasyData - LinkedIn data enrichment.

    from easydata_api import EasyData

    ed = EasyData()  # reads EASYDATA_API_KEY

    # One record, in this call, at twice the credits.
    r = ed.profiles_enrich.sync("https://linkedin.com/in/satyanadella")
    print(r.result.data["full_name"])

    # A batch of any size, streamed as it drains.
    batch = ed.profiles_enrich(urls, external_id="crm-sync")
    for entry in ed.results(batch.batch_id):
        if entry.ok:
            save(entry.data)

Everything is a batch, including a batch of one, and you are billed per record
that resolves: a failure costs nothing.
"""

from .client import (
    DEFAULT_BASE_URL,
    OPERATIONS,
    Batch,
    EasyData,
    RateLimits,
    ResultEntry,
    ResultsPage,
    SyncResult,
)
from .errors import (
    CapacityUnavailable,
    Conflict,
    EasyDataError,
    EmailUnverified,
    InternalError,
    InvalidAPIKey,
    InvalidRequest,
    NotFound,
    NotImplementedYet,
    QuotaExhausted,
    RateLimited,
    TransportError,
    UnprocessableTarget,
    UpstreamTimeout,
)
from .webhooks import Delivery, VerificationError, verify, verify_ed25519

__version__ = "1.0.0"

__all__ = [
    "EasyData",
    "Batch",
    "ResultEntry",
    "ResultsPage",
    "SyncResult",
    "RateLimits",
    "OPERATIONS",
    "DEFAULT_BASE_URL",
    "EasyDataError",
    "InvalidRequest",
    "InvalidAPIKey",
    "QuotaExhausted",
    "EmailUnverified",
    "NotFound",
    "Conflict",
    "UnprocessableTarget",
    "RateLimited",
    "NotImplementedYet",
    "InternalError",
    "UpstreamTimeout",
    "CapacityUnavailable",
    "TransportError",
    "verify",
    "verify_ed25519",
    "Delivery",
    "VerificationError",
    "__version__",
]
