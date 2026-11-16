"""
tests/helpers/mailtm.py, offline: it only wires the project's settings into tests/mailtm_client
(whose own tests cover the shared rate limit and the 429 handling). Mail.tm is a stub here, and
the clock a fake one, so nothing waits.
"""
import json

import pytest
import requests

from tests.helpers import mailtm
from tests.mailtm_client import MailTmClient


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
    )
    monkeypatch.setattr(mailtm, "_client", client)
    return Session


def test_one_client_per_process_on_the_real_mail_tm(monkeypatch):
    monkeypatch.setattr(mailtm, "_client", None)
    client = mailtm.get_mailtm_client()
    assert client is mailtm.get_mailtm_client()
    assert client.base_url == "https://api.mail.tm"


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
    """Mail.tm says the random address is used, and the password doesn't open it: a new address."""
    taken = [_answer(422, {"detail": "address: used"}), _answer(401, {"message": "bad"})]
    mail.answers = [*taken, _answer(201, {"id": "a2"})]
    first = mailtm.create_mailtm_account("mail.test")[0]
    assert mail.paths == ["POST /accounts", "POST /token", "POST /accounts"]
    mail.paths.clear()
    mail.answers = [*taken, *taken]
    with pytest.raises(mailtm.AddressTaken):
        mailtm.create_mailtm_account("mail.test")
    assert mail.paths.count("POST /accounts") == 2  # one retry, no more
    assert first.endswith("@mail.test")


def test_the_confirmation_code_comes_from_the_inbox(mail):
    mail.answers = [
        _answer(200, {"hydra:member": [{"id": "m1"}]}),
        _answer(200, {"id": "m1", "text": "Welcome, order 1234567", "html": []}),
        _answer(200, {"hydra:member": [{"id": "m2"}, {"id": "m1"}]}),
        _answer(200, {"id": "m2", "text": "", "html": ["<p>Your code: <b>482913</b></p>"]}),
    ]
    assert mailtm.poll_inbox_and_get_code("t") == "482913"


def test_no_code_within_a_minute_is_an_error(mail):
    mail.answers = [_answer(200, {"hydra:member": []}) for _ in range(10)]
    with pytest.raises(RuntimeError, match="No confirmation code"):
        mailtm.poll_inbox_and_get_code("t")
    assert len(mail.paths) == 7  # at 12 s, then every 8 s up to 60 s


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
