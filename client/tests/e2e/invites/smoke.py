"""
The invite accept page (/invites/:token): logging in first and coming back, accepting, and the
messages for another email (403), a link that no longer works (404/410) and a used one (409).
"""
import re
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.workspaces import (
    accept_invite,
    create_invite,
    invite_path,
    invite_token,
    open_as,
    sign_in,
)
from tests.helpers.users import new_mailbox, new_user, pooled_user

UNKNOWN_TOKEN = "Zz9_-abcdefghijklmnopqrstuvwxyz0123456789AB"


def _invite(api_base_url: str, new_workspace, email: str, role: str = "viewer"):
    """An invite of the worker's owner account to a new workspace (deleted after the test)."""
    owner = pooled_user(api_base_url, "owner")
    workspace = new_workspace(owner, "Invite Lab")
    created = create_invite(api_base_url, owner, workspace["id"], email, role)
    return owner, workspace, created["inviteUrl"]


def test_signed_out_visitor_logs_in_and_comes_back(
    page: Page, base_url: str, api_base_url: str, new_workspace
):
    guest = new_user(api_base_url)
    email = guest.email
    _, workspace, url = _invite(api_base_url, new_workspace, email)
    path = invite_path(url)
    page.goto(f"{base_url}{path}", wait_until="load")
    expect(page).to_have_url(re.compile(r"/en/auth/login\?next=%2Fen%2Finvites%2F"))
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill(guest.password)
    page.get_by_role("button", name="Log in", exact=True).click()
    expect(page).to_have_url(f"{base_url}{path}", timeout=LONG_TIMEOUT)
    page.get_by_role("button", name="Accept invite").click()
    expect(page).to_have_url(f"{base_url}/en/dashboard", timeout=LONG_TIMEOUT)
    expect(page.get_by_role("button", name=f"{workspace['name']}, switch workspace")).to_be_visible()


def test_unknown_link_says_it_no_longer_works(page: Page, base_url: str, fresh_owner):
    user, _ = fresh_owner
    open_as(page, base_url, user, f"/en/invites/{UNKNOWN_TOKEN}", h1="Join a workspace")
    page.get_by_role("button", name="Accept invite").click()
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "This invite link no longer works", timeout=NORMAL_TIMEOUT
    )


def test_invite_for_another_email(
    page: Page, base_url: str, api_base_url: str, fresh_owner, new_workspace
):
    user, _ = fresh_owner
    _, _, url = _invite(api_base_url, new_workspace, new_mailbox())
    open_as(page, base_url, user, invite_path(url), h1="Join a workspace")
    page.get_by_role("button", name="Accept invite").click()
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "This invite is for another email address", timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_role("alert")).to_contain_text(user.email)
    expect(page.get_by_role("button", name="Sign in with another account")).to_be_visible()


def test_another_account_comes_back_to_the_invite(
    page: Page, base_url: str, api_base_url: str, fresh_owner, new_workspace
):
    """"Sign in with another account" signs out and opens the login page with this invite as
    next, so the invited person comes straight back to it."""
    user, _ = fresh_owner
    _, _, url = _invite(api_base_url, new_workspace, new_mailbox())
    path = invite_path(url)
    open_as(page, base_url, user, path, h1="Join a workspace")
    page.get_by_role("button", name="Accept invite").click()
    page.get_by_role("button", name="Sign in with another account").click()
    expect(page).to_have_url(re.compile(r"/en/auth/login\?next="), timeout=NORMAL_TIMEOUT)
    assert parse_qs(urlparse(page.url).query)["next"] == [path]
    expect(page.get_by_role("heading", level=1)).to_be_visible()


def test_used_invite(page: Page, base_url: str, api_base_url: str, second_user, new_workspace):
    invitee = second_user
    _, _, url = _invite(api_base_url, new_workspace, invitee.email)
    accept_invite(api_base_url, invitee, invite_token(url))
    open_as(page, base_url, invitee, invite_path(url), h1="Join a workspace")
    page.get_by_role("button", name="Accept invite").click()
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "This invite has already been used", timeout=NORMAL_TIMEOUT
    )


def test_revoked_invite(page: Page, base_url: str, api_base_url: str, second_user, new_workspace):
    import requests

    invitee = second_user
    owner, workspace, url = _invite(api_base_url, new_workspace, invitee.email)
    invite_id = requests.get(
        f"{api_base_url}/private/workspaces/{workspace['id']}/invites",
        headers={"Authorization": f"Bearer {owner.id_token}"},
        timeout=15,
    ).json()["data"][0]["id"]
    requests.delete(
        f"{api_base_url}/private/workspaces/{workspace['id']}/invites/{invite_id}",
        headers={"Authorization": f"Bearer {owner.id_token}"},
        timeout=15,
    ).raise_for_status()
    sign_in(page, base_url, invitee)
    page.goto(f"{base_url}{invite_path(url)}", wait_until="load")
    page.get_by_role("button", name="Accept invite").click()
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "This invite link no longer works", timeout=NORMAL_TIMEOUT
    )
