"""The workspace helpers' clean-up, offline: requests is stubbed, no stage is touched.

With nothing stored, the app opens an account's oldest workspace. A workspace a test failed to
delete is older than the next test's, so that test opened the wrong one: on deployed qa, under
throttling, a block was added to the left-behind workspace's page (the test then read its own:
StopIteration) and an item opened in the wrong workspace said it didn't exist.
"""
from types import SimpleNamespace

import pytest

from tests.helpers import workspaces

API = "https://api.test/api"
USER = SimpleNamespace(email="pooled@mail.test", id_token="t")


class _Answer:
    def __init__(self, status: int, data=None, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._data = data
        self.text = "" if data is None else "{}"

    def json(self):
        return {"data": self._data}


@pytest.fixture
def api(monkeypatch):
    """`api.answers`: what each call gets, in order; `api.calls`: what was asked; no sleeping."""
    state = SimpleNamespace(answers=[], calls=[], slept=[])

    def call(method):
        def send(url, **kwargs):
            state.calls.append(f"{method} {url.removeprefix(API)}")
            answer = state.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        return send

    monkeypatch.setattr(workspaces.requests, "delete", call("DELETE"))
    monkeypatch.setattr(workspaces.requests, "get", call("GET"))
    monkeypatch.setattr(workspaces.time, "sleep", state.slept.append)
    monkeypatch.setattr(workspaces, "_LEFT_BEHIND", set())
    return state


def test_a_throttled_delete_is_tried_again(api):
    api.answers = [_Answer(429, headers={"Retry-After": "2"}), _Answer(503), _Answer(204)]
    assert workspaces.delete_workspace(API, USER, "w1") is True
    assert api.calls == ["DELETE /private/workspaces/w1"] * 3
    assert api.slept == [2.0, 2.0]
    assert workspaces._LEFT_BEHIND == set()


def test_a_workspace_already_gone_counts_as_deleted(api):
    api.answers = [_Answer(404)]
    assert workspaces.delete_workspace(API, USER, "w1") is True
    assert workspaces._LEFT_BEHIND == set()


def test_a_delete_that_keeps_failing_marks_the_account(api):
    api.answers = [_Answer(429)] * 4
    assert workspaces.delete_workspace(API, USER, "w1") is False
    assert len(api.calls) == 4
    assert (API, USER.email) in workspaces._LEFT_BEHIND


def test_a_refused_delete_is_not_retried(api):
    api.answers = [_Answer(403)]
    assert workspaces.delete_workspace(API, USER, "w1") is False
    assert len(api.calls) == 1
    assert (API, USER.email) in workspaces._LEFT_BEHIND


def test_the_next_workspace_starts_with_the_left_behind_ones_deleted(api):
    api.answers = [_Answer(429)] * 4
    workspaces.delete_workspace(API, USER, "old")
    owned = [{"role": "owner", "workspace": {"id": "old"}}, {"role": "viewer", "workspace": {"id": "x"}}]
    api.calls.clear()
    api.answers = [_Answer(200, owned), _Answer(204)]
    workspaces.forget_left_behind(API, USER)
    assert api.calls == ["GET /private/workspaces", "DELETE /private/workspaces/old"]
    assert workspaces._LEFT_BEHIND == set()


def test_left_behind_ones_that_cannot_be_deleted_stop_the_test(api):
    workspaces._LEFT_BEHIND.add((API, USER.email))
    api.answers = [_Answer(200, [{"role": "owner", "workspace": {"id": "old"}}]), *[_Answer(500)] * 4]
    with pytest.raises(RuntimeError, match="oldest"):
        workspaces.forget_left_behind(API, USER)


def test_an_account_with_nothing_left_behind_is_not_asked(api):
    workspaces.forget_left_behind(API, USER)
    assert api.calls == []
