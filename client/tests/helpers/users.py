"""
Test accounts backed by real Cognito, the way Elytra makes them (Mail.tm signup, confirm, login).

A signup costs about 15 to 25 seconds (the confirmation email) and Mail.tm calls are scarce (9 a
minute for the whole run), so tests share accounts:

- `pooled_user(api_base_url, role)`: one account per role ("owner", "member", "other", "demo",
  "kanban-scroll") for each pytest worker process. Tests get it through the session fixtures
  `pooled_owner`, `pooled_member`, ... (conftest.py), which make it in setup, the one place
  besides @pytest.mark.email tests where the guard lets Mail.tm be called; a later
  `pooled_user()` call returns the same account. Workers never share a pooled account, so the
  workspace a test creates is always that user's newest (its default) one. Tests own what they
  create (a workspace), never the account.
- `new_user(api_base_url)`: a brand-new account for the tests that need one nobody has used, such as
  one with no workspace (it lands on onboarding) or one whose email an invite names.
- `new_mailbox()`: a real Mail.tm address that was never signed up, for invites to people
  who do not exist: the invite email reaches an inbox instead of bouncing.

`new_user` and `new_mailbox` call Mail.tm: a test that uses them must be tagged
@pytest.mark.email. A second account for two-user flows is just another role. Workspace data is
set up through the API (tests/helpers/workspaces.py), including `load_demo_data=True` (dev and
qa honour it).
"""
from tests.helpers.mailtm import (
    TestUser,
    create_mailtm_account,
    create_test_user,
    get_mailtm_domain,
)

# One entry per (worker process, role): module state is per process, so xdist workers never share.
_POOL: dict[tuple[str, str], TestUser] = {}


def new_user(api_base_url: str, with_workspace: bool = False) -> TestUser:
    """A brand-new account (Mail.tm signup). By default it has no workspace."""
    return create_test_user(api_base_url, with_workspace=with_workspace)


def pooled_user(api_base_url: str, role: str = "owner") -> TestUser:
    """The worker's account for this role, created on first use (in setup: the `pooled_<role>`
    fixtures). It has no workspace of its own."""
    key = (api_base_url, role)
    user = _POOL.get(key)
    if user is None:
        user = new_user(api_base_url)
        _POOL[key] = user
    return user


def new_mailbox() -> str:
    """A real, empty Mail.tm address that nobody signed up with."""
    address, _, _ = create_mailtm_account(get_mailtm_domain())
    return address
