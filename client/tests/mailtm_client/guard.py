"""
Who may call mail.tm. A test suite turns the guard on; from then on every mail.tm call (every HTTP
request and the live feed) needs a permission that is open at the time, or it raises
MailTmNotAllowed before anything is sent. Off by default, so scripts and other projects never
notice it. Standard library only; it knows nothing about pytest (the suite wires it up).

    GUARD.enable()
    with GUARD.running("tests/e2e/x.py::test_y"):  # names the code in error messages
        with GUARD.allow("@pytest.mark.email"):  # a test that makes or reads inboxes
            ...
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Iterator, NamedTuple, Optional


class MailTmNotAllowed(RuntimeError):
    """Code without permission called mail.tm (the guard is on and no `allow` is open). It is not
    a MailTmError on purpose: code that handles mail.tm's own errors must never swallow it."""


class Violation(NamedTuple):
    context: str  # what was running (a test id), or "" outside any
    call: str  # "GET /messages"


class CallGuard:
    """See the module docstring. One per process (`GUARD`); a client may be given its own."""

    def __init__(self) -> None:
        self.enabled = False
        self._local = threading.local()
        self.violations: list[Violation] = []

    def enable(self, enabled: bool = True) -> None:
        self.enabled = enabled

    def _grants(self) -> list:
        grants = getattr(self._local, "grants", None)
        if grants is None:
            grants = self._local.grants = []
        return grants

    @property
    def context(self) -> str:
        return getattr(self._local, "context", "")

    @contextmanager
    def running(self, context: str) -> Iterator[None]:
        """Names what runs now (a test id), for the error message."""
        before = self.context
        self._local.context = context
        try:
            yield
        finally:
            self._local.context = before

    @contextmanager
    def allow(self, reason: str) -> Iterator[None]:
        """Lets the code inside call mail.tm (nests; per thread)."""
        grants = self._grants()
        grants.append(reason)
        try:
            yield
        finally:
            grants.pop()

    @property
    def allowed(self) -> Optional[str]:
        """The innermost open permission's reason, or None."""
        grants = self._grants()
        return grants[-1] if grants else None

    def check(self, method: str, path: str) -> None:
        """Raises MailTmNotAllowed when the guard is on and no permission is open (and notes the
        violation, so a caller that swallows the error still fails its test)."""
        if not self.enabled or self._grants():
            return
        call = f"{method} {path}"
        context = self.context
        self.violations.append(Violation(context, call))
        who = context or "Code outside any test"
        raise MailTmNotAllowed(
            f"{who} called mail.tm ({call}) without permission. A test that makes or reads a real "
            "inbox (a new user, a new mailbox, an invite email, the signup and confirm flows) must "
            "be tagged @pytest.mark.email; an account other tests share is made in an allowed "
            "setup (shared_test_user, the pooled_* fixtures), so every mail.tm call waits in the "
            "shared queue."
        )


GUARD = CallGuard()
