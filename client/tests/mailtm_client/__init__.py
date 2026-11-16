"""
mail.tm for test suites: a minimal API client whose every call goes through a rate limiter shared
by all the processes on the machine (pytest-xdist workers included). Portable: this folder
imports nothing outside itself and the standard library, except `requests`. See README.md.
"""
from .client import (
    DEFAULT_BASE_URL,
    DOCUMENTED_LIMIT,
    MailTmClient,
    MailTmError,
    MailTmTimeout,
    Quota,
    RetryPolicy,
    backoff_seconds,
    default_state_dir,
    message_text,
    ratelimit_quota,
    retry_after_seconds,
)
from .ratelimit import (
    DEFAULT_BURST,
    DEFAULT_RATE,
    InterProcessLock,
    LockTimeout,
    RateLimitTimeout,
    SharedRateLimiter,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_BURST",
    "DEFAULT_RATE",
    "DOCUMENTED_LIMIT",
    "InterProcessLock",
    "LockTimeout",
    "MailTmClient",
    "MailTmError",
    "MailTmTimeout",
    "Quota",
    "RateLimitTimeout",
    "RetryPolicy",
    "SharedRateLimiter",
    "backoff_seconds",
    "default_state_dir",
    "message_text",
    "ratelimit_quota",
    "retry_after_seconds",
]
