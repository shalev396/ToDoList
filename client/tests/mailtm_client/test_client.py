"""
The mail.tm client (client.py), offline: its HTTP session is a stub (or, for the multi-process
test, a local server), its limiter a real one in the test's own directory on a fake clock.
"""
from __future__ import annotations

import http.server
import json
import math
import os
import tempfile
import threading
import time
from email.utils import formatdate
from typing import Any, NamedTuple

import pytest
import requests

from ._testing import (
    PACKAGE_DIR,
    PACKAGE_NAME,
    FakeClock,
    assert_conforms,
    busiest_second,
    spawn,
    start_together,
)
from .client import (
    DOCUMENTED_LIMIT,
    RATE_ENV,
    STATE_DIR_ENV,
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
from .ratelimit import DEFAULT_BURST, DEFAULT_RATE, SharedRateLimiter

BASE = "https://mail.test"


def answer(
    status: int = 200, body: Any = None, retry_after: Any = None, headers: Any = None
) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(body if body is not None else {}).encode()
    if retry_after is not None:
        response.headers["Retry-After"] = str(retry_after)
    response.headers.update(headers or {})
    return response


class Call(NamedTuple):
    at: float
    method: str
    url: str
    kwargs: dict


class StubSession:
    """Answers with `answers` in order (an exception is raised instead), and records each call
    with the fake time it was sent."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.answers: list = []
        self.calls: list[Call] = []

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        self.calls.append(Call(self.clock(), method, url, kwargs))
        result = self.answers.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def gaps(self) -> list[float]:
        return [later.at - earlier.at for earlier, later in zip(self.calls, self.calls[1:])]


class CountingLimiter(SharedRateLimiter):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.acquired = 0

    def acquire(self, max_wait: Any = None) -> float:
        self.acquired += 1
        return super().acquire(max_wait=max_wait)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def state_dir(tmp_path) -> str:
    return str(tmp_path / "state")


@pytest.fixture
def make(clock, state_dir):
    """`make(**settings)`: a client on a stub session, sharing the test's state dir and clock.
    Two of them are two processes."""

    def build(**settings: Any) -> MailTmClient:
        settings.setdefault("limiter", CountingLimiter(state_dir, clock=clock, sleep=clock.sleep))
        settings.setdefault("session", StubSession(clock))
        return MailTmClient(BASE, clock=clock, sleep=clock.sleep, **settings)

    return build


@pytest.fixture
def mail(make) -> MailTmClient:
    return make()


DOMAINS = {
    "hydra:member": [
        {"domain": "old.test", "isActive": False},
        {"domain": "mail.test", "isActive": True},
    ]
}


# --- every call goes through the limiter --------------------------------------------------------


def test_every_call_goes_through_the_limiter(mail):
    mail.session.answers = [
        answer(200, DOMAINS),
        answer(201, {"id": "a1", "address": "x@mail.test"}),
        answer(200, {"token": "t"}),
        answer(200, {"hydra:member": [{"id": "m1"}]}),
        answer(200, {"id": "m1", "text": "hi"}),
        answer(204),
    ]
    mail.domain()
    mail.create_account("x@mail.test", "pw")
    token = mail.get_token("x@mail.test", "pw")
    mail.list_messages(token)
    mail.get_message(token, "m1")
    mail.request("DELETE", "/accounts/a1", token=token)
    assert mail.limiter.acquired == len(mail.session.calls) == 6


def test_calls_are_spaced_by_the_shared_bucket(make, clock):
    """Two "processes" calling at once share the defaults: a burst of 2, then 1/6 s apart."""
    first, second = make(), make(session=StubSession(clock))
    first.session.answers = [answer(200, {}) for _ in range(3)]
    second.session.answers = [answer(200, {}) for _ in range(3)]
    for _ in range(3):
        first.request("GET", "/me")
        second.request("GET", "/me")
    times = sorted(call.at for call in first.session.calls + second.session.calls)
    offsets = [clock.since_start(at) for at in times]
    assert offsets == pytest.approx([0, 0, 1 / 6, 2 / 6, 3 / 6, 4 / 6], abs=1e-6)


# --- 429 -----------------------------------------------------------------------------------------


def test_a_429_is_retried_after_a_jittered_backoff(mail):
    mail.session.answers = [answer(429), answer(429), answer(200)]
    assert mail.request("GET", "/messages").status_code == 200
    first, second = mail.session.gaps()
    assert 1.0 <= first <= 2.0
    assert 2.0 <= second <= 4.0


def test_retry_after_is_honoured_in_seconds(mail):
    mail.session.answers = [answer(429, retry_after=3), answer(201, {"id": "a"})]
    mail.create_account("x@mail.test", "pw")
    assert mail.session.gaps() == pytest.approx([3.0])


def test_retry_after_is_honoured_as_an_http_date(mail):
    in_ten_seconds = formatdate(time.time() + 10, usegmt=True)
    mail.session.answers = [answer(429, retry_after=in_ten_seconds), answer(200, DOMAINS)]
    mail.domains()
    assert 8.0 <= mail.session.gaps()[0] <= 10.0


def test_retry_after_is_capped(mail):
    mail.session.answers = [answer(429, retry_after=3600), answer(200)]
    mail.request("GET", "/messages")
    assert mail.session.gaps() == pytest.approx([RetryPolicy().retry_after_cap])


def test_a_429_pauses_every_process_sharing_the_state_dir(make, clock, state_dir):
    refused = make()
    refused.session.answers = [answer(429, retry_after=5)]
    refused.request("PATCH", "/messages/m1", json={"seen": True})  # not retried: one 429
    other_process = SharedRateLimiter(state_dir, clock=clock, sleep=clock.sleep)
    assert clock.since_start(other_process.acquire()) == pytest.approx(5)


def test_gives_up_after_max_attempts_with_the_last_429(mail):
    policy = mail.retry
    mail.session.answers = [answer(429) for _ in range(policy.max_attempts)]
    assert mail.request("GET", "/messages").status_code == 429
    assert len(mail.session.calls) == policy.max_attempts
    assert sum(mail.session.gaps()) <= policy.max_total_wait


def test_never_waits_more_than_the_total_cap(mail):
    mail.session.answers = [answer(429, retry_after=60) for _ in range(7)]
    assert mail.request("GET", "/messages").status_code == 429
    assert mail.session.gaps() == pytest.approx([60.0, 60.0])


def test_a_429_is_not_retried_for_a_call_that_is_not_safe_to_repeat(mail):
    mail.session.answers = [answer(429, retry_after=1)]
    assert mail.request("PATCH", "/messages/m1", json={"seen": True}).status_code == 429
    assert len(mail.session.calls) == 1


def test_account_creation_survives_a_429(mail):
    mail.session.answers = [answer(429, retry_after=1), answer(201, {"id": "a1"})]
    assert mail.create_account("x@mail.test", "pw") == {"id": "a1"}
    assert len(mail.session.calls) == 2


# --- other failures ------------------------------------------------------------------------------


def test_other_errors_are_not_retried(mail):
    mail.session.answers = [answer(500)]
    assert mail.request("GET", "/messages").status_code == 500
    mail.session.answers = [answer(404)]
    assert mail.request("GET", "/messages/x").status_code == 404
    assert len(mail.session.calls) == 2


def test_transient_failures_are_retried_for_idempotent_calls(mail):
    mail.session.answers = [
        answer(503),
        requests.ConnectionError("reset"),
        requests.ReadTimeout("slow"),
        answer(200, {"token": "t"}),
    ]
    assert mail.get_token("x@mail.test", "pw") == "t"  # POST /token only issues a token
    assert len(mail.session.calls) == 4


def test_account_creation_is_not_retried_after_a_transient_failure(mail):
    """The account may exist already: a second POST would only answer "address already used"."""
    mail.session.answers = [requests.ReadTimeout("slow")]
    with pytest.raises(requests.ReadTimeout):
        mail.create_account("x@mail.test", "pw")
    mail.session.answers = [answer(503)]
    with pytest.raises(MailTmError, match="503"):
        mail.create_account("x@mail.test", "pw")
    assert len(mail.session.calls) == 2


def test_a_connection_that_keeps_failing_raises_after_max_attempts(make):
    mail = make(retry=RetryPolicy(max_attempts=3))
    mail.session.answers = [requests.ConnectionError("down") for _ in range(3)]
    with pytest.raises(requests.ConnectionError):
        mail.list_messages("t")
    assert len(mail.session.calls) == 3


# --- backoff and Retry-After ---------------------------------------------------------------------


def test_backoff_doubles_between_its_bounds_and_stays_under_its_cap():
    for attempt in range(12):
        ceiling = min(30.0, 2.0 * 2**attempt)
        assert backoff_seconds(attempt, rng=lambda: 0.0) == ceiling / 2
        assert backoff_seconds(attempt, rng=lambda: 1.0) == ceiling
        assert ceiling / 2 <= backoff_seconds(attempt) <= ceiling <= 30.0
    assert backoff_seconds(10_000) <= 30.0  # no overflow on a silly attempt count


def test_the_worst_case_retry_sequence_fits_the_policy():
    policy = RetryPolicy()
    worst = sum(
        backoff_seconds(attempt, policy.backoff_base, policy.backoff_cap, rng=lambda: 1.0)
        for attempt in range(policy.max_attempts - 1)
    )
    assert worst <= policy.max_total_wait


@pytest.mark.parametrize(
    "header, expected",
    [("", None), ("soon", None), ("nan", None), ("-5", 0.0), ("1.5", 1.5), ("120", 60.0)],
)
def test_retry_after_parsing(header, expected):
    response = answer(429)
    if header:
        response.headers["Retry-After"] = header
    assert retry_after_seconds(response, cap=60.0) == expected


def test_a_retry_after_date_in_the_past_means_now():
    response = answer(429, retry_after=formatdate(time.time() - 30, usegmt=True))
    assert retry_after_seconds(response) == 0.0


# --- RateLimit headers ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers, expected",
    [
        ({"RateLimit": "limit=10, remaining=0, reset=42"}, Quota(10, 0, 42, None)),  # draft-7
        (
            {"ratelimit-limit": "10", "RATELIMIT-REMAINING": "3", "RateLimit-Reset": "7"},
            Quota(10, 3, 7, None),
        ),
        ({"RateLimit-Policy": "10; w=60"}, Quota(10, None, None, 60)),  # what mail.tm sends
        (
            {"RateLimit": '"default";r=0;t=42', "RateLimit-Policy": '"default";q=10;w=60'},
            Quota(10, 0, 42, 60),
        ),
        (  # several quotas: the strictest of each
            {
                "RateLimit-Policy": "10;w=1, 100;w=60",
                "RateLimit-Remaining": "5, 0",
                "RateLimit-Reset": "1, 30",
            },
            Quota(10, 0, 30, 60),
        ),
        ({"RateLimit-Remaining": "0", "RateLimit-Reset": "later"}, Quota(None, 0, None, None)),
        ({"RateLimit": "limit=ten, remaining=nan, reset=-4", "RateLimit-Reset": "inf"}, None),
        ({"RateLimit-Policy": "w=soon; q=; =5", "RateLimit": ";;,,"}, None),
        ({"Content-Type": "application/json"}, None),
    ],
)
def test_ratelimit_headers_are_read_in_every_form(headers, expected):
    assert ratelimit_quota(headers) == expected
    assert ratelimit_quota(answer(200, headers=headers).headers) == expected


def test_a_spent_quota_pauses_every_process_before_the_next_call(make, clock, state_dir):
    mail = make()
    spent = {"RateLimit": "limit=10, remaining=0, reset=42"}
    mail.session.answers = [answer(200, headers=spent), answer(200)]
    mail.request("GET", "/messages")
    other_process = SharedRateLimiter(state_dir, clock=clock, sleep=clock.sleep)
    assert clock.since_start(other_process.acquire()) == pytest.approx(42)
    mail.request("GET", "/messages")
    assert mail.session.gaps()[0] >= 42  # waited before the call, no 429 needed
    assert len(mail.session.calls) == 2


@pytest.mark.parametrize("remaining, paused", [(0, True), (1, True), (2, False)])
def test_the_pause_starts_at_the_reserve(make, clock, state_dir, remaining, paused):
    mail = make()
    quota = {"RateLimit-Remaining": str(remaining), "RateLimit-Reset": "9"}
    mail.session.answers = [answer(200, headers=quota)]
    mail.request("GET", "/messages")
    slot = SharedRateLimiter(state_dir, clock=clock, sleep=clock.sleep).acquire()
    assert (clock.since_start(slot) >= 9) is paused


@pytest.mark.parametrize(
    "headers, pause",
    [
        ({"RateLimit": "remaining=0", "RateLimit-Policy": "10; w=60"}, 60),  # the window
        ({"RateLimit-Remaining": "0"}, 1),  # nothing else to go on: a second
        ({"RateLimit-Remaining": "0", "RateLimit-Reset": "nan"}, 1),  # a bad reset is ignored
        ({"RateLimit-Remaining": "0", "RateLimit-Reset": "999999"}, 120),  # capped
    ],
)
def test_how_long_a_spent_quota_pauses(make, clock, state_dir, headers, pause):
    mail = make()
    mail.session.answers = [answer(200, headers=headers)]
    mail.request("GET", "/messages")
    slot = SharedRateLimiter(state_dir, clock=clock, sleep=clock.sleep).acquire()
    assert clock.since_start(slot) == pytest.approx(pause)


def test_the_quota_pause_cap_is_a_setting(make, clock, state_dir):
    mail = make(retry=RetryPolicy(quota_pause_cap=30))
    mail.session.answers = [answer(200, headers={"RateLimit": "remaining=0, reset=3600"})]
    mail.request("GET", "/messages")
    slot = SharedRateLimiter(state_dir, clock=clock, sleep=clock.sleep).acquire()
    assert clock.since_start(slot) == pytest.approx(30)


def test_malformed_rate_limit_headers_neither_raise_nor_pause(mail):
    junk = {
        "RateLimit": "remaining=lots, reset=soon",
        "RateLimit-Remaining": "nan",
        "RateLimit-Reset": "-1",
        "RateLimit-Policy": "w=forever",
    }
    mail.session.answers = [answer(200, headers=junk), answer(429, retry_after="nan"), answer(200)]
    mail.request("GET", "/messages")
    assert mail.request("GET", "/messages").status_code == 200  # a `nan` Retry-After: backoff
    no_pause, backoff = mail.session.gaps()
    assert no_pause == pytest.approx(0)
    assert 1.0 <= backoff <= 2.0


def test_a_429_with_a_spent_quota_and_no_retry_after_waits_for_the_reset(mail):
    spent = {"RateLimit-Remaining": "0", "RateLimit-Reset": "7"}
    mail.session.answers = [answer(429, headers=spent), answer(200)]
    assert mail.request("GET", "/messages").status_code == 200
    assert mail.session.gaps() == pytest.approx([7.0])


# --- the API -------------------------------------------------------------------------------------


def test_domains_prefers_active_ones_and_is_looked_up_once(mail):
    mail.session.answers = [answer(200, DOMAINS)]
    assert mail.domain() == "mail.test"
    assert mail.domains() == ["mail.test"]
    assert len(mail.session.calls) == 1


def test_domains_fall_back_to_listed_ones_and_read_plain_json(mail):
    mail.session.answers = [answer(200, [{"domain": "only.test", "isActive": False}])]
    assert mail.domains() == ["only.test"]


def test_domains_are_shared_with_other_processes_through_the_state_dir(make):
    first = make()
    first.session.answers = [answer(200, DOMAINS)]
    first.domains()
    second = make()  # no answers queued: a call would fail
    assert second.domain() == "mail.test"
    assert second.session.calls == []


def test_the_domain_cache_expires(make, clock):
    first = make(domain_ttl=600)
    renamed = {"hydra:member": [{"domain": "new.test", "isActive": True}]}
    first.session.answers = [answer(200, DOMAINS), answer(200, renamed)]
    first.domains()
    clock.advance(601)
    assert first.domains() == ["new.test"]
    assert len(first.session.calls) == 2


def test_a_cache_for_another_api_is_ignored(make, clock, state_dir):
    SharedRateLimiter(state_dir).store_shared(
        "domains", {"base_url": "https://other.test", "fetched_at": clock.now, "domains": ["x"]}
    )
    mail = make()
    mail.session.answers = [answer(200, DOMAINS)]
    assert mail.domain() == "mail.test"


def test_no_domain_is_an_error(mail):
    mail.session.answers = [answer(200, {"hydra:member": []})]
    with pytest.raises(MailTmError):
        mail.domain()


def test_create_account_sends_the_credentials_and_reports_a_refusal(mail):
    mail.session.answers = [answer(201, {"id": "a1"}), answer(422, {"detail": "address: used"})]
    mail.create_account("x@mail.test", "secret-pw")
    call = mail.session.calls[0]
    assert (call.method, call.url) == ("POST", f"{BASE}/accounts")
    assert call.kwargs["json"] == {"address": "x@mail.test", "password": "secret-pw"}
    with pytest.raises(MailTmError, match="422") as refused:
        mail.create_account("x@mail.test", "secret-pw")
    assert "secret-pw" not in str(refused.value)


def test_a_token_never_shows_up_in_an_error(mail):
    mail.session.answers = [answer(401, {"token": "leaked?"}), answer(200, {})]
    with pytest.raises(MailTmError, match="401") as refused:
        mail.get_token("x@mail.test", "secret-pw")
    assert "leaked" not in str(refused.value) and "secret-pw" not in str(refused.value)
    with pytest.raises(MailTmError, match="without a token"):
        mail.get_token("x@mail.test", "secret-pw")


def test_messages_are_read_with_the_bearer_token(mail):
    mail.session.answers = [
        answer(200, {"hydra:member": [{"id": "m/1"}]}),
        answer(200, {"id": "m/1", "text": "hello"}),
    ]
    assert mail.list_messages("tok") == [{"id": "m/1"}]
    assert mail.get_message("tok", "m/1") == {"id": "m/1", "text": "hello"}
    for call in mail.session.calls:
        assert call.kwargs["headers"] == {"Authorization": "Bearer tok"}
    assert mail.session.calls[1].url == f"{BASE}/messages/m%2F1"


def test_message_text_joins_text_and_html():
    assert message_text({"text": "a", "html": ["<b>b</b>", "c"]}) == "a <b>b</b> c"
    assert message_text({"text": None, "html": "<i>x</i>"}) == " <i>x</i>"
    assert message_text({}) == ""


# --- wait_for_message ----------------------------------------------------------------------------


def _inbox(*ids: str) -> requests.Response:
    return answer(200, {"hydra:member": [{"id": message_id} for message_id in ids]})


def _message(message_id: str, text: str) -> requests.Response:
    return answer(200, {"id": message_id, "text": text, "html": []})


def test_wait_for_message_polls_until_one_matches_and_reads_each_once(mail, clock):
    mail.session.answers = [
        _inbox(),
        _inbox("welcome"),
        _message("welcome", "Welcome!"),
        _inbox("code", "welcome"),
        _message("code", "Your code is 123456"),
    ]
    found = mail.wait_for_message(
        "tok", lambda m: "code is" in message_text(m), timeout=60, poll_interval=8, initial_delay=12
    )
    assert found["id"] == "code"
    reads = [call.url for call in mail.session.calls if "/messages/" in call.url]
    assert reads == [f"{BASE}/messages/welcome", f"{BASE}/messages/code"]
    lists = [clock.since_start(c.at) for c in mail.session.calls if c.url.endswith("/messages")]
    assert lists == pytest.approx([12, 20, 28], abs=0.5)


def test_wait_for_message_gives_up_at_the_timeout(mail, clock):
    mail.session.answers = [_inbox() for _ in range(20)]
    with pytest.raises(MailTmTimeout):
        mail.wait_for_message("tok", lambda m: True, timeout=60, poll_interval=8, initial_delay=12)
    polls = [clock.since_start(call.at) for call in mail.session.calls]
    assert polls == pytest.approx([12, 20, 28, 36, 44, 52, 60], abs=0.5)
    assert isinstance(MailTmTimeout("x"), RuntimeError)


def test_wait_for_message_never_waits_past_its_deadline_for_a_slot(mail, clock, state_dir):
    other_process = SharedRateLimiter(state_dir, clock=clock, sleep=clock.sleep)
    other_process.penalize(100)  # a 429 elsewhere, or a spent quota
    with pytest.raises(MailTmTimeout):
        mail.wait_for_message("tok", lambda m: True, timeout=10, poll_interval=2)
    assert clock.since_start(clock.now) <= 10
    assert mail.session.calls == []


def test_wait_for_message_does_not_retry_past_its_deadline(mail, clock):
    mail.session.answers = [answer(429, retry_after=30)]
    with pytest.raises(MailTmError, match="429"):
        mail.wait_for_message("tok", lambda m: True, timeout=10, poll_interval=2)
    assert clock.since_start(clock.now) <= 10
    assert len(mail.session.calls) == 1


def test_wait_for_message_still_retries_within_its_deadline(mail, clock):
    mail.session.answers = [answer(429, retry_after=3), _inbox("m1"), _message("m1", "hi")]
    found = mail.wait_for_message("tok", lambda m: True, timeout=10, poll_interval=2)
    assert found["id"] == "m1"
    assert clock.since_start(mail.session.calls[1].at) == pytest.approx(3)


# --- settings ------------------------------------------------------------------------------------


def test_defaults_and_environment_overrides(monkeypatch, tmp_path):
    monkeypatch.delenv(RATE_ENV, raising=False)
    monkeypatch.delenv(STATE_DIR_ENV, raising=False)
    mail = MailTmClient()
    assert (mail.limiter.rate, mail.limiter.burst) == (DEFAULT_RATE, DEFAULT_BURST)
    assert mail.limiter.state_dir == default_state_dir("https://api.mail.tm")
    assert mail.limiter.max_per_second < DOCUMENTED_LIMIT

    monkeypatch.setenv(RATE_ENV, "2.5")
    monkeypatch.setenv(STATE_DIR_ENV, str(tmp_path / "env"))
    mail = MailTmClient()
    assert (mail.limiter.rate, mail.limiter.state_dir) == (2.5, str(tmp_path / "env"))

    mail = MailTmClient(rate=1, burst=1, state_dir=str(tmp_path / "arg"))
    assert (mail.limiter.rate, mail.limiter.burst) == (1.0, 1)
    assert mail.limiter.state_dir == str(tmp_path / "arg")

    monkeypatch.setenv(RATE_ENV, "fast")
    with pytest.raises(ValueError, match=RATE_ENV):
        MailTmClient()


def test_the_default_state_dir_is_per_api_host():
    assert default_state_dir("https://api.mail.tm") == os.path.join(
        tempfile.gettempdir(), "mailtm-ratelimit-api.mail.tm"
    )
    assert default_state_dir("http://127.0.0.1:8025/").endswith("mailtm-ratelimit-127.0.0.1_8025")


# --- real processes against a local endpoint ----------------------------------------------------

CLIENT_IN_A_CHILD = r"""
import importlib, json, os, sys
import requests
sys.path.append(sys.argv[1])
package = importlib.import_module(sys.argv[2])

class Recording(package.SharedRateLimiter):
    slots = []
    def acquire(self):
        slot = super().acquire()
        self.slots.append(slot)
        return slot

session = requests.Session()
session.trust_env = False  # never through a proxy
client = package.MailTmClient(sys.argv[4], limiter=Recording(sys.argv[3]), session=session)
print("ready", flush=True)
sys.stdin.readline()
probes = [f"{os.getpid()}-{i}" for i in range(int(sys.argv[5]))]
for probe in probes:
    assert client.request("GET", f"/probe/{probe}").status_code == 200
print(json.dumps(dict(zip(probes, Recording.slots))), flush=True)
"""


class _Counter(http.server.BaseHTTPRequestHandler):
    """The fake endpoint: notes when each request arrives."""

    def do_GET(self) -> None:  # noqa: N802 (http.server's name)
        arrived = time.time()
        with self.server.guard:
            self.server.arrivals[self.path.rsplit("/", 1)[-1]] = arrived
        body = b'{"hydra:member": []}'
        self.send_response(200)
        self.send_header("Content-Type", "application/ld+json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def endpoint():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Counter)
    server.arrivals = {}
    server.guard = threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def test_processes_hammering_an_endpoint_stay_under_the_limit(endpoint, state_dir):
    """Three processes with the default settings send five requests each as fast as they can.
    Every request reached the endpoint after the limiter released it, and the releases together
    never put more than the bucket allows (7 with the defaults, under mail.tm's 8) in a second."""
    url = f"http://127.0.0.1:{endpoint.server_address[1]}"
    children = [
        spawn(CLIENT_IN_A_CHILD, os.path.dirname(PACKAGE_DIR), PACKAGE_NAME, state_dir, url, 5)
        for _ in range(3)
    ]
    try:
        outputs = start_together(children)
    finally:
        for child in children:
            child.kill()
    slots: dict[str, float] = {}
    for out in outputs:
        slots.update(json.loads(out))
    assert len(slots) == 15
    assert set(endpoint.arrivals) == set(slots)
    for probe, slot in slots.items():
        assert endpoint.arrivals[probe] >= slot - 0.05  # the clock ticks every 15.6 ms on Windows
    assert_conforms(slots.values(), DEFAULT_RATE, DEFAULT_BURST)
    most = busiest_second(slots.values())
    assert most <= DEFAULT_BURST + math.ceil(DEFAULT_RATE) - 1 < DOCUMENTED_LIMIT
