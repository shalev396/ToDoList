"""
Members accessibility: axe with every rule on the Share dialog, with a member, a pending invite,
a sent invite and the join link on screen, in English light and Hebrew dark.
"""
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.select import choose
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.workspaces import (
    accept_invite,
    create_invite,
    invite_token,
    open_as,
)
from tests.helpers.users import new_mailbox, pooled_user


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def _populate(api_base_url: str, user, workspace_id: str) -> None:
    member = pooled_user(api_base_url, "member")
    created = create_invite(api_base_url, user, workspace_id, member.email, "viewer")
    accept_invite(api_base_url, member, invite_token(created["inviteUrl"]))
    create_invite(api_base_url, user, workspace_id, new_mailbox(), "editor")


def test_members_accessibility_en(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _populate(api_base_url, user, workspace["id"])
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    page.get_by_role("button", name="Share", exact=True).click()
    dialog = page.get_by_role("dialog")
    shown = new_mailbox()
    dialog.get_by_label("Email addresses").fill(shown)
    dialog.get_by_role("button", name="Send invite").click()
    expect(dialog.get_by_role("listitem").filter(has_text=shown)).to_be_visible(timeout=NORMAL_TIMEOUT)
    choose(dialog.get_by_role("combobox", name="General access"), "Anyone with the link")
    expect(dialog.get_by_label("Join link")).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)


def test_members_accessibility_he_dark(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _populate(api_base_url, user, workspace["id"])
    page.emulate_media(color_scheme="dark")
    open_as(page, base_url, user, "/he/settings/members", h1="הגדרות")
    page.get_by_role("button", name="שיתוף", exact=True).click()
    expect(page.get_by_role("dialog")).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)


def test_inline_error_accessibility(page: Page, base_url: str, fresh_owner):
    """The form-level error well (here a 409) keeps AA contrast."""
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings/members", h1="Settings")
    page.get_by_role("button", name="Share", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Email addresses").fill(user.email)
    dialog.get_by_role("button", name="Send invite").click()
    expect(dialog.get_by_role("alert")).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
