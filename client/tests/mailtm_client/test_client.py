"""
The mail.tm client (client.py), offline: its HTTP session is a stub (or, for the multi-process
test, a local server), its queue a real one in the test's own directory on a fake clock, its live
feed a scripted one (or a local SSE server), and its guard its own.
"""
from __future__ import annotations

import base64
import http.server
import json
import logging
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
    ScriptedFeed,
    assert_within,
    busiest_second,
    spawn,
    start_together,
)
from .client import (
    DOCUMENTED_LIMIT,
    LIVE_ENV,
    PER_MINUTE_ENV,
    PER_SECOND_ENV,
    RUN_ID_ENV,
    SAFETY_LOOK,
    STATE_DIR_ENV,
    AddressTaken,
    MailTmClient,
    MailTmError,
    MailTmRateLimited,
    MailTmTimeout,
    Quota,
    RetryPolicy,
    account_id_from_token,
    backoff_seconds,
    default_state_dir,
    message_text,
    rate_limit_headers,
    ratelimit_quota,
    retry_after_seconds,
)
from .guard import CallGuard, MailTmNotAllowed
from .live import Ended, LineSplitter, SseEvent, SseParser, ThreadedFeed, arrived_message
from .ratelimit import DEFAULT_BUCKETS, Bucket, SharedQueue

BASE = "https://mail.test"


def answer(
    status: int = 200, body: Any = None, retry_after: Any = None, headers: Any = None
) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(body if body is not None else {}).encode()
    response._content_consumed = True  # a read body: close() has nothing to release
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


class CountingQueue(SharedQueue):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.acquired = 0

    def acquire(self, ticket: Any = None, *, max_wait: Any = None):
        self.acquired += 1
        return super().acquire(ticket, max_wait=max_wait)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def state_dir(tmp_path) -> str:
    return str(tmp_path / "state")


@pytest.fixture
def make(clock, state_dir):
    """`make(**settings)`: a client on a stub session, sharing the test's state dir and clock,
    with its own guard and the live feed off. Two of them are two processes."""

    def build(**settings: Any) -> MailTmClient:
        settings.setdefault("queue", CountingQueue(state_dir, clock=clock, sleep=clock.sleep))
        settings.setdefault("session", StubSession(clock))
        settings.setdefault("guard", CallGuard())
        settings.setdefault("live", False)
        return MailTmClient(BASE, clock=clock, sleep=clock.sleep, **settings)

    return build


@pytest.fixture
def mail(make) -> MailTmClient:
    return make()


def other_process(state_dir: str, clock: FakeClock) -> SharedQueue:
    return SharedQueue(state_dir, clock=clock, sleep=clock.sleep)


DOMAINS = {
    "hydra:member": [
        {"domain": "old.test", "isActive": False},
        {"domain": "mail.test", "isActive": True},
    ]
}


# --- every call waits in the queue ---------------------------------------------------------------


def test_every_call_waits_in_the_queue(mail):
    mail.session.answers = [
        answer(200, DOMAINS),
        answer(201, {"id": "a1", "address": "x@mail.test"}),
        answer(200, {"token": "t", "id": "a1"}),
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
    assert mail.queue.acquired == len(mail.session.calls) == mail.stats.requests == 6


def test_calls_from_two_processes_share_both_buckets(make, clock):
    """Six a second, nine a minute, across "processes"."""
    first, second = make(), make(session=StubSession(clock))
    first.session.answers = [answer(200, {}) for _ in range(6)]
    second.session.answers = [answer(200, {}) for _ in range(6)]
    for _ in range(6):
        first.request("GET", "/me")
        second.request("GET", "/me")
    times = sorted(call.at for call in first.session.calls + second.session.calls)
    assert [clock.since_start(at) for at in times] == pytest.approx([0] * 6 + [1] * 3 + [60] * 3)
    assert_within(times, DEFAULT_BUCKETS)


def test_time_in_line_is_counted(make, clock, state_dir):
    mail = make()
    other_process(state_dir, clock).pause(12)
    mail.session.answers = [answer(200)]
    mail.request("GET", "/me")
    assert mail.stats.queued == pytest.approx(12)


# --- 429 -----------------------------------------------------------------------------------------


def test_a_429_is_retried_after_a_jittered_backoff_that_grows(mail):
    mail.session.answers = [answer(429), answer(429), answer(200)]
    assert mail.request("GET", "/messages").status_code == 200
    first, second = mail.session.gaps()
    assert 1.0 <= first <= 2.0
    assert 2.0 <= second <= 4.0
    assert (mail.stats.requests, mail.stats.refused) == (3, 2)


def test_a_429_is_logged_with_its_headers_and_the_runs_counters(mail, caplog):
    # A run that fails on a slow inbox shows whether mail.tm refused calls meanwhile, and which
    # quota it named.
    limited = {"RateLimit-Policy": "10; w=60", "X-RateLimit-Limit": "10", "Server": "nginx"}
    mail.session.answers = [answer(200), answer(429, retry_after=3, headers=limited), answer(200)]
    mail.request("GET", "/me")
    with caplog.at_level(logging.WARNING):
        mail.request("GET", "/messages")
    [record] = caplog.records
    text = record.getMessage()
    assert text.startswith("mail.tm answered 429 to GET /messages: every process pauses 3.0 s")
    assert "Retry-After: 3" in text and "RateLimit-Policy: 10; w=60" in text
    assert "X-RateLimit-Limit: 10" in text and "nginx" not in text
    assert "429 #1 this run" in text and "run request #2" in text
    assert "2 sent in the last 60 s" in text


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
    assert clock.since_start(other_process(state_dir, clock).acquire().at) == pytest.approx(5)


def test_a_refused_call_is_never_dropped(mail):
    """Twenty 429s in a row, then an answer: the call still gets it."""
    mail.session.answers = [answer(429, retry_after=30) for _ in range(20)] + [answer(200)]
    assert mail.request("GET", "/messages").status_code == 200
    assert len(mail.session.calls) == 21
    assert mail.session.gaps() == pytest.approx([30.0] * 20)


def test_only_the_call_ceiling_ends_a_refused_call_and_it_says_why(make):
    mail = make(retry=RetryPolicy(call_ceiling=100))
    mail.session.answers = [answer(429, retry_after=30) for _ in range(10)]
    with pytest.raises(MailTmRateLimited) as gave_up:
        mail.request("GET", "/messages")
    text = str(gave_up.value)
    assert "4 attempts, 4 answered 429" in text
    assert "this run so far: 4 requests, 4 refused" in text and "100 s per call" in text
    assert isinstance(gave_up.value, MailTmError)


def test_the_ceiling_covers_time_in_line(make, clock, state_dir):
    mail = make(retry=RetryPolicy(call_ceiling=10))
    other_process(state_dir, clock).pause(100)
    with pytest.raises(MailTmRateLimited, match="was still waiting in line for GET /messages"):
        mail.request("GET", "/messages")
    assert mail.session.calls == []
    assert clock.since_start(clock.now) == pytest.approx(10)


def test_a_429_is_not_retried_for_a_call_that_is_not_safe_to_repeat(mail):
    mail.session.answers = [answer(429, retry_after=1)]
    assert mail.request("PATCH", "/messages/m1", json={"seen": True}).status_code == 429
    assert len(mail.session.calls) == 1


def test_account_creation_survives_a_429(mail):
    mail.session.answers = [answer(429, retry_after=1), answer(201, {"id": "a1"})]
    assert mail.create_account("x@mail.test", "pw") == {"id": "a1"}
    assert len(mail.session.calls) == 2


def test_a_429_with_a_spent_quota_and_no_retry_after_waits_for_the_reset(mail):
    spent = {"RateLimit-Remaining": "0", "RateLimit-Reset": "7"}
    mail.session.answers = [answer(429, headers=spent), answer(200)]
    assert mail.request("GET", "/messages").status_code == 200
    assert mail.session.gaps() == pytest.approx([7.0])


def test_the_stricter_of_retry_after_and_the_reset_wins(mail):
    both = {"RateLimit-Remaining": "0", "RateLimit-Reset": "9"}
    mail.session.answers = [answer(429, retry_after=4, headers=both), answer(200)]
    mail.request("GET", "/messages")
    assert mail.session.gaps() == pytest.approx([9.0])


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
        (
            {"X-RateLimit-Limit": "10", "x-ratelimit-remaining": "2", "X-RateLimit-Reset": "5"},
            Quota(10, 2, 5, None),
        ),
        ({"RateLimit-Policy": "10; w=60"}, Quota(10, None, None, 60)),  # what mail.tm sends
        (
            {"RateLimit": '"default";r=0;t=42', "RateLimit-Policy": '"default";q=10;w=60'},
            Quota(10, 0, 42, 60),
        ),
        (  # several quotas, in both forms: the strictest of each
            {
                "RateLimit-Policy": "10;w=1, 100;w=60",
                "RateLimit-Remaining": "5, 0",
                "RateLimit-Reset": "1, 30",
                "X-RateLimit-Remaining": "4",
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


def test_an_x_ratelimit_reset_that_is_a_time_means_seconds_from_now():
    at = str(time.time() + 20)
    quota = ratelimit_quota({"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": at})
    assert quota is not None and 18 <= quota.reset <= 20


def test_rate_limit_headers_are_picked_for_logs():
    headers = {
        "Retry-After": "3",
        "ratelimit-policy": "10; w=60",
        "Server": "x",
        "X-RateLimit-Reset": "9",
    }
    expected = "Retry-After: 3; ratelimit-policy: 10; w=60; X-RateLimit-Reset: 9"
    assert rate_limit_headers(headers) == expected
    assert rate_limit_headers({}) == ""


def test_a_spent_quota_pauses_every_process_before_the_next_call(make, clock, state_dir):
    mail = make()
    spent = {"RateLimit": "limit=10, remaining=0, reset=42"}
    mail.session.answers = [answer(200, headers=spent), answer(200)]
    mail.request("GET", "/messages")
    assert clock.since_start(other_process(state_dir, clock).acquire().at) == pytest.approx(42)
    mail.request("GET", "/messages")
    assert mail.session.gaps()[0] >= 42  # waited before the call, no 429 needed
    assert len(mail.session.calls) == 2


@pytest.mark.parametrize("remaining, paused", [(0, True), (1, True), (2, False)])
def test_the_pause_starts_at_the_reserve(make, clock, state_dir, remaining, paused):
    mail = make()
    quota = {"RateLimit-Remaining": str(remaining), "RateLimit-Reset": "9"}
    mail.session.answers = [answer(200, headers=quota)]
    mail.request("GET", "/messages")
    slot = other_process(state_dir, clock).acquire()
    assert (clock.since_start(slot.at) >= 9) is paused


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
    slot = other_process(state_dir, clock).acquire()
    assert clock.since_start(slot.at) == pytest.approx(pause)


def test_the_quota_pause_cap_is_a_setting(make, clock, state_dir):
    mail = make(retry=RetryPolicy(quota_pause_cap=30))
    mail.session.answers = [answer(200, headers={"RateLimit": "remaining=0, reset=3600"})]
    mail.request("GET", "/messages")
    slot = other_process(state_dir, clock).acquire()
    assert clock.since_start(slot.at) == pytest.approx(30)


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


def test_forgotten_domains_are_looked_up_again_here_and_in_other_processes(make):
    first = make()
    renamed = {"hydra:member": [{"domain": "new.test", "isActive": True}]}
    first.session.answers = [answer(200, DOMAINS)]
    first.domains()
    first.forget_domains()
    second = make()
    second.session.answers = [answer(200, renamed)]
    assert second.domain() == "new.test"  # the shared cache went too: it asked mail.tm
    assert first.domain() == "new.test"  # and the first reads the second's fresh list
    assert len(first.session.calls) == 1


def test_the_domain_cache_expires(make, clock):
    first = make(domain_ttl=600)
    renamed = {"hydra:member": [{"domain": "new.test", "isActive": True}]}
    first.session.answers = [answer(200, DOMAINS), answer(200, renamed)]
    first.domains()
    clock.advance(601)
    assert first.domains() == ["new.test"]
    assert len(first.session.calls) == 2


def test_a_cache_for_another_api_is_ignored(make, clock, state_dir):
    SharedQueue(state_dir).store_shared(
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
    mail.session.answers = [
        answer(201, {"id": "a1"}),
        answer(422, {"detail": "address: used"}),
        answer(401, {"message": "Invalid credentials."}),  # someone else's address
    ]
    mail.create_account("x@mail.test", "secret-pw")
    call = mail.session.calls[0]
    assert (call.method, call.url) == ("POST", f"{BASE}/accounts")
    assert call.kwargs["json"] == {"address": "x@mail.test", "password": "secret-pw"}
    with pytest.raises(AddressTaken, match="422") as refused:
        mail.create_account("x@mail.test", "secret-pw")
    assert isinstance(refused.value, MailTmError)
    assert "secret-pw" not in str(refused.value)


def test_an_address_already_ours_is_taken_as_created(mail):
    """A creation that went through behind an earlier answer: the password opens the inbox."""
    mail.session.answers = [
        answer(422, {"detail": "address: used"}),
        answer(200, {"token": "t"}),
        answer(200, {"id": "a1", "address": "x@mail.test"}),
    ]
    assert mail.create_account("x@mail.test", "pw") == {"id": "a1", "address": "x@mail.test"}
    me = mail.session.calls[2]
    assert (me.method, me.url) == ("GET", f"{BASE}/me")
    assert me.kwargs["headers"] == {"Authorization": "Bearer t"}


def test_a_token_never_shows_up_in_an_error(mail):
    mail.session.answers = [answer(401, {"token": "leaked?"}), answer(200, {})]
    with pytest.raises(MailTmError, match="401") as refused:
        mail.get_token("x@mail.test", "secret-pw")
    assert "leaked" not in str(refused.value) and "secret-pw" not in str(refused.value)
    with pytest.raises(MailTmError, match="without a token"):
        mail.get_token("x@mail.test", "secret-pw")


def _jwt(payload: dict) -> str:
    def part(data: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part(payload)}.sig"


def test_sign_in_gives_the_token_and_the_account_id(mail):
    mail.session.answers = [
        answer(200, {"token": "t", "id": "acc-1"}),
        answer(200, {"token": _jwt({"id": "acc-2"})}),  # no id beside it: the token's own
    ]
    assert tuple(mail.sign_in("x@mail.test", "pw")) == ("t", "acc-1")
    assert mail.sign_in("x@mail.test", "pw").account_id == "acc-2"


@pytest.mark.parametrize(
    "token, expected",
    [
        (_jwt({"id": "abc"}), "abc"),
        (_jwt({"mercure": {"subscribe": ["/accounts/xyz"]}}), "xyz"),
        (_jwt({"sub": "someone"}), None),
        ("not-a-jwt", None),
        ("a.%%%.c", None),
        (_jwt(["a", "list"]), None),  # type: ignore[arg-type]
    ],
)
def test_the_account_id_is_read_from_the_token(token, expected):
    assert account_id_from_token(token) == expected


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


# --- waiting for a message: polling --------------------------------------------------------------


def _inbox(*ids: str) -> requests.Response:
    return answer(200, {"hydra:member": [{"id": message_id} for message_id in ids]})


def _message(message_id: str, text: str) -> requests.Response:
    return answer(200, {"id": message_id, "text": text, "html": []})


def _lists(mail: MailTmClient, clock: FakeClock) -> list[float]:
    return [clock.since_start(c.at) for c in mail.session.calls if c.url.endswith("/messages")]


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
    assert _lists(mail, clock) == pytest.approx([12, 20, 28], abs=0.5)
    assert mail.stats.polled == 1


def test_wait_for_message_gives_up_at_the_timeout_and_says_what_it_did(mail, clock):
    mail.session.answers = [_inbox() for _ in range(20)]
    with pytest.raises(MailTmTimeout) as timed_out:
        mail.wait_for_message("tok", lambda m: True, timeout=60, poll_interval=8, initial_delay=12)
    assert _lists(mail, clock) == pytest.approx([12, 20, 28, 36, 44, 52, 60], abs=0.5)
    text = str(timed_out.value)
    assert "within 60 s of waiting" in text and "7 looks at the inbox, 0 messages read" in text
    assert "0.0 s went to waiting in line" in text
    assert isinstance(MailTmTimeout("x"), RuntimeError)


def test_the_deadline_does_not_count_time_in_line(make, clock, state_dir):
    """Another process's 429 holds the line for 100 s, far past a 30 s wait: the wait goes on,
    and finds the message on its next look."""
    mail = make()
    other_process(state_dir, clock).pause(100)
    mail.session.answers = [_inbox(), _inbox("m1"), _message("m1", "code 482913")]
    found = mail.wait_for_message("tok", lambda m: True, timeout=30, poll_interval=8)
    assert found["id"] == "m1"
    assert _lists(mail, clock) == pytest.approx([100, 108])


def test_a_timed_out_wait_says_how_long_it_spent_in_line(make, clock, state_dir):
    mail = make()
    other_process(state_dir, clock).pause(100)
    mail.session.answers = [_inbox() for _ in range(10)]
    with pytest.raises(MailTmTimeout) as timed_out:
        mail.wait_for_message("tok", lambda m: True, timeout=30, poll_interval=10)
    assert _lists(mail, clock) == pytest.approx([100, 110, 120, 130])
    assert "4 looks at the inbox" in str(timed_out.value)
    assert "100.0 s went to waiting in line for mail.tm, not counted" in str(timed_out.value)


def test_rate_limited_looks_never_end_the_wait(mail, clock):
    """Five refused looks in a row, 20 s each, far past the 10 s budget: still found."""
    refused = [answer(429, retry_after=20) for _ in range(5)]
    mail.session.answers = [*refused, _inbox("m1"), _message("m1", "hi")]
    found = mail.wait_for_message("tok", lambda m: True, timeout=10, poll_interval=2)
    assert found["id"] == "m1"
    assert clock.since_start(mail.session.calls[5].at) == pytest.approx(100)


# --- waiting for a message: the live feed --------------------------------------------------------

MERCURE = "https://mercure.test/.well-known/mercure"


@pytest.fixture
def live(make, clock):
    """`live(items)`: a client with the live feed on, whose feed is `ScriptedFeed(clock, items)`
    (the feeds it made are in `client.feeds`)."""

    def build(items: list, **settings: Any) -> MailTmClient:
        feeds: list = []

        def feed(response: requests.Response) -> ScriptedFeed:
            feeds.append(ScriptedFeed(clock, list(items)))
            return feeds[-1]

        client = make(live=True, mercure_url=MERCURE, feed_factory=feed, **settings)
        client.feeds = feeds  # type: ignore[attr-defined]
        return client

    return build


def _arrived(message_id: str) -> dict:
    return {"@type": "Message", "id": message_id, "subject": "Your code"}


def test_the_live_feed_opens_through_the_queue_with_the_topic_and_token(live, clock):
    mail = live([(5, _arrived("m1"))])
    mail.session.answers = [answer(200), _message("m1", "code 123456")]
    with mail.watch_inbox("tok", "acc-1") as watch:
        assert watch.connected
        found = watch.wait_for(lambda m: True, timeout=60, poll_interval=8, check_existing=False)
    assert found["id"] == "m1"
    opened, read = mail.session.calls
    assert (opened.method, opened.url) == ("GET", MERCURE)
    assert opened.kwargs["params"] == {"topic": "/accounts/acc-1"}
    assert opened.kwargs["headers"]["Authorization"] == "Bearer tok"
    assert opened.kwargs["stream"] is True
    assert read.url == f"{BASE}/messages/m1"
    assert clock.since_start(read.at) == pytest.approx(5)
    assert mail.queue.acquired == 2  # the stream counts as one queued call
    assert mail.feeds[0].closed and mail.stats.live == 1


def test_wait_for_message_on_the_live_feed_looks_once_then_reads_what_arrives(live, clock):
    """No polling: a look at what is there, then each announced message read once; account
    updates and deleted messages are not messages."""
    items = [
        (2, _arrived("welcome")),
        (4, _arrived("welcome")),  # announced again: not read again
        (9, _arrived("code")),
    ]
    mail = live(items)
    mail.session.answers = [
        answer(200),
        _inbox(),
        _message("welcome", "Welcome!"),
        _message("code", "Your code is 123456"),
    ]
    found = mail.wait_for_message(
        _jwt({"id": "acc-9"}), lambda m: "code is" in message_text(m), timeout=150, poll_interval=8
    )
    assert found["id"] == "code"
    paths = [call.url.removeprefix(BASE) for call in mail.session.calls]
    assert paths == [MERCURE, "/messages", "/messages/welcome", "/messages/code"]


def test_a_message_already_there_is_found_without_waiting(live):
    mail = live([])
    mail.session.answers = [answer(200), _inbox("m1"), _message("m1", "hi")]
    assert mail.wait_for_message("tok", lambda m: True, account_id="a", timeout=9)["id"] == "m1"


def test_a_feed_that_fails_to_connect_falls_back_to_polling(live, clock, caplog):
    mail = live([(1, _arrived("never"))])
    mail.session.answers = [answer(401), _inbox(), _inbox("m1"), _message("m1", "hi")]
    with caplog.at_level(logging.INFO):
        found = mail.wait_for_message(
            "tok", lambda m: True, account_id="a", timeout=60, poll_interval=8, initial_delay=12
        )
    assert found["id"] == "m1"
    assert _lists(mail, clock) == pytest.approx([12, 20])
    assert mail.feeds == []
    logs = [record.getMessage() for record in caplog.records]
    assert "mail.tm live feed failed to connect (HTTP 401): polling" in logs
    found_by = "mail.tm message found by polling (HTTP 401): look 2"
    assert any(line.startswith(found_by) for line in logs)


def test_a_feed_that_cannot_be_reached_falls_back_to_polling(live, clock):
    mail = live([])
    down = [requests.ConnectionError("no route") for _ in range(7)]
    mail.session.answers = [*down, _inbox("m1"), _message("m1", "x")]
    assert mail.wait_for_message("tok", lambda m: True, account_id="a", timeout=60)["id"] == "m1"


def test_no_account_id_means_polling(live, clock):
    mail = live([])
    mail.session.answers = [_inbox("m1"), _message("m1", "hi")]
    assert mail.wait_for_message("opaque", lambda m: True, timeout=9)["id"] == "m1"
    assert all(MERCURE not in call.url for call in mail.session.calls)


def test_a_feed_that_drops_falls_back_to_polling_for_the_rest_of_the_budget(live, clock, caplog):
    mail = live([(5, Ended("ConnectionError: reset"))])
    mail.session.answers = [answer(200), _inbox(), _inbox(), _inbox("m1"), _message("m1", "hi")]
    with caplog.at_level(logging.WARNING):
        found = mail.wait_for_message(
            "tok", lambda m: True, account_id="a", timeout=60, poll_interval=8
        )
    assert found["id"] == "m1"
    assert _lists(mail, clock) == pytest.approx([0, 5, 13])  # the look, then at once, then +8
    assert any("live feed dropped after 5.0 s" in r.getMessage() for r in caplog.records)


def test_a_dropped_feed_still_times_out_on_the_same_budget(live, clock):
    mail = live([(50, Ended("closed"))])
    mail.session.answers = [answer(200), _inbox()] + [_inbox() for _ in range(5)]
    with pytest.raises(MailTmTimeout, match="polling after the live feed dropped: 5 looks"):
        mail.wait_for_message("tok", lambda m: True, account_id="a", timeout=60, poll_interval=8)
    # The first look, a safety look after 45 quiet seconds, then polling from the drop.
    assert _lists(mail, clock) == pytest.approx([0, SAFETY_LOOK, 50, 58, 60])


def test_a_quiet_feed_gets_a_safety_look(live, clock):
    """An event the feed never delivered: a look after SAFETY_LOOK seconds finds the message."""
    mail = live([])
    mail.session.answers = [answer(200), _inbox(), _inbox("m1"), _message("m1", "hi")]
    found = mail.wait_for_message("tok", lambda m: True, account_id="a", timeout=150)
    assert found["id"] == "m1"
    assert _lists(mail, clock) == pytest.approx([0, SAFETY_LOOK])


def test_a_live_wait_times_out_with_its_budget(live, clock):
    mail = live([])
    mail.session.answers = [answer(200), _inbox(), _inbox()]
    with pytest.raises(MailTmTimeout, match="within 60 s of waiting \\(live feed: 2 looks"):
        mail.wait_for_message("tok", lambda m: True, account_id="a", timeout=60)
    assert clock.since_start(clock.now) == pytest.approx(60)


def test_a_message_the_feed_announced_but_cannot_be_read_falls_back_to_polling(live, clock):
    mail = live([(3, _arrived("m1"))])
    mail.session.answers = [answer(200), answer(404), _inbox("m1"), _message("m1", "hi")]
    with mail.watch_inbox("tok", "a") as watch:
        found = watch.wait_for(lambda m: True, timeout=60, poll_interval=8, check_existing=False)
    assert found["id"] == "m1"


def test_the_live_feed_can_be_turned_off(make, monkeypatch):
    monkeypatch.setenv(LIVE_ENV, "0")
    assert make(live=None).live is False
    monkeypatch.setenv(LIVE_ENV, "1")
    assert make(live=None).live is True
    watch = make(live=False).watch_inbox("tok", "a")
    assert not watch.connected and watch.failure == "live feed off"


# --- the live feed's events ----------------------------------------------------------------------


def test_lines_split_at_lf_cr_lf_and_cr_even_across_reads():
    splitter = LineSplitter()
    assert splitter.feed(b"data: a\r") == ["data: a"]
    assert splitter.feed(b"\ndata: b\n\ndata: \xc3") == ["data: b", ""]
    assert splitter.feed(b"\xa9\rx") == ["data: é"]
    assert splitter.feed(b"\r\n") == ["x"]  # the CR ends it; its LF is no extra line


def test_the_sse_parser_reads_events_comments_and_multiline_data():
    lines = [
        ": heartbeat",
        "event: update",
        "id: urn:1",
        'data: {"a":',
        "data:  1}",
        "",
        "",  # a blank line with nothing pending is no event
        "retry: 3000",
        "data: plain",
        "",
    ]
    assert SseParser().feed_all(lines) == [
        SseEvent("update", '{"a":\n 1}', "urn:1"),
        SseEvent("message", "plain", "urn:1"),  # the last id stays the stream's
    ]


@pytest.mark.parametrize(
    "data, expected",
    [
        ('{"@type": "Message", "id": "m1", "subject": "Hi"}', "m1"),
        ('{"id": "m2", "from": {"address": "a@b"}, "intro": "x"}', "m2"),  # no @type
        ('{"@type": "Account", "id": "acc", "used": 10}', None),
        ('{"@type": "Message", "id": "m3", "isDeleted": true}', None),
        ('{"@type": "Message"}', None),
        ('{"id": "x"}', None),  # nothing says it is a message
        ("[1, 2]", None),
        ("not json", None),
    ],
)
def test_only_new_messages_count_as_arrivals(data, expected):
    message = arrived_message(SseEvent("message", data, None))
    assert (message or {}).get("id") == expected


class _Stream(http.server.BaseHTTPRequestHandler):
    """A Mercure stand-in: a heartbeat, an account update, a message, then it closes."""

    protocol_version = "HTTP/1.0"

    def do_GET(self) -> None:  # noqa: N802 (http.server's name)
        self.server.requests.append((self.path, self.headers.get("Authorization")))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [
            b":\n\n",
            b'data: {"@type": "Account", "id": "acc-1"}\n\n',
            b'id: 1\ndata: {"@type": "Message", "id": "m1", "subject": "Code"}\r\n\r\n',
        ]
        for chunk in chunks:
            self.wfile.write(chunk)
            self.wfile.flush()
            time.sleep(0.05)
        time.sleep(self.server.hold)  # the stream stays open: events must not wait for its end

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def sse_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Stream)
    server.requests = []
    server.hold = 0.0
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def test_the_threaded_feed_hands_over_each_message_as_it_arrives(sse_server):
    sse_server.hold = 3.0
    session = requests.Session()
    session.trust_env = False
    url = f"http://127.0.0.1:{sse_server.server_address[1]}/.well-known/mercure"
    response = session.get(url, params={"topic": "/accounts/acc-1"}, stream=True, timeout=5)
    feed = ThreadedFeed(response)
    try:
        first = feed.next(2)  # well before the stream ends
        ended = feed.next(10)
    finally:
        feed.close()
    assert isinstance(first, dict) and first["id"] == "m1"
    assert isinstance(ended, Ended) and "closed" in ended.reason
    assert feed.next(0) == ended  # it stays ended
    assert [event.data for event in feed.events][0] == '{"@type": "Account", "id": "acc-1"}'


def test_a_live_wait_on_a_real_stream(sse_server, state_dir):
    """The client end to end, real threads and clock: open, announce, one read."""
    port = sse_server.server_address[1]

    class Session(requests.Session):
        def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
            if "/messages/" in url:
                return answer(200, {"id": "m1", "text": "Your code is 123456"})
            return super().request(method, url, **kwargs)

    session = Session()
    session.trust_env = False
    mail = MailTmClient(
        BASE,
        state_dir=state_dir,
        session=session,
        guard=CallGuard(),
        live=True,
        mercure_url=f"http://127.0.0.1:{port}/.well-known/mercure",
    )
    with mail.watch_inbox("tok", "acc-1") as watch:
        assert watch.connected
        found = watch.wait_for(
            lambda m: "code" in message_text(m), timeout=10, poll_interval=8, check_existing=False
        )
    assert found["id"] == "m1"
    assert sse_server.requests == [("/.well-known/mercure?topic=%2Faccounts%2Facc-1", "Bearer tok")]


def test_closing_a_feed_while_it_waits_ends_its_thread():
    class Blocking:
        def __init__(self) -> None:
            self.release = threading.Event()

        def iter_content(self, chunk_size: int = 1):
            self.release.wait(5)
            raise requests.ConnectionError("closed")

        def close(self) -> None:
            self.release.set()

    feed = ThreadedFeed(Blocking())
    assert feed.next(0.05) is None
    feed.close()
    feed._thread.join(5)
    assert not feed._thread.is_alive()


# --- the guard -----------------------------------------------------------------------------------


def test_with_the_guard_on_an_unpermitted_call_raises_before_anything_is_sent(make):
    guard = CallGuard()
    guard.enable()
    mail = make(guard=guard)
    with guard.running("tests/e2e/x.py::test_y"):
        with pytest.raises(MailTmNotAllowed) as refused:
            mail.list_messages("t")
    text = str(refused.value)
    assert text.startswith("tests/e2e/x.py::test_y called mail.tm (GET /messages) without")
    assert "@pytest.mark.email" in text
    assert mail.session.calls == [] and mail.queue.acquired == 0
    assert [tuple(v) for v in guard.violations] == [("tests/e2e/x.py::test_y", "GET /messages")]


def test_a_permitted_call_goes_through(make):
    guard = CallGuard()
    guard.enable()
    mail = make(guard=guard)
    mail.session.answers = [_inbox()]
    with guard.allow("@pytest.mark.email"):
        with guard.allow("nested"):
            assert guard.allowed == "nested"
        assert mail.list_messages("t") == []
    assert guard.allowed is None and guard.violations == []


def test_the_guard_is_off_by_default_and_covers_the_live_feed(make):
    guard = CallGuard()
    off = make(guard=guard)
    off.session.answers = [_inbox()]
    off.list_messages("t")  # nothing raised
    guard.enable()
    on = make(guard=guard, live=True, mercure_url=MERCURE)
    with pytest.raises(MailTmNotAllowed, match=r"\(GET /.well-known/mercure\)"):
        on.watch_inbox("tok", "acc-1")
    assert on.session.calls == []


def test_mail_tm_error_handlers_never_swallow_the_guard(make):
    """create_account's own fallback catches MailTmError: the guard's error is not one."""
    assert not issubclass(MailTmNotAllowed, MailTmError)
    guard = CallGuard()
    mail = make(guard=guard)
    mail.session.answers = [answer(422, {"detail": "address: used"})]

    def refuse_after_the_first_call(method: str, path: str) -> None:
        if path == "/token":
            raise MailTmNotAllowed("no")

    guard.check = refuse_after_the_first_call  # type: ignore[method-assign]
    with pytest.raises(MailTmNotAllowed):
        mail.create_account("x@mail.test", "pw")


# --- settings ------------------------------------------------------------------------------------


def test_defaults_and_environment_overrides(monkeypatch, tmp_path):
    for env in (PER_SECOND_ENV, PER_MINUTE_ENV, STATE_DIR_ENV, RUN_ID_ENV):
        monkeypatch.delenv(env, raising=False)
    mail = MailTmClient()
    assert mail.queue.buckets == DEFAULT_BUCKETS
    assert mail.queue.state_dir == default_state_dir("https://api.mail.tm")
    assert mail.queue.buckets[0].limit < DOCUMENTED_LIMIT
    assert mail.queue.run_id == ""

    monkeypatch.setenv(PER_SECOND_ENV, "2")
    monkeypatch.setenv(PER_MINUTE_ENV, "5")
    monkeypatch.setenv(STATE_DIR_ENV, str(tmp_path / "env"))
    monkeypatch.setenv(RUN_ID_ENV, "run-7")
    mail = MailTmClient()
    assert mail.queue.buckets == (Bucket(2, 1.0), Bucket(5, 60.0))
    assert (mail.queue.state_dir, mail.queue.run_id) == (str(tmp_path / "env"), "run-7")

    mail = MailTmClient(buckets=[Bucket(1, 2.0)], state_dir=str(tmp_path / "arg"), run_id="r")
    assert mail.queue.buckets == (Bucket(1, 2.0),)
    assert (mail.queue.state_dir, mail.queue.run_id) == (str(tmp_path / "arg"), "r")

    monkeypatch.setenv(PER_MINUTE_ENV, "lots")
    with pytest.raises(ValueError, match=PER_MINUTE_ENV):
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

class Recording(package.SharedQueue):
    slots = []
    def acquire(self, ticket=None, *, max_wait=None):
        slot = super().acquire(ticket, max_wait=max_wait)
        self.slots.append(slot.at)
        return slot

session = requests.Session()
session.trust_env = False  # never through a proxy
queue = Recording(sys.argv[3], buckets=package.default_buckets())
client = package.MailTmClient(sys.argv[4], queue=queue, session=session)
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


def test_processes_hammering_an_endpoint_stay_under_the_limit(endpoint, state_dir, monkeypatch):
    """Three processes send five requests each as fast as they can (the minute's limit raised so
    the test is quick). Every request reached the endpoint after the queue released it, and no
    second held more than six, under mail.tm's eight."""
    monkeypatch.setenv(PER_MINUTE_ENV, "100")
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
    assert busiest_second(slots.values()) <= 6 < DOCUMENTED_LIMIT
