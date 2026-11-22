"""
tests/helpers/mailtm.py, offline: it only wires the project's settings into tests/mailtm_client
(whose own tests cover the shared queue, the 429 handling and the live feed). Mail.tm is a stub
here, the clock a fake one (so nothing waits), and the client has its own guard.
"""
import json

import pytest
import requests

from tests.helpers import mailtm
from tests.mailtm_client import CallGuard, MailTmClient


def _answer(status: int, body) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(body).encode()
    return response


class _Clock:
    def __init__(self) -> None:
        self.now = 1_700_000_000.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += max(seconds, 0.0)


@pytest.fixture
def mail(monkeypatch, tmp_path):
    """The helper's client, on a stub session (`mail.answers`, `mail.paths`) and its own state
    dir: never the real Mail.tm, never the real shared limit."""

    class Session:
        answers: list = []
        paths: list = []

        def request(self, method, url, **kwargs):
            Session.paths.append(f"{method} {url.removeprefix(mailtm.MAILTM_BASE)}")
            return Session.answers.pop(0)

    Session.answers, Session.paths = [], []
    clock = _Clock()
    client = MailTmClient(
        mailtm.MAILTM_BASE,
        state_dir=str(tmp_path),
        session=Session(),
        clock=clock,
        sleep=clock.sleep,
        guard=CallGuard(),
        live=False,
    )
    monkeypatch.setattr(mailtm, "_client", client)
    return Session


def test_one_client_per_process_on_the_real_mail_tm(monkeypatch):
    monkeypatch.setattr(mailtm, "_client", None)
    client = mailtm.get_mailtm_client()
    assert client is mailtm.get_mailtm_client()
    assert client.base_url == "https://api.mail.tm"
    assert client.queue.run_id == mailtm.mailtm_run_id()  # the run's requests counted together


def test_every_worker_of_a_run_counts_as_that_run(monkeypatch):
    monkeypatch.setenv("PYTEST_XDIST_TESTRUNUID", "run-abc")
    assert mailtm.mailtm_run_id() == "run-abc"
    monkeypatch.delenv("PYTEST_XDIST_TESTRUNUID")
    monkeypatch.delenv(mailtm.RUN_ID_ENV, raising=False)
    alone = mailtm.mailtm_run_id()
    assert alone and mailtm.mailtm_run_id() == alone  # one process alone keeps its own


def test_a_new_user_is_confirmed_from_the_live_feed_opened_before_the_signup(monkeypatch, tmp_path):
    """The confirmation email can't arrive unseen: the feed opens, then the signup sends it, then
    one read takes the code from the message the feed announced."""
    steps = []

    class Session:
        answers = [
            _answer(200, {"hydra:member": [{"domain": "mail.test", "isActive": True}]}),
            _answer(201, {"id": "acc-1"}),
            _answer(200, {"token": "t", "id": "acc-1"}),
            _answer(200, {}),  # the live feed's stream
            _answer(200, {"id": "m1", "text": "Your code is 482913", "html": []}),
        ]

        def request(self, method, url, **kwargs):
            path = url.removeprefix(mailtm.MAILTM_BASE).removeprefix("https://mercure.mail.tm")
            steps.append(f"{method} {path}")
            return Session.answers.pop(0)

    class Feed:
        def __init__(self, response):
            self.items = [{"@type": "Message", "id": "m1", "subject": "Confirm"}]

        def next(self, timeout):
            return self.items.pop(0) if self.items else None

        def close(self):
            steps.append("feed closed")

    clock = _Clock()
    client = MailTmClient(
        mailtm.MAILTM_BASE,
        state_dir=str(tmp_path),
        session=Session(),
        clock=clock,
        sleep=clock.sleep,
        guard=CallGuard(),
        live=True,
        feed_factory=Feed,
    )
    monkeypatch.setattr(mailtm, "_client", client)
    monkeypatch.setattr(mailtm, "signup_app", lambda api, email, password: steps.append("signup"))
    monkeypatch.setattr(
        mailtm, "confirm_signup_app", lambda api, email, code: steps.append(f"confirm {code}")
    )
    monkeypatch.setattr(mailtm, "login_app", lambda api, email, password: ("id", "refresh"))
    user = mailtm.create_test_user("http://api.test", with_workspace=False)
    assert steps == [
        "GET /domains",
        "POST /accounts",
        "POST /token",
        "GET /.well-known/mercure",
        "signup",
        "GET /messages/m1",
        "feed closed",
        "confirm 482913",
    ]
    assert user.email.endswith("@mail.test") and user.mailtm_password


def test_a_new_inbox_is_made_on_the_active_domain(mail):
    mail.answers = [
        _answer(200, {"hydra:member": [{"domain": "mail.test", "isActive": True}]}),
        _answer(201, {"id": "a1"}),
        _answer(200, {"token": "t"}),
    ]
    email, mailtm_password, app_password = mailtm.create_mailtm_account(mailtm.get_mailtm_domain())
    assert email.startswith("qatest") and email.endswith("@mail.test")
    assert mailtm_password and app_password and mailtm_password != app_password
    assert mailtm.get_mailtm_token(email, mailtm_password) == "t"
    assert mail.paths == ["GET /domains", "POST /accounts", "POST /token"]


def test_an_address_someone_else_has_is_replaced_once(mail):
    """Mail.tm says the random address is used, and the password doesn't open it: a new address,
    on a domain looked up again."""
    taken = [_answer(422, {"detail": "address: used"}), _answer(401, {"message": "bad"})]
    listed = _answer(200, {"hydra:member": [{"domain": "mail.test", "isActive": True}]})
    mail.answers = [*taken, listed, _answer(201, {"id": "a2"})]
    first = mailtm.create_mailtm_account("mail.test")[0]
    assert mail.paths == ["POST /accounts", "POST /token", "GET /domains", "POST /accounts"]
    mail.paths.clear()
    mail.answers = [*taken, listed, *taken]
    with pytest.raises(mailtm.AddressTaken):
        mailtm.create_mailtm_account("mail.test")
    assert mail.paths.count("POST /accounts") == 2  # one retry, no more
    assert first.endswith("@mail.test")


def test_a_retired_domain_is_replaced_on_the_retry(mail):
    """Mail.tm retires domains: an address at one it no longer serves is refused (422), and the
    retry takes a domain from a fresh list, not the cached one (CI, 2026-11-17: "fldubai.com")."""
    retired = _answer(422, {"violations": [{"propertyPath": "address", "message": "The domain is not valid"}]})
    mail.answers = [
        retired,
        _answer(401, {"message": "bad"}),
        _answer(200, {"hydra:member": [{"domain": "new.test", "isActive": True}]}),
        _answer(201, {"id": "a3"}),
    ]
    email = mailtm.create_mailtm_account("old.test")[0]
    assert email.endswith("@new.test")
    assert mail.paths == ["POST /accounts", "POST /token", "GET /domains", "POST /accounts"]


def test_the_confirmation_code_comes_from_the_inbox(mail):
    mail.answers = [
        _answer(200, {"hydra:member": [{"id": "m1"}]}),
        _answer(200, {"id": "m1", "text": "Welcome, order 1234567", "html": []}),
        _answer(200, {"hydra:member": [{"id": "m2"}, {"id": "m1"}]}),
        _answer(200, {"id": "m2", "text": "", "html": ["<p>Your code: <b>482913</b></p>"]}),
    ]
    assert mailtm.poll_inbox_and_get_code("t") == "482913"


def test_no_code_within_the_poll_window_is_an_error(mail):
    mail.answers = [_answer(200, {"hydra:member": []}) for _ in range(30)]
    with pytest.raises(RuntimeError, match="No confirmation code received within 150s") as missed:
        mailtm.poll_inbox_and_get_code("t")
    assert len(mail.paths) == 19  # at 12 s, then every 8 s to 148 s, and a last look at 150 s
    assert "19 looks at the inbox" in str(missed.value)  # what the wait did, for the CI log


def test_the_invite_path_comes_from_the_invitees_inbox(mail):
    mail.answers = [
        _answer(200, {"token": "t"}),
        _answer(200, {"hydra:member": [{"id": "m1"}]}),
        _answer(200, {"id": "m1", "text": "Join: https://app.test/en/invites/AbC_9-x%2B now"}),
    ]
    user = mailtm.TestUser("u@mail.test", "pw", "id", "refresh", mailtm_password="inbox-pw")
    assert mailtm.wait_for_invite_path(user) == "/en/invites/AbC_9-x%2B"


def test_an_inbox_without_its_password_cannot_be_read(mail):
    with pytest.raises(RuntimeError, match="password is unknown"):
        mailtm.wait_for_invite_path(mailtm.TestUser("u@mail.test", "pw", "id", "refresh"))
