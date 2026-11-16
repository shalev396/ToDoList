"""
mail.tm for test suites: a rate limiter shared by all the processes on the machine (pytest-xdist
workers included). Portable: this folder imports nothing outside itself and the standard library.
"""
from .ratelimit import (
    DEFAULT_BURST,
    DEFAULT_RATE,
    InterProcessLock,
    LockTimeout,
    SharedRateLimiter,
)

__all__ = [
    "DEFAULT_BURST",
    "DEFAULT_RATE",
    "InterProcessLock",
    "LockTimeout",
    "SharedRateLimiter",
]
