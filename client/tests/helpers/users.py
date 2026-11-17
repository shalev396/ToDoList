"""
Test accounts backed by real Cognito, the way Elytra makes them (Mail.tm signup, confirm, login).

A signup costs about 15 to 25 seconds (the confirmation email), so tests share accounts:

- `pooled_user(api_base_url, role)`: one account per role ("owner", "member", "other") for each
  pytest worker process, created on first use. Workers never share a pooled account, so the
  workspace a test creates is always that user's newest (its default) one. Tests own what they
  create (a workspace), never the account.
- `new_user(api_base_url)`: a brand-new account for the tests that need one nobody has used, such as
  one with no workspace (it lands on onboarding) or one whose email an invite names.
- `new_mailbox()`: a real Mail.tm address that was never signed up, for invites to people
  who do not exist: the invite email reaches an inbox instead of bouncing.

A second account for two-user flows is just another role. Workspace data is set up through the
API (tests/helpers/workspaces.py), including `load_demo_data=True` (dev and qa honour it).
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
    """The worker's account for this role, created on first use. It has no workspace of its own."""
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
