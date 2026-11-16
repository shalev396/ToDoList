"""
Members (/settings/members): the Share dialog. Adding people (invites go to real Mail.tm inboxes),
who has access (change access, remove people, revoke invites) and general access (the join link).
Each test owns a fresh workspace (deleted after it); other people are the worker's pooled accounts.
"""
import re

import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.select import choose
from tests.helpers.workspaces import (
    accept_invite,
    create_invite,
    invite_token,
    open_as,
    sign_in,
)
from tests.helpers.users import new_mailbox, pooled_user


def _members(api_base_url: str, user, workspace_id: str) -> list:
    response = requests.get(
        f"{api_base_url}/private/workspaces/{workspace_id}/members",
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()["data"]


def _add_member(api_base_url: str, owner, workspace_id: str, role: str = "viewer"):
    """The worker's second account, after it accepted an invite (through the API)."""
    member = pooled_user(api_base_url, "member")
    created = create_invite(api_base_url, owner, workspace_id, member.email, role)
    accept_invite(api_base_url, member, invite_token(created["inviteUrl"]))
    return member


def _shown_name(api_base_url: str, owner, workspace_id: str, member) -> str:
    """The member's name as the list shows it (and names its controls): their profile name, else
    their email."""
    row = next(m for m in _members(api_base_url, owner, workspace_id) if m["email"] == member.email)
    return row["name"] or member.email


def _open_share(page: Page):
    """Opens the Share dialog of the members page and returns it."""
    page.get_by_role("button", name="Share", exact=True).click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=NORMAL_TIMEOUT)
    return dialog


def test_members_redirects_unauthenticated(page: Page, app_url: str):
    page.goto(f"{app_url}/settings/members", wait_until="load")
    expect(page).to_have_url(f"{app_url}/auth/login?next=%2Fen%2Fsettings%2Fmembers")


def test_invite_is_sent_and_waits_in_the_pending_list(page: Page, base_url: str, fresh_owner):
    """Send invite emails the address (the toast says so; the link is never shown or logged) and
    the invite waits in the pending list with its role."""
    user, _ = fresh_owner
    console: list[str] = []
    page.on("console", lambda message: console.append(message.text))
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)

    email = new_mailbox()
    dialog.get_by_label("Email addresses").fill(email)
    choose(dialog.get_by_label("Access", exact=True), "Can edit")
    dialog.get_by_label("Message (optional)").fill("Welcome aboard")
    dialog.get_by_role("button", name="Send invite").click()

    expect(page.get_by_text("Invite sent")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(dialog.get_by_role("region", name=re.compile("^Invite link for"))).to_have_count(0)
    assert not [line for line in console if "/invites/" in line], "an invite link reached the console"

    page.reload(wait_until="load")
    dialog = _open_share(page)
    expect(dialog.get_by_role("heading", name="Pending invites")).to_be_visible(timeout=NORMAL_TIMEOUT)
    pending = dialog.get_by_role("listitem").filter(has_text=email)
    expect(pending).to_contain_text("Editor")
    # A workspace is shared whole: no topic scope to show.
    expect(pending).not_to_contain_text("All topics")


def test_several_emails_each_get_an_invite(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    first, second = new_mailbox(), new_mailbox()
    dialog.get_by_label("Email addresses").fill(f"{first}, {second}")
    dialog.get_by_role("button", name="Send invite").click()
    expect(page.get_by_text("2 invites sent")).to_be_visible(timeout=NORMAL_TIMEOUT)
    invites = requests.get(
        f"{api_base_url}/private/workspaces/{workspace['id']}/invites",
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    ).json()["data"]
    assert {invite["email"] for invite in invites} == {first, second}


def test_a_malformed_address_is_named(page: Page, base_url: str, fresh_owner):
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    dialog.get_by_label("Email addresses").fill("ok@example.com, nope")
    expect(dialog.get_by_role("button", name="Send invite")).to_be_disabled()


def test_inviting_a_member_again_is_refused_inline(page: Page, base_url: str, fresh_owner):
    """A 409 is shown next to the form, not only as a toast."""
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    dialog.get_by_label("Email addresses").fill(user.email)
    dialog.get_by_role("button", name="Send invite").click()
    expect(dialog.get_by_role("alert")).to_contain_text("already a member", timeout=NORMAL_TIMEOUT)


def test_revoke_a_pending_invite(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    email = new_mailbox()
    create_invite(api_base_url, user, workspace["id"], email)
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    dialog.get_by_role("button", name=f"Revoke the invite for {email}").click()
    expect(page.get_by_text("Invite revoked")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(dialog.get_by_text("No pending invites.")).to_be_visible()


def test_owner_changes_a_role(page: Page, base_url: str, api_base_url: str, fresh_owner):
    """A workspace is shared whole (PERMISSIONS-V2): a member has a role, and no topic menu."""
    user, workspace = fresh_owner
    member = _add_member(api_base_url, user, workspace["id"])
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    name = _shown_name(api_base_url, user, workspace["id"], member)

    expect(dialog.get_by_role("button", name=re.compile(rf"^Topics {re.escape(name)} sees"))).to_have_count(0)
    choose(dialog.get_by_label(f"Role of {name}"), "Can edit")
    expect(page.get_by_text("Access updated").first).to_be_visible(timeout=NORMAL_TIMEOUT)

    row = next(m for m in _members(api_base_url, user, workspace["id"]) if m["email"] == member.email)
    assert row["role"] == "editor"
    assert "areaScope" not in row


def test_owner_removes_a_member(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    member = _add_member(api_base_url, user, workspace["id"])
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    name = _shown_name(api_base_url, user, workspace["id"], member)
    dialog.get_by_role("button", name=f"Remove {name}").click()
    page.get_by_role("alertdialog").get_by_role("button", name="Remove").click()
    expect(page.get_by_text(f"{name} was removed")).to_be_visible(timeout=NORMAL_TIMEOUT)
    emails = [m["email"] for m in _members(api_base_url, user, workspace["id"])]
    assert member.email not in emails


def test_removed_member_is_reset_like_a_switch(
    page: Page, base_url: str, api_base_url: str, fresh_owner, new_workspace
):
    """Review focus 2: when the current workspace leaves my list (its owner removed me), the
    app resets as on a switch: the open dialog closes, the old workspace's data goes, and I
    land on the dashboard of the workspace I still have."""
    owner, workspace = fresh_owner
    member = _add_member(api_base_url, owner, workspace["id"])
    home = new_workspace(member, "Member Home")
    sign_in(page, base_url, member)
    page.evaluate("(id) => localStorage.setItem('todolist-current-workspace', id)", workspace["id"])
    page.goto(f"{base_url}/en/settings/members", wait_until="load")
    switcher = page.get_by_role("navigation", name="Main")
    expect(switcher.get_by_role("button", name=f"{workspace['name']}, switch workspace")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    page.get_by_role("button", name="Leave workspace").click()
    expect(page.get_by_role("alertdialog")).to_be_visible()

    row = next(m for m in _members(api_base_url, owner, workspace["id"]) if m["email"] == member.email)
    requests.delete(
        f"{api_base_url}/private/workspaces/{workspace['id']}/members/{row['userId']}",
        headers={"Authorization": f"Bearer {owner.id_token}"},
        timeout=15,
    ).raise_for_status()
    # Coming back to the tab refetches my workspaces (refetchOnWindowFocus: 'always').
    page.evaluate("() => window.dispatchEvent(new Event('visibilitychange'))")

    expect(page).to_have_url(re.compile(rf"^{re.escape(base_url)}/en/(dashboard|t/personal)$"), timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("alertdialog")).to_have_count(0)
    expect(switcher.get_by_role("button", name=f"{home['name']}, switch workspace")).to_be_visible()


def test_owner_row_cannot_be_changed(page: Page, base_url: str, fresh_owner):
    """The owner (me) is listed with the role, without controls."""
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    me = dialog.get_by_role("listitem").filter(has_text="(you)")
    expect(me).to_contain_text("Owner")
    expect(me.get_by_role("combobox")).to_have_count(0)
    expect(me.get_by_role("button")).to_have_count(0)


def test_a_member_sees_who_has_access_read_only(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """Everyone may open Share, but only the owner can add people or change access."""
    owner, workspace = fresh_owner
    member = _add_member(api_base_url, owner, workspace["id"], role="editor")
    open_as(page, base_url, member, "/en/settings/members", h1="Workspace", workspace_id=workspace["id"])
    dialog = _open_share(page)
    expect(dialog.get_by_role("heading", name="People with access")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(dialog.get_by_text(owner.email)).to_be_visible()
    expect(dialog.get_by_label("Email addresses")).to_have_count(0)
    expect(dialog.get_by_text("General access")).to_have_count(0)
    expect(dialog.get_by_role("combobox")).to_have_count(0)


def test_anyone_with_the_link_joins_as_a_viewer(
    page: Page, base_url: str, api_base_url: str, fresh_owner, browser_context_args
):
    """General access: the owner turns on "Anyone with the link" (Can view); a second user, with
    no invite, opens the link and becomes a viewer. Reset kills the old link;
    Restricted turns it off."""
    owner, workspace = fresh_owner
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    open_as(page, base_url, owner, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)

    access = dialog.get_by_role("combobox", name="General access")
    expect(access).to_have_text("Restricted", timeout=NORMAL_TIMEOUT)
    choose(access, "Anyone with the link")
    link_field = dialog.get_by_label("Join link")
    expect(link_field).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(dialog.get_by_text("can join and view")).to_be_visible()
    link = link_field.input_value()
    assert re.search(r"/en/join/[A-Za-z0-9_-]{43}$", link), link
    dialog.get_by_role("button", name="Copy link").click()
    assert page.evaluate("() => navigator.clipboard.readText()") == link

    guest = pooled_user(api_base_url, "member")
    # The test's own context arguments: on a deployed dev/qa site they carry the WAF gate's
    # basic-auth credentials (conftest.py), without which the join page never loads.
    guest_page = page.context.browser.new_context(**browser_context_args).new_page()
    try:
        sign_in(guest_page, base_url, guest)
        guest_page.goto(link.replace(re.match(r"https?://[^/]+", link).group(0), base_url), wait_until="load")
        expect(guest_page.get_by_role("heading", level=1)).to_have_text("Join a workspace", timeout=NORMAL_TIMEOUT)
        guest_page.get_by_role("button", name="Join workspace").click()
        expect(guest_page).to_have_url(re.compile(r"/en/(dashboard|t/personal)$"), timeout=LONG_TIMEOUT)
        expect(
            guest_page.get_by_role("button", name=f"{workspace['name']}, switch workspace")
        ).to_be_visible(timeout=NORMAL_TIMEOUT)
    finally:
        guest_page.context.close()
    row = next(m for m in _members(api_base_url, owner, workspace["id"]) if m["email"] == guest.email)
    assert row["role"] == "viewer"

    # Reset: a new link; the old one is dead.
    dialog.get_by_role("button", name="Reset link").click()
    page.get_by_role("alertdialog").get_by_role("button", name="Reset link").click()
    expect(link_field).not_to_have_value(link, timeout=NORMAL_TIMEOUT)
    late = pooled_user(api_base_url, "other")
    old_token = link.rsplit("/", 1)[1]
    response = requests.post(
        f"{api_base_url}/private/join-links/accept",
        json={"token": old_token},
        headers={"Authorization": f"Bearer {late.id_token}"},
        timeout=15,
    )
    assert response.status_code == 404

    # Restricted: nothing to copy any more.
    choose(access, "Restricted")
    expect(dialog.get_by_label("Join link")).to_have_count(0, timeout=NORMAL_TIMEOUT)


def test_a_join_link_can_give_edit_access(page: Page, base_url: str, api_base_url: str, fresh_owner):
    owner, workspace = fresh_owner
    open_as(page, base_url, owner, "/en/settings/members", h1="Settings")
    dialog = _open_share(page)
    choose(dialog.get_by_role("combobox", name="General access"), "Anyone with the link")
    choose(dialog.get_by_role("combobox", name="What the link allows"), "Can edit")
    link_field = dialog.get_by_label("Join link")
    expect(dialog.get_by_text("can join and edit")).to_be_visible(timeout=NORMAL_TIMEOUT)
    token = link_field.input_value().rsplit("/", 1)[1]

    guest = pooled_user(api_base_url, "member")
    response = requests.post(
        f"{api_base_url}/private/join-links/accept",
        json={"token": token},
        headers={"Authorization": f"Bearer {guest.id_token}"},
        timeout=15,
    )
    assert response.status_code == 200, response.text
    row = next(m for m in _members(api_base_url, owner, workspace["id"]) if m["email"] == guest.email)
    assert row["role"] == "editor"
