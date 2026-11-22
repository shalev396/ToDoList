"""
A minimal mail.tm API client (https://docs.mail.tm/). Every HTTP call waits its turn in one
first-in, first-out SharedQueue shared by every process on the machine, with two buckets:
6 calls a second (mail.tm documents 8 per IP address) and 9 a minute (it announces
`RateLimit-Policy: 10; w=60`).

429s are never the end of a call:
- A 429 pauses every process (the server's `Retry-After` or RateLimit reset, else an exponential
  backoff on the 429s in a row), then the same call is retried in its place in line: idempotent
  calls (GET, DELETE; POST /token, which only issues a token) and account creation (a 429 is a
  refusal, so no account exists yet). There is no small retry cap: only the per-call ceiling
  (`RetryPolicy.call_ceiling`, 15 minutes, time in line included) ends it, with MailTmRateLimited
  and its counts. Every 429 is logged with its rate-limit headers and the run's request counter.
- A dropped connection, a timeout or a 502/503/504 is retried, at most `max_attempts` calls, only
  for idempotent calls. Account creation is not retried then: the account may exist already, and
  a retry would turn a clear error into "address already used".

RateLimit headers: every answer's `RateLimit-*` / `X-RateLimit-*` headers are read
(`ratelimit_quota`). A `remaining` count and its `reset` become a budget in the shared queue, so
the next calls wait for the reset instead of drawing a 429. The headers don't say which requests a
quota counts, so the budget covers the whole host: the simplest choice that never under-counts.

Waiting for a message (`wait_for_message`, `InboxWatch.wait_for`): the deadline counts only the
time not spent in line for a slot, so a rate-limited look never ends a wait. mail.tm's live feed
(Mercure, live.py) says when a message arrives, and one queued GET reads it; when the feed fails to
connect or drops, the wait polls for the rest of its budget.

Every call first asks the CallGuard (guard.py), off unless a suite turns it on.
"""
from __future__ import annotations

import base64
import json as jsonlib
import logging
import math
import os
import random
import re
import tempfile
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping, NamedTuple, Optional, Sequence
from urllib.parse import quote, urlparse

import requests

from .guard import GUARD, CallGuard
from .live import DEFAULT_MERCURE_URL, READ_TIMEOUT, Ended, ThreadedFeed
from .ratelimit import (
    DEFAULT_BUCKETS,
    Bucket,
    Clock,
    RateLimitTimeout,
    SharedQueue,
    Sleep,
    Slot,
)

_log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.mail.tm"
# https://docs.mail.tm/: "The general quota limit is 8 queries per second (QPS) per IP address."
DOCUMENTED_LIMIT = 8
# What mail.tm announces on its answers: `RateLimit-Policy: 10; w=60`.
ANNOUNCED_PER_MINUTE = 10
# Environment overrides, read when the matching constructor argument is not given.
STATE_DIR_ENV = "MAILTM_STATE_DIR"
PER_SECOND_ENV = "MAILTM_PER_SECOND"
PER_MINUTE_ENV = "MAILTM_PER_MINUTE"
RUN_ID_ENV = "MAILTM_RUN_ID"
LIVE_ENV = "MAILTM_LIVE"

IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})
TRANSIENT_STATUSES = frozenset({502, 503, 504})
MERCURE_PATH = "/.well-known/mercure"
# While the live feed has announced nothing that matches for this long, a wait also takes one
# look at the inbox (a missed event can't cost the whole budget).
SAFETY_LOOK = 45.0

_RATE_HEADER = re.compile(r"^(x-)?ratelimit|^retry-after$", re.IGNORECASE)


class MailTmError(RuntimeError):
    """mail.tm answered with an error, or without what was asked for."""


class MailTmTimeout(MailTmError):
    """No message matched before the deadline."""


class MailTmRateLimited(MailTmError):
    """A call was still refused (429), or still waiting in line, at the per-call ceiling."""


class AddressTaken(MailTmError):
    """The address belongs to an inbox the given password doesn't open: pick another address."""


@dataclass(frozen=True)
class RetryPolicy:
    """
    - `call_ceiling`: the most seconds one call may take, time in line and 429 pauses included;
      past it, MailTmRateLimited. 429s are retried until then.
    - `max_attempts`: calls in all after dropped connections, timeouts and 502/503/504.
    - A 429 without a hint pauses everyone 1-2 s, 2-4 s, 4-8 s, ... (`backoff_base` doubling with
      each 429 in a row, at most `backoff_cap`); so does a transient failure, for this caller.
    - `Retry-After` is honoured up to `retry_after_cap` seconds.
    - RateLimit headers: at most `remaining - quota_reserve` more calls before the reset, which
      is at most `quota_pause_cap` seconds away.
    """

    call_ceiling: float = 900.0
    max_attempts: int = 7
    backoff_base: float = 2.0
    backoff_cap: float = 30.0
    retry_after_cap: float = 120.0
    quota_reserve: int = 1
    quota_pause_cap: float = 120.0


class Quota(NamedTuple):
    """What an answer's RateLimit headers say; None where they say nothing usable."""

    limit: Optional[float]  # requests in the window
    remaining: Optional[float]  # requests left in it
    reset: Optional[float]  # seconds until it refills
    window: Optional[float]  # the policy's window, in seconds


@dataclass
class CallStats:
    """What this client (one process) did."""

    requests: int = 0  # HTTP calls sent
    refused: int = 0  # of them answered 429
    queued: float = 0.0  # seconds spent in line for a slot, 429 pauses included
    live: int = 0  # messages found through the live feed
    polled: int = 0  # messages found by polling


class Inbox(NamedTuple):
    token: str
    account_id: Optional[str]


# RateLimit parameter names: draft-7 (`limit=10, remaining=0, reset=42`), and the later drafts'
# short ones (`"name";r=0;t=42`, and `RateLimit-Policy: "name";q=10;w=60`).
_QUOTA_KEYS = {
    "limit": "limit",
    "q": "limit",
    "remaining": "remaining",
    "r": "remaining",
    "reset": "reset",
    "t": "reset",
    "w": "window",
}
# A reset this large is a point in time (epoch seconds, the X-RateLimit-Reset habit), not a delay.
_EPOCH_RESET = 1_000_000_000


def _quota_number(text: str) -> Optional[float]:
    """A finite, non-negative number, or None (`nan`, `inf`, `-4`, `soon`, ...)."""
    try:
        value = float(text.strip().strip('"'))
    except ValueError:
        return None
    return value if math.isfinite(value) and value >= 0 else None


def _reset_seconds(value: float) -> float:
    if value >= _EPOCH_RESET:
        return max(value - time.time(), 0.0)
    return value


def ratelimit_quota(headers: Mapping[str, str]) -> Optional[Quota]:
    """
    The quota an answer's rate-limit headers describe, in any letter case: `RateLimit` (draft-7
    `limit=10, remaining=0, reset=42`, or the later `"name";r=0;t=42`), the older
    `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`, their `X-RateLimit-*` forms (a
    reset that large is an epoch time), and `RateLimit-Policy` (`10; w=60`, or
    `"name";q=10;w=60`). Where several quotas are given, the strictest wins: the lowest limit and
    remaining, the longest reset and window. Malformed values are skipped; None when nothing
    usable is left.
    """
    lowered = {str(name).lower(): str(value) for name, value in headers.items()}
    found: dict[str, list[float]] = {"limit": [], "remaining": [], "reset": [], "window": []}
    for prefix in ("ratelimit-", "x-ratelimit-"):
        for key in ("limit", "remaining", "reset"):
            for item in lowered.get(f"{prefix}{key}", "").split(","):
                value = _quota_number(item.split(";")[0])  # an old draft allowed "10, 10;w=1"
                if value is not None:
                    found[key].append(_reset_seconds(value) if key == "reset" else value)
    for name in ("ratelimit", "ratelimit-policy"):
        for item in lowered.get(name, "").split(","):
            params = item.split(";")
            if name == "ratelimit-policy":
                value = _quota_number(params[0])  # draft-7: the item starts with the limit
                if value is not None:
                    found["limit"].append(value)
            for param in params:
                key, equals, text = param.partition("=")
                key = _QUOTA_KEYS.get(key.strip().lower(), "")
                value = _quota_number(text) if equals and key else None
                if value is not None:
                    found[key].append(_reset_seconds(value) if key == "reset" else value)
    if not any(found.values()):
        return None

    def pick(key: str, strictest: Callable[[list[float]], float]) -> Optional[float]:
        return strictest(found[key]) if found[key] else None

    return Quota(
        pick("limit", min), pick("remaining", min), pick("reset", max), pick("window", max)
    )


def rate_limit_headers(headers: Mapping[str, str]) -> str:
    """The answer's rate-limit headers as `Name: value; ...`, for logs ("" without any)."""
    return "; ".join(
        f"{name}: {value}" for name, value in headers.items() if _RATE_HEADER.match(str(name))
    )


def retry_after_seconds(response: requests.Response, cap: float = 120.0) -> Optional[float]:
    """The wait a `Retry-After` header asks for (seconds, or an HTTP date), between 0 and `cap`;
    None without a readable one."""
    value = response.headers.get("Retry-After", "").strip()
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
    if not math.isfinite(seconds):
        return None
    return min(max(seconds, 0.0), cap)


def backoff_seconds(
    attempt: int, base: float = 2.0, cap: float = 30.0, rng: Callable[[], float] = random.random
) -> float:
    """Exponential backoff with equal jitter: half of `base * 2**attempt` (at most `cap`) for
    sure, plus a random share of the other half."""
    ceiling = min(cap, base * 2.0 ** min(attempt, 64))
    return ceiling / 2 + rng() * ceiling / 2


def default_state_dir(base_url: str = DEFAULT_BASE_URL) -> str:
    """The queue's directory for this API host, in the system temp dir: every process of this
    user on this machine finds the same one."""
    host = urlparse(base_url).netloc or base_url
    return os.path.join(tempfile.gettempdir(), "mailtm-ratelimit-" + re.sub(r"[^\w.-]", "_", host))


def default_buckets() -> tuple[Bucket, ...]:
    """The two buckets, with $MAILTM_PER_SECOND and $MAILTM_PER_MINUTE overriding their limits."""
    buckets = []
    for env, bucket in zip((PER_SECOND_ENV, PER_MINUTE_ENV), DEFAULT_BUCKETS):
        text = os.environ.get(env, "").strip()
        if not text:
            buckets.append(bucket)
            continue
        try:
            buckets.append(Bucket(int(text), bucket.window))
        except ValueError:
            raise ValueError(f"{env} must be a whole number >= 1, got {text!r}") from None
    return tuple(buckets)


def message_text(message: dict) -> str:
    """A full message's plain text and HTML parts, as one string to search."""
    html = message.get("html") or []
    if isinstance(html, str):
        html = [html]
    return " ".join([message.get("text") or "", *html])


def account_id_from_token(token: str) -> Optional[str]:
    """The inbox's account id from its bearer token (a JWT whose payload names it as `id`, or as
    the Mercure topic `/accounts/{id}` it may subscribe to); None if it says neither. The token is
    only decoded, never verified."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = jsonlib.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("id"), str) and payload["id"]:
        return payload["id"]
    mercure = payload.get("mercure")
    topics = mercure.get("subscribe") if isinstance(mercure, dict) else None
    for topic in topics if isinstance(topics, list) else []:
        match = re.fullmatch(r"/accounts/([^/]+)", str(topic))
        if match:
            return match.group(1)
    return None


def _members(body: Any) -> list:
    """The items of a mail.tm collection: JSON-LD (`hydra:member`) or a plain JSON list."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        return body.get("hydra:member") or []
    return []


class _Budget:
    """A wait's deadline in time not spent in line: `left()` is `timeout` less the time since
    the start that the client did not spend waiting for a slot."""

    def __init__(self, client: "MailTmClient", timeout: float) -> None:
        self.client = client
        self.timeout = timeout
        self.started = client._clock()
        self.queued_at_start = client.stats.queued

    def queued(self) -> float:
        return self.client.stats.queued - self.queued_at_start

    def spent(self) -> float:
        return self.client._clock() - self.started - self.queued()

    def left(self) -> float:
        return max(self.timeout - self.spent(), 0.0)


class MailTmClient:
    """
    The mail.tm calls a test suite needs: domains, create account, token, list and read messages,
    `wait_for_message` and the live feed (`watch_inbox`). `request` makes any other call, through
    the same queue and retries.

    Without a `queue`, it makes a SharedQueue in `state_dir` (else $MAILTM_STATE_DIR, else
    `default_state_dir(base_url)`) with `buckets` (else `default_buckets()`), counting this run
    as `run_id` (else $MAILTM_RUN_ID). `live` (else $MAILTM_LIVE, default on) lets waits use the
    live feed. `guard` defaults to the process's GUARD. `clock` and `sleep` replace the real ones
    everywhere, for tests; `feed_factory` replaces the live feed's reader; `on_response(method,
    path, response)` sees every answer.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        buckets: Optional[Sequence[Bucket]] = None,
        state_dir: Optional[str] = None,
        queue: Optional[SharedQueue] = None,
        session: Optional[requests.Session] = None,
        timeout: float = 10.0,
        retry: Optional[RetryPolicy] = None,
        domain_ttl: float = 600.0,
        clock: Optional[Clock] = None,
        sleep: Optional[Sleep] = None,
        rng: Callable[[], float] = random.random,
        guard: Optional[CallGuard] = None,
        run_id: Optional[str] = None,
        live: Optional[bool] = None,
        mercure_url: str = DEFAULT_MERCURE_URL,
        feed_factory: Optional[Callable[[requests.Response], Any]] = None,
        on_response: Optional[Callable[[str, str, requests.Response], None]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if queue is None:
            queue = SharedQueue(
                state_dir or os.environ.get(STATE_DIR_ENV) or default_state_dir(self.base_url),
                buckets=default_buckets() if buckets is None else buckets,
                run_id=os.environ.get(RUN_ID_ENV, "") if run_id is None else run_id,
                clock=clock,
                sleep=sleep,
            )
        self.queue = queue
        self.session = session or requests.Session()
        self.timeout = timeout
        self.retry = retry or RetryPolicy()
        self.domain_ttl = domain_ttl
        self.guard = GUARD if guard is None else guard
        if live is None:
            live = os.environ.get(LIVE_ENV, "").strip().lower() not in {"0", "false", "no", "off"}
        self.live = live
        self.mercure_url = mercure_url
        self._feed_factory = feed_factory or ThreadedFeed
        self.on_response = on_response
        self.stats = CallStats()
        self._clock: Clock = clock or time.monotonic  # deadlines
        self._wall: Clock = clock or time.time  # cache times other processes read
        self._sleep: Sleep = sleep or time.sleep
        self._rng = rng
        self._domains: Optional[list[str]] = None
        self._domains_at = 0.0

    # --- every call -----------------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        token: Optional[str] = None,
        json: Any = None,
        params: Optional[dict] = None,
        idempotent: Optional[bool] = None,
        retry_429: Optional[bool] = None,
        url: Optional[str] = None,
        stream: bool = False,
        timeout: Any = None,
        headers: Optional[dict] = None,
    ) -> requests.Response:
        """
        One call to `path` under the base URL (or to `url`), through the guard and the queue,
        retried as the module docstring says. `idempotent` defaults to the method's nature;
        `retry_429` (retry a refusal) defaults to `idempotent`. Returns the last response: its
        status is the caller's to check. Raises MailTmRateLimited at the call ceiling.
        """
        method = method.upper()
        self.guard.check(method, path)
        if idempotent is None:
            idempotent = method in IDEMPOTENT_METHODS
        if retry_429 is None:
            retry_429 = idempotent
        kwargs: dict[str, Any] = {"timeout": self.timeout if timeout is None else timeout}
        if json is not None:
            kwargs["json"] = json
        if params:
            kwargs["params"] = params
        sent_headers = dict(headers or {})
        if token:
            sent_headers["Authorization"] = f"Bearer {token}"
        if sent_headers:
            kwargs["headers"] = sent_headers
        if stream:
            kwargs["stream"] = True
        target = url or f"{self.base_url}{path}"
        policy = self.retry
        started = self._clock()
        ticket: Optional[int] = None
        attempts = refusals = failures = 0
        queued = 0.0

        def gave_up(why: str) -> MailTmRateLimited:
            run = self.queue.counters()
            return MailTmRateLimited(
                f"mail.tm {why} {method} {path} after {self._clock() - started:.0f} s "
                f"({attempts} attempts, {refusals} answered 429, {queued:.0f} s in line); this "
                f"run so far: {run.requests} requests, {run.refused} refused. The ceiling is "
                f"{policy.call_ceiling:g} s per call."
            )

        while True:
            left = started + policy.call_ceiling - self._clock()
            if left <= 0:
                raise gave_up("still refused")
            try:
                slot = self.queue.acquire(ticket, max_wait=left)
            except RateLimitTimeout:
                raise gave_up("was still waiting in line for") from None
            ticket = slot.ticket
            queued += slot.waited
            self.stats.queued += slot.waited
            attempts += 1
            self.stats.requests += 1
            try:
                response = self.session.request(method, target, **kwargs)
            except (requests.ConnectionError, requests.Timeout):
                failures += 1
                if not idempotent or failures >= policy.max_attempts:
                    raise
                self._sleep(self._backoff(failures))
                continue
            if self.on_response is not None:
                self.on_response(method, path, response)
            if response.status_code == 429:
                refusals += 1
                self.stats.refused += 1
                refusal = self.queue.refused(slot, self._refusal_hint(response), self._pause_for)
                _log.warning(
                    "mail.tm answered 429 to %s %s: every process pauses %.1f s [%s] (429 #%d "
                    "this run, %s; run request #%d, %d sent in the last %g s; this call: attempt "
                    "%d, %.1f s in line)",
                    method,
                    path,
                    refusal.pause,
                    rate_limit_headers(response.headers) or "no rate-limit headers",
                    refusal.refused,
                    f"{refusal.strikes} in a row" if refusal.escalated else "same burst",
                    refusal.requests,
                    refusal.recent,
                    self.queue.longest_window,
                    attempts,
                    queued,
                )
                if not retry_429:
                    return response
                if stream:
                    response.close()
                continue  # the next acquire waits out the pause, in this call's place in line
            self._obey_quota(slot, response)
            if response.status_code in TRANSIENT_STATUSES and idempotent:
                failures += 1
                if failures < policy.max_attempts:
                    wait = retry_after_seconds(response, policy.retry_after_cap)
                    if stream:
                        response.close()
                    self._sleep(self._backoff(failures) if wait is None else wait)
                    continue
            return response

    def _backoff(self, attempt: int) -> float:
        policy = self.retry
        return backoff_seconds(attempt - 1, policy.backoff_base, policy.backoff_cap, self._rng)

    def _pause_for(self, strikes: int) -> float:
        """A 429 without a hint: the shared backoff on the 429s in a row."""
        return self._backoff(strikes)

    def _refusal_hint(self, response: requests.Response) -> Optional[float]:
        """How long a 429 asks everyone to wait: the strictest of `Retry-After` and the RateLimit
        reset (or, with a spent `remaining` and no reset, the policy's window); None without a
        hint."""
        policy = self.retry
        hints = []
        retry_after = retry_after_seconds(response, policy.retry_after_cap)
        if retry_after is not None:
            hints.append(retry_after)
        quota = ratelimit_quota(response.headers)
        if quota is not None:
            if quota.reset is not None:
                hints.append(min(quota.reset, policy.quota_pause_cap))
            elif quota.remaining is not None and quota.window is not None:
                hints.append(min(quota.window, policy.quota_pause_cap))
        return max(hints) if hints else None

    def _obey_quota(self, slot: Slot, response: requests.Response) -> None:
        """Hands the answer's RateLimit budget to the queue: at most `remaining - quota_reserve`
        more calls until the reset (else the policy's window, else a second, mail.tm's documented
        window), and notes that this call got through."""
        quota = ratelimit_quota(response.headers)
        if quota is None or quota.remaining is None:
            self.queue.answered(slot)
            return
        reset = next(s for s in (quota.reset, quota.window, 1.0) if s is not None)
        self.queue.answered(
            slot,
            quota.remaining - self.retry.quota_reserve,
            min(reset, self.retry.quota_pause_cap),
        )

    @staticmethod
    def _check(response: requests.Response, what: str, show_body: bool = True) -> None:
        if 200 <= response.status_code < 300:
            return
        detail = f" {response.text[:200]}" if show_body else ""
        raise MailTmError(f"mail.tm {what} failed: {response.status_code}{detail}")

    # --- the API ---------------------------------------------------------------------------------

    def domains(self) -> list[str]:
        """The names of the active domains (all listed ones if none is active). Cached for
        `domain_ttl` seconds, in this process and in the queue's state dir for the others."""
        now = self._wall()
        if self._domains is not None and 0 <= now - self._domains_at < self.domain_ttl:
            return list(self._domains)
        cached = self.queue.load_shared("domains")
        if (
            isinstance(cached, dict)
            and cached.get("base_url") == self.base_url
            and isinstance(cached.get("fetched_at"), (int, float))
            and 0 <= now - cached["fetched_at"] < self.domain_ttl
            and isinstance(cached.get("domains"), list)
            and cached["domains"]
            and all(isinstance(name, str) for name in cached["domains"])
        ):
            self._domains, self._domains_at = list(cached["domains"]), float(cached["fetched_at"])
            return list(self._domains)
        response = self.request("GET", "/domains")
        self._check(response, "domain list")
        listed = [d for d in _members(response.json()) if isinstance(d, dict) and d.get("domain")]
        names = [d["domain"] for d in listed if d.get("isActive")] or [d["domain"] for d in listed]
        if not names:
            raise MailTmError("mail.tm lists no domain")
        self._domains, self._domains_at = names, now
        self.queue.store_shared(
            "domains", {"base_url": self.base_url, "fetched_at": now, "domains": names}
        )
        return list(names)

    def domain(self) -> str:
        """The first active domain."""
        return self.domains()[0]

    def forget_domains(self) -> None:
        """Drops the cached domain list, in this process and in the state dir, so the next
        `domains()` asks mail.tm again. Mail.tm retires domains, and refuses an address at one it
        no longer serves (422) the way it refuses a taken one."""
        self._domains, self._domains_at = None, 0.0
        self.queue.store_shared("domains", None)

    def create_account(self, address: str, password: str) -> dict:
        """Creates the inbox `address` (at one of `domains()`). Returns the account (`id`,
        `address`, ...)."""
        response = self.request(
            "POST",
            "/accounts",
            json={"address": address, "password": password},
            idempotent=False,
            retry_429=True,  # a 429 created nothing: see the module docstring
        )
        if response.status_code == 422:
            # "Address already used": an earlier answer may have hidden a creation that went
            # through. The password is the caller's own, so if it opens the inbox, it is theirs.
            owned = self._account_if_ours(address, password)
            if owned is not None:
                return owned
            raise AddressTaken(f"mail.tm account creation failed: 422 {response.text[:200]}")
        if response.status_code != 201:
            raise MailTmError(
                f"mail.tm account creation failed: {response.status_code} {response.text[:200]}"
            )
        return response.json()

    def _account_if_ours(self, address: str, password: str) -> Optional[dict]:
        """The account `address`, if `password` signs in to it; otherwise None."""
        try:
            token = self.get_token(address, password)
        except MailTmError:
            return None
        me = self.request("GET", "/me", token=token)
        return me.json() if me.status_code == 200 else None

    def sign_in(self, address: str, password: str) -> Inbox:
        """The inbox's bearer token and account id (the live feed's topic). (Errors never show
        the response: it may hold a token.)"""
        response = self.request(
            "POST", "/token", json={"address": address, "password": password}, idempotent=True
        )
        self._check(response, "token request", show_body=False)
        body = response.json()
        token = body.get("token") if isinstance(body, dict) else None
        if not token:
            raise MailTmError("mail.tm answered the token request without a token")
        account_id = body.get("id") if isinstance(body.get("id"), str) else None
        return Inbox(token, account_id or account_id_from_token(token))

    def get_token(self, address: str, password: str) -> str:
        """A bearer token for the inbox."""
        return self.sign_in(address, password).token

    def list_messages(self, token: str, page: int = 1) -> list[dict]:
        """The inbox's message summaries, newest first (30 a page)."""
        params = {"page": page} if page != 1 else None
        response = self.request("GET", "/messages", token=token, params=params)
        self._check(response, "message list")
        return _members(response.json())

    def get_message(self, token: str, message_id: str) -> dict:
        """One full message (`text`, `html`, `subject`, `from`, ...)."""
        path = f"/messages/{quote(str(message_id), safe='')}"
        response = self.request("GET", path, token=token)
        self._check(response, "message read")
        return response.json()

    # --- waiting for a message -------------------------------------------------------------------

    def watch_inbox(self, token: str, account_id: Optional[str] = None) -> "InboxWatch":
        """Opens the inbox's live feed now (one queued call), for a wait that starts before the
        email is sent: `with mail.watch_inbox(token, id) as watch: send(); watch.wait_for(...)`.
        A feed that can't connect leaves the watch polling; it never raises for that. With the
        live feed off (`live`), it opens nothing and the watch polls."""
        watch = InboxWatch(self, token, account_id or account_id_from_token(token))
        if not self.live:
            watch.failure = "live feed off"
            return watch
        return watch.open()

    def wait_for_message(
        self,
        token: str,
        predicate: Callable[[dict], Any],
        *,
        timeout: float = 60.0,
        poll_interval: float = 5.0,
        initial_delay: float = 0.0,
        account_id: Optional[str] = None,
        live: Optional[bool] = None,
    ) -> dict:
        """
        The first full message for which `predicate(message)` is true (`message_text` gives its
        text); MailTmTimeout after `timeout` seconds of waiting, not counting time in line for a
        slot. Each message is read once.

        With the live feed (`live`, default the client's): one look at what is there already,
        then each new message is read as it arrives. Without it, or when it fails, it polls:
        after `initial_delay` seconds, then every `poll_interval`.
        """
        if self.live if live is None else live:
            watch = InboxWatch(self, token, account_id or account_id_from_token(token)).open()
            with watch:
                return watch.wait_for(
                    predicate,
                    timeout=timeout,
                    poll_interval=poll_interval,
                    initial_delay=initial_delay,
                    check_existing=True,
                )
        return self._poll(
            token,
            predicate,
            _Budget(self, timeout),
            poll_interval,
            initial_delay,
            set(),
            "polling (live feed off)",
        )

    def _look(self, token: str, predicate: Callable[[dict], Any], checked: set) -> Optional[dict]:
        """One look at the inbox: reads each message not read yet; the first match, or None."""
        for summary in self.list_messages(token):
            message_id = summary.get("id")
            if not message_id or message_id in checked:
                continue
            message = self.get_message(token, message_id)
            checked.add(message_id)
            if predicate(message):
                return message
        return None

    def _poll(
        self,
        token: str,
        predicate: Callable[[dict], Any],
        budget: _Budget,
        poll_interval: float,
        initial_delay: float,
        checked: set,
        how: str,
        looks: int = 0,
    ) -> dict:
        if initial_delay > 0:
            self._sleep(min(initial_delay, budget.left()))
        while True:
            looks += 1
            found = self._look(token, predicate, checked)
            if found is not None:
                self.stats.polled += 1
                _log.info(
                    "mail.tm message found by %s: look %d, %.1f s of waiting, %.1f s in line",
                    how,
                    looks,
                    budget.spent(),
                    budget.queued(),
                )
                return found
            left = budget.left()
            if left <= 0:
                raise self._timeout(budget, looks, checked, how)
            self._sleep(min(poll_interval, left))

    @staticmethod
    def _timeout(budget: _Budget, looks: int, checked: set, how: str) -> MailTmTimeout:
        return MailTmTimeout(
            f"No matching mail.tm message within {budget.timeout:g} s of waiting ({how}: "
            f"{looks} looks at the inbox, {len(checked)} messages read; another "
            f"{budget.queued():.1f} s went to waiting in line for mail.tm, not counted)"
        )


class InboxWatch:
    """
    One inbox's live feed (live.py), opened by `MailTmClient.watch_inbox`: `wait_for` reads each
    new message as the feed announces it. Without a feed (no account id, refused, unreachable) or
    after it drops, `wait_for` polls for the rest of its budget. Close it (or use `with`).
    """

    def __init__(self, client: MailTmClient, token: str, account_id: Optional[str]) -> None:
        self.client = client
        self.token = token
        self.account_id = account_id
        self.feed: Any = None
        self.failure = ""
        self.response: Optional[requests.Response] = None

    @property
    def connected(self) -> bool:
        return self.feed is not None

    def open(self) -> "InboxWatch":
        client = self.client
        if not self.account_id:
            self.failure = "no account id for the live feed"
            _log.warning("mail.tm live feed not opened (%s): polling", self.failure)
            return self
        try:
            response = client.request(
                "GET",
                MERCURE_PATH,
                url=client.mercure_url,
                params={"topic": f"/accounts/{self.account_id}"},
                token=self.token,
                headers={"Accept": "text/event-stream"},
                stream=True,
                timeout=(client.timeout, READ_TIMEOUT),
            )
        except MailTmRateLimited:
            raise
        except (requests.RequestException, MailTmError) as error:
            self.failure = f"{type(error).__name__}: {error}"
            _log.warning("mail.tm live feed failed to connect (%s): polling", self.failure)
            return self
        if response.status_code != 200:
            self.failure = f"HTTP {response.status_code}"
            response.close()
            _log.warning("mail.tm live feed failed to connect (%s): polling", self.failure)
            return self
        self.response = response
        self.feed = client._feed_factory(response)
        _log.info("mail.tm live feed connected for inbox %s", self.account_id)
        return self

    def wait_for(
        self,
        predicate: Callable[[dict], Any],
        *,
        timeout: float,
        poll_interval: float,
        initial_delay: float = 0.0,
        check_existing: bool = True,
    ) -> dict:
        """
        The first new message for which `predicate(message)` is true, within `timeout` seconds
        of waiting (time in line for a slot not counted). `check_existing`: first look at what
        the inbox holds already (needed when the email may have come before the feed opened).
        `initial_delay` and `poll_interval` are for polling, when there is no feed.
        """
        client = self.client
        budget = _Budget(client, timeout)
        checked: set = set()
        if self.feed is None:
            how = f"polling ({self.failure})"
            return client._poll(
                self.token, predicate, budget, poll_interval, initial_delay, checked, how
            )
        looks = 0
        if check_existing:
            looks += 1
            found = client._look(self.token, predicate, checked)
            if found is not None:
                client.stats.live += 1
                _log.info("mail.tm message was in the inbox already when the live feed opened")
                return found
        quiet_since = budget.spent()
        while True:
            left = budget.left()
            if left <= 0:
                raise client._timeout(budget, looks, checked, "live feed")
            quiet = budget.spent() - quiet_since
            if quiet >= SAFETY_LOOK:
                # Nothing matching on the feed for a while: one look, in case an event was missed.
                looks += 1
                quiet_since = budget.spent()
                found = client._look(self.token, predicate, checked)
                if found is not None:
                    client.stats.polled += 1
                    _log.warning(
                        "mail.tm message found by a safety look, not announced on the live feed "
                        "(%.1f s of waiting)",
                        budget.spent(),
                    )
                    return found
                continue
            item = self.feed.next(min(left, SAFETY_LOOK - quiet))
            if item is None:
                continue
            if isinstance(item, Ended):
                _log.warning(
                    "mail.tm live feed dropped after %.1f s of waiting (%s): polling for the "
                    "remaining %.1f s",
                    budget.spent(),
                    item.reason,
                    budget.left(),
                )
                return client._poll(
                    self.token,
                    predicate,
                    budget,
                    poll_interval,
                    0.0,
                    checked,
                    "polling after the live feed dropped",
                    looks,
                )
            message_id = item.get("id")
            if not message_id or message_id in checked:
                continue
            try:
                message = client.get_message(self.token, message_id)
            except MailTmRateLimited:
                raise
            except MailTmError as error:
                _log.warning(
                    "mail.tm could not read message %s the live feed announced (%s): polling",
                    message_id,
                    error,
                )
                return client._poll(
                    self.token,
                    predicate,
                    budget,
                    poll_interval,
                    0.0,
                    checked,
                    "polling after a failed read",
                    looks,
                )
            checked.add(message_id)
            if predicate(message):
                client.stats.live += 1
                _log.info(
                    "mail.tm message arrived on the live feed after %.1f s of waiting "
                    "(%.1f s in line)",
                    budget.spent(),
                    budget.queued(),
                )
                return message

    def close(self) -> None:
        if self.feed is not None:
            self.feed.close()
            self.feed = None
        elif self.response is not None:
            self.response.close()
        self.response = None

    def __enter__(self) -> "InboxWatch":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
