"""
The suite's Mail.tm guard (conftest.py), offline: an untagged test may not call Mail.tm, a tagged
one may, and a test whose fixtures or code show it touches Mail.tm without the tag fails before it
starts. Mail.tm is a stub here: nothing leaves the machine.
"""
import os
import sys

import pytest
import requests

from tests.mailtm_client import GUARD, MailTmClient, MailTmNotAllowed


def _conftest():
    """The suite's conftest.py module, wherever pytest registered it."""
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "conftest.py"))
    for module in list(sys.modules.values()):
        if os.path.abspath(getattr(module, "__file__", "") or "") == path:
            return module
    raise AssertionError("conftest.py is not loaded")


class _NeverSent:
    def request(self, *args, **kwargs):
        raise AssertionError("nothing may reach Mail.tm in this test")


class _Stub:
    def request(self, method, url, **kwargs):
        response = requests.Response()
        response.status_code = 200
        response._content = b'{"hydra:member": []}'
        return response


def test_an_untagged_test_may_not_call_mail_tm(request, tmp_path):
    assert GUARD.enabled
    assert GUARD.allowed is None
    assert GUARD.context == request.node.nodeid
    client = MailTmClient(state_dir=str(tmp_path), session=_NeverSent(), live=False)
    before = len(GUARD.violations)
    try:
        with pytest.raises(MailTmNotAllowed, match=r"called mail\.tm \(GET /messages\)"):
            client.list_messages("token")
        assert [v.call for v in GUARD.violations[before:]] == ["GET /messages"]
    finally:
        del GUARD.violations[before:]  # this test's own violation: not a failure of the suite


@pytest.mark.email
def test_a_tagged_test_may(tmp_path):
    """(Tagged only to check the tag works: its Mail.tm is a stub.)"""
    assert GUARD.allowed == "@pytest.mark.email"
    client = MailTmClient(state_dir=str(tmp_path), session=_Stub(), live=False)
    assert client.list_messages("token") == []


class _Item:
    def __init__(self, nodeid, function, fixturenames=(), email=False):
        self.nodeid = nodeid
        self.function = function
        self.fixturenames = list(fixturenames)
        self._email = email

    def get_closest_marker(self, name):
        return object() if name == "email" and self._email else None


def _uses_helpers(api_base_url, new_mailbox, pooled_user):
    """Only read as source, by the collection check."""
    new_mailbox()
    pooled_user(api_base_url, "demo")


def _uses_nothing(page):
    return page


def test_untagged_tests_that_touch_mail_tm_are_found_at_collection():
    problems = _conftest()._mail_problems
    found = problems(_Item("tests/e2e/x.py::test_a", _uses_helpers, ["fresh_user", "page"]))
    assert found == [
        "uses the `fresh_user` fixture",
        "calls new_mailbox()",
        'calls pooled_user(..., "demo") without the `pooled_demo` fixture, which makes that '
        "account in setup",
    ]
    with_fixture = _Item("tests/e2e/x.py::test_b", _uses_helpers, ["pooled_demo"])
    assert problems(with_fixture) == ["calls new_mailbox()"]
    assert problems(_Item("tests/e2e/x.py::test_c", _uses_helpers, ["fresh_user"], email=True)) == []
    assert problems(_Item("tests/e2e/x.py::test_d", _uses_nothing, ["page"])) == []
    assert problems(_Item("tests/mailtm_client/test_x.py::t", _uses_helpers, ["fresh_user"])) == []


def test_each_pooled_role_has_its_setup_fixture(request):
    conftest = _conftest()
    for role in ("owner", "member", "other", "demo", "kanban-scroll"):
        name = conftest.pooled_fixture(role)
        assert callable(getattr(conftest, name)), name
    assert conftest.pooled_fixture("kanban-scroll") == "pooled_kanban_scroll"
