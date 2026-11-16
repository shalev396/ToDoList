"""
A minimal mail.tm API client (https://docs.mail.tm/). Every HTTP call goes through a
SharedRateLimiter, so all the processes on this machine stay under mail.tm's limit together.

Retries:
- A 429 pushes the shared bucket forward (`Retry-After`, else an exponential backoff with jitter),
  so every process pauses, not just the one that was refused. The call is then retried if it is
  idempotent (GET, DELETE; POST /token, which only issues a token), or account creation: a 429 is
  a refusal, so no account exists yet and sending it again cannot make a second one.
- A dropped connection, a timeout or a 502/503/504 is retried only for idempotent calls. Account
  creation is not retried then: the account may exist already, and a retry would turn a clear
  error into "address already used".
- Nothing is retried more than `max_attempts` calls in all, or past `max_total_wait` seconds of
  waiting; then the last answer is returned (or the last error raised).

RateLimit headers: every answer's IETF RateLimit headers are read (`ratelimit_quota`). When they
say the quota is spent (`remaining` at or below `quota_reserve`), every process pauses until it
resets, so the next call waits instead of drawing a 429. The headers don't say which requests a
quota counts, so the pause covers the whole API host: the simplest choice that never under-counts.
"""
from __future__ import annotations

import math
import os
import random
import re
import tempfile
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping, NamedTuple, Optional
from urllib.parse import quote, urlparse

import requests

from .ratelimit import DEFAULT_BURST, DEFAULT_RATE, Clock, SharedRateLimiter, Sleep

DEFAULT_BASE_URL = "https://api.mail.tm"
# https://docs.mail.tm/: "The general quota limit is 8 queries per second (QPS) per IP address."
DOCUMENTED_LIMIT = 8
# Environment overrides, read when the matching constructor argument is not given.
RATE_ENV = "MAILTM_RATE"
STATE_DIR_ENV = "MAILTM_STATE_DIR"

IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})
TRANSIENT_STATUSES = frozenset({502, 503, 504})


class MailTmError(RuntimeError):
    """mail.tm answered with an error, or without what was asked for."""


class MailTmTimeout(MailTmError):
    """No message matched before the deadline."""


@dataclass(frozen=True)
class RetryPolicy:
    """At most `max_attempts` calls and `max_total_wait` seconds of waiting per request. Waits
    are what `Retry-After` asks for (at most `retry_after_cap`), else 1-2 s, 2-4 s, 4-8 s, ...
    (`backoff_base` doubling, each at most `backoff_cap`).

    RateLimit headers: once `remaining` is `quota_reserve` or less, every process pauses until
    the quota resets, for at most `quota_pause_cap` seconds."""

    max_attempts: int = 7
    max_total_wait: float = 120.0
    backoff_base: float = 2.0
    backoff_cap: float = 30.0
    retry_after_cap: float = 60.0
    quota_reserve: int = 1
    quota_pause_cap: float = 120.0


class Quota(NamedTuple):
    """What an answer's RateLimit headers say; None where they say nothing usable."""

    limit: Optional[float]  # requests in the window
    remaining: Optional[float]  # requests left in it
    reset: Optional[float]  # seconds until it refills
    window: Optional[float]  # the policy's window, in seconds


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


def _quota_number(text: str) -> Optional[float]:
    """A finite, non-negative number, or None (`nan`, `inf`, `-4`, `soon`, ...)."""
    try:
        value = float(text.strip().strip('"'))
    except ValueError:
        return None
    return value if math.isfinite(value) and value >= 0 else None


def ratelimit_quota(headers: Mapping[str, str]) -> Optional[Quota]:
    """
    The quota an answer's IETF RateLimit headers describe, in any letter case: `RateLimit`
    (draft-7 `limit=10, remaining=0, reset=42`, or the later `"name";r=0;t=42`), the older
    `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`, and `RateLimit-Policy`
    (`10; w=60`, or `"name";q=10;w=60`). Where several quotas are given, the strictest wins: the
    lowest limit and remaining, the longest reset and window. Malformed values are skipped; None
    when nothing usable is left.
    """
    lowered = {str(name).lower(): str(value) for name, value in headers.items()}
    found: dict[str, list[float]] = {"limit": [], "remaining": [], "reset": [], "window": []}
    for key in ("limit", "remaining", "reset"):
        for item in lowered.get(f"ratelimit-{key}", "").split(","):
            value = _quota_number(item.split(";")[0])  # an old draft allowed "10, 10;w=1"
            if value is not None:
                found[key].append(value)
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
                    found[key].append(value)
    if not any(found.values()):
        return None

    def pick(key: str, strictest: Callable[[list[float]], float]) -> Optional[float]:
        return strictest(found[key]) if found[key] else None

    return Quota(pick("limit", min), pick("remaining", min), pick("reset", max), pick("window", max))


def retry_after_seconds(response: requests.Response, cap: float = 60.0) -> Optional[float]:
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
    """The limiter's directory for this API host, in the system temp dir: every process of this
    user on this machine finds the same one."""
    host = urlparse(base_url).netloc or base_url
    return os.path.join(tempfile.gettempdir(), "mailtm-ratelimit-" + re.sub(r"[^\w.-]", "_", host))


def message_text(message: dict) -> str:
    """A full message's plain text and HTML parts, as one string to search."""
    html = message.get("html") or []
    if isinstance(html, str):
        html = [html]
    return " ".join([message.get("text") or "", *html])


def _members(body: Any) -> list:
    """The items of a mail.tm collection: JSON-LD (`hydra:member`) or a plain JSON list."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        return body.get("hydra:member") or []
    return []


class MailTmClient:
    """
    The mail.tm calls a test suite needs: domains, create account, token, list and read messages,
    and `wait_for_message`. `request` makes any other call, through the same limiter and retries.

    Without a `limiter`, it makes a SharedRateLimiter in `state_dir` (else $MAILTM_STATE_DIR, else
    `default_state_dir(base_url)`) at `rate` requests a second (else $MAILTM_RATE, else 6).
    `clock` and `sleep` replace the real ones everywhere, for tests.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        rate: Optional[float] = None,
        burst: Optional[int] = None,
        state_dir: Optional[str] = None,
        limiter: Optional[SharedRateLimiter] = None,
        session: Optional[requests.Session] = None,
        timeout: float = 10.0,
        retry: Optional[RetryPolicy] = None,
        domain_ttl: float = 600.0,
        clock: Optional[Clock] = None,
        sleep: Optional[Sleep] = None,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if limiter is None:
            if rate is None:
                env_rate = os.environ.get(RATE_ENV, "").strip()
                try:
                    rate = float(env_rate) if env_rate else DEFAULT_RATE
                except ValueError:
                    raise ValueError(f"{RATE_ENV} must be a number, got {env_rate!r}") from None
            limiter = SharedRateLimiter(
                state_dir or os.environ.get(STATE_DIR_ENV) or default_state_dir(self.base_url),
                rate=rate,
                burst=DEFAULT_BURST if burst is None else burst,
                clock=clock,
                sleep=sleep,
            )
        self.limiter = limiter
        self.session = session or requests.Session()
        self.timeout = timeout
        self.retry = retry or RetryPolicy()
        self.domain_ttl = domain_ttl
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
    ) -> requests.Response:
        """
        One call to `path` under the base URL, through the limiter, retried as the module
        docstring says. `idempotent` defaults to the method's nature; `retry_429` (retry a
        refusal) defaults to `idempotent`. Returns the last response: its status is the
        caller's to check.
        """
        method = method.upper()
        if idempotent is None:
            idempotent = method in IDEMPOTENT_METHODS
        if retry_429 is None:
            retry_429 = idempotent
        kwargs: dict[str, Any] = {"timeout": self.timeout}
        if json is not None:
            kwargs["json"] = json
        if params:
            kwargs["params"] = params
        if token:
            kwargs["headers"] = {"Authorization": f"Bearer {token}"}
        url = f"{self.base_url}{path}"
        policy = self.retry
        waited = 0.0
        attempt = 0
        while True:
            attempt += 1
            last_try = attempt >= policy.max_attempts
            self.limiter.acquire()
            try:
                response = self.session.request(method, url, **kwargs)
            except (requests.ConnectionError, requests.Timeout):
                wait = self._backoff(attempt)
                if not idempotent or last_try or waited + wait > policy.max_total_wait:
                    raise
                self._sleep(wait)
                waited += wait
                continue
            spent = self._quota_pause(response)
            if response.status_code == 429:
                wait = retry_after_seconds(response, policy.retry_after_cap)
                if wait is None:
                    wait = spent if spent is not None else self._backoff(attempt)
                wait = max(wait, spent or 0.0)
                # Every process sharing the limiter waits this out, not just this one.
                self.limiter.penalize(wait)
                if not retry_429 or last_try or waited + wait > policy.max_total_wait:
                    return response
                waited += wait  # the next acquire() sleeps through the pause
                continue
            if spent:
                self.limiter.penalize(spent)  # the next call, from any process, waits for the reset
            if response.status_code in TRANSIENT_STATUSES and idempotent and not last_try:
                wait = retry_after_seconds(response, policy.retry_after_cap)
                if wait is None:
                    wait = self._backoff(attempt)
                if waited + wait <= policy.max_total_wait:
                    self._sleep(wait)
                    waited += wait
                    continue
            return response

    def _backoff(self, attempt: int) -> float:
        policy = self.retry
        return backoff_seconds(attempt - 1, policy.backoff_base, policy.backoff_cap, self._rng)

    def _quota_pause(self, response: requests.Response) -> Optional[float]:
        """How long everyone should wait when the RateLimit headers say the quota is spent: until
        the reset, else the policy's window, else a second (mail.tm's documented window); at most
        `quota_pause_cap`. None while the quota lasts, or without such headers."""
        quota = ratelimit_quota(response.headers)
        if quota is None or quota.remaining is None:
            return None
        if quota.remaining > self.retry.quota_reserve:
            return None
        wait = next(s for s in (quota.reset, quota.window, 1.0) if s is not None)
        return min(wait, self.retry.quota_pause_cap)

    @staticmethod
    def _check(response: requests.Response, what: str, show_body: bool = True) -> None:
        if 200 <= response.status_code < 300:
            return
        detail = f" {response.text[:200]}" if show_body else ""
        raise MailTmError(f"mail.tm {what} failed: {response.status_code}{detail}")

    # --- the API ---------------------------------------------------------------------------------

    def domains(self) -> list[str]:
        """The names of the active domains (all listed ones if none is active). Cached for
        `domain_ttl` seconds, in this process and in the limiter's state dir for the others."""
        now = self._wall()
        if self._domains is not None and 0 <= now - self._domains_at < self.domain_ttl:
            return list(self._domains)
        cached = self.limiter.load_shared("domains")
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
        self.limiter.store_shared(
            "domains", {"base_url": self.base_url, "fetched_at": now, "domains": names}
        )
        return list(names)

    def domain(self) -> str:
        """The first active domain."""
        return self.domains()[0]

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
        if response.status_code != 201:
            raise MailTmError(
                f"mail.tm account creation failed: {response.status_code} {response.text[:200]}"
            )
        return response.json()

    def get_token(self, address: str, password: str) -> str:
        """A bearer token for the inbox. (Errors never show the response: it may hold one.)"""
        response = self.request(
            "POST", "/token", json={"address": address, "password": password}, idempotent=True
        )
        self._check(response, "token request", show_body=False)
        token = response.json().get("token")
        if not token:
            raise MailTmError("mail.tm answered the token request without a token")
        return token

    def list_messages(self, token: str, page: int = 1) -> list[dict]:
        """The inbox's message summaries, newest first (30 a page)."""
        response = self.request(
            "GET", "/messages", token=token, params={"page": page} if page != 1 else None
        )
        self._check(response, "message list")
        return _members(response.json())

    def get_message(self, token: str, message_id: str) -> dict:
        """One full message (`text`, `html`, `subject`, `from`, ...)."""
        response = self.request("GET", f"/messages/{quote(str(message_id), safe='')}", token=token)
        self._check(response, "message read")
        return response.json()

    def wait_for_message(
        self,
        token: str,
        predicate: Callable[[dict], Any],
        *,
        timeout: float = 60.0,
        poll_interval: float = 5.0,
        initial_delay: float = 0.0,
    ) -> dict:
        """
        The first full message for which `predicate(message)` is true (`message_text` gives its
        text). Looks after `initial_delay` seconds, then every `poll_interval`, until `timeout`
        seconds after the call; raises MailTmTimeout after that. Each message is fetched once.
        """
        deadline = self._clock() + timeout
        if initial_delay > 0:
            self._sleep(min(initial_delay, timeout))
        checked: set[str] = set()
        while True:
            for summary in self.list_messages(token):
                message_id = summary.get("id")
                if not message_id or message_id in checked:
                    continue
                message = self.get_message(token, message_id)
                checked.add(message_id)
                if predicate(message):
                    return message
            left = deadline - self._clock()
            if left <= 0:
                raise MailTmTimeout(
                    f"No matching mail.tm message within {timeout:g} s ({len(checked)} checked)"
                )
            self._sleep(min(poll_interval, left))
