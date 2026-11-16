"""
The Mail.tm helper's handling of 429 (tests/helpers/mailtm.py), without a browser or the network:
the session's calls are stubbed and the waits are recorded instead of slept.
"""
import json
import time
from email.utils import formatdate

import pytest
import requests

from tests.helpers import mailtm


def _response(status: int, body=None, retry_after=None) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(body if body is not None else {}).encode()
    if retry_after is not None:
        response.headers["Retry-After"] = retry_after
    return response


@pytest.fixture
def mail(monkeypatch):
    """Stubs Mail.tm: `mail.answers` are returned in order, `mail.calls` and `mail.waits`
    record what was sent and how long the helper would have slept."""

    class Stub:
        answers: list = []
        calls: list = []
        waits: list = []

    def request(method, url, **kwargs):
        Stub.calls.append((method, url))
        return Stub.answers.pop(0)

    Stub.answers, Stub.calls, Stub.waits = [], [], []
    monkeypatch.setattr(mailtm._session, "request", request)
    monkeypatch.setattr(mailtm.time, "sleep", Stub.waits.append)
    monkeypatch.setattr(mailtm, "MIN_CALL_INTERVAL", 0.0)
    monkeypatch.setattr(mailtm, "_domain", None)
    return Stub


def test_a_429_is_retried_after_a_jittered_backoff(mail):
    mail.answers = [_response(429), _response(429), _response(200)]
    assert mailtm.mailtm_request("GET", "/messages").status_code == 200
    assert len(mail.calls) == 3
    assert 1.0 <= mail.waits[0] <= 2.0
    assert 2.0 <= mail.waits[1] <= 4.0


def test_retry_after_is_honoured_in_seconds_or_as_a_date(mail):
    mail.answers = [_response(429, retry_after="3"), _response(201)]
    assert mailtm.mailtm_request("POST", "/accounts").status_code == 201
    assert mail.waits == [3.0]

    mail.waits.clear()
    in_ten_seconds = formatdate(time.time() + 10, usegmt=True)
    mail.answers = [_response(429, retry_after=in_ten_seconds), _response(200)]
    assert mailtm.mailtm_request("GET", "/domains").status_code == 200
    assert 8.0 <= mail.waits[0] <= 10.0


def test_retry_after_is_capped(mail):
    mail.answers = [_response(429, retry_after="3600"), _response(200)]
    mailtm.mailtm_request("GET", "/messages")
    assert mail.waits == [mailtm.RETRY_AFTER_CAP]


def test_gives_up_after_max_attempts_with_the_last_429(mail):
    mail.answers = [_response(429) for _ in range(mailtm.MAX_ATTEMPTS)]
    assert mailtm.mailtm_request("GET", "/messages").status_code == 429
    assert len(mail.calls) == mailtm.MAX_ATTEMPTS
    assert sum(mail.waits) <= mailtm.MAX_TOTAL_WAIT


def test_never_waits_more_than_the_total_cap(mail):
    mail.answers = [_response(429, retry_after="60") for _ in range(mailtm.MAX_ATTEMPTS)]
    assert mailtm.mailtm_request("GET", "/messages").status_code == 429
    assert mail.waits == [60.0, 60.0]
    assert len(mail.calls) == 3


def test_other_answers_are_not_retried(mail):
    mail.answers = [_response(500)]
    assert mailtm.mailtm_request("GET", "/messages").status_code == 500
    assert len(mail.calls) == 1
    assert mail.waits == []


def test_backoff_grows_and_stays_under_its_cap():
    for attempt in range(10):
        ceiling = min(mailtm.BACKOFF_CAP, mailtm.BACKOFF_BASE * 2**attempt)
        wait = mailtm.backoff_seconds(attempt)
        assert ceiling / 2 <= wait <= ceiling


def test_the_domain_is_looked_up_once_per_worker(mail):
    domains = {
        "hydra:member": [
            {"domain": "old.test", "isActive": False},
            {"domain": "mail.test", "isActive": True},
        ]
    }
    mail.answers = [_response(200, domains)]
    assert mailtm.get_mailtm_domain() == "mail.test"
    assert mailtm.get_mailtm_domain() == "mail.test"
    assert len(mail.calls) == 1


def test_account_creation_survives_a_429(mail):
    mail.answers = [_response(429, retry_after="1"), _response(201)]
    email, mailtm_password, app_password = mailtm.create_mailtm_account("mail.test")
    assert email.startswith("qatest") and email.endswith("@mail.test")
    assert mailtm_password and app_password
    assert mail.waits == [1.0]
