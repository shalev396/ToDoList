"""
The shell at every viewport, in both languages: the sidebar from 768px, the tab bar below it,
and never a horizontal scroll. On a touch screen, every control of the app frame is a 44px
target (tests/helpers/tap_targets.py).
"""
import pytest
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.select import choose
from tests.helpers.workspaces import (
    accept_invite,
    create_invite,
    create_workspace,
    invite_path,
    invite_token,
    sign_in,
)
from tests.helpers.users import new_mailbox, pooled_user
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.helpers.tap_targets import assert_touch_screen, reset_allowed, small_targets, stale_allowed
from tests.viewports import VIEWPORTS

PHONE = {"width": 375, "height": 812}
TOP_BAR = 'header:has(> button[aria-label="Search"])'
TAB_BAR = 'nav[aria-label="Sections"]'

NAV_NAMES = {"en": ("Main", "Sections"), "he": ("ראשי", "אזורים")}


def test_shell_responsive(page: Page, base_url: str, authenticated_page: Page):
    for lng in ("en", "he"):
        main_nav, tab_bar = NAV_NAMES[lng]
        for path in ("dashboard", "t/college", "templates"):
            for vp in VIEWPORTS:
                page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
                page.goto(f"{base_url}/{lng}/{path}", wait_until="load")
                expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
                if vp["width"] >= 768:
                    expect(page.get_by_role("navigation", name=main_nav)).to_be_visible()
                    expect(page.get_by_role("navigation", name=tab_bar)).to_be_hidden()
                else:
                    expect(page.get_by_role("navigation", name=tab_bar)).to_be_visible()
                    expect(page.get_by_role("navigation", name=main_nav)).to_be_hidden()
                assert_no_horizontal_overflow(page, f"{lng}-{path}-{vp['name']}", vp["width"])


@pytest.fixture
def touch_page(browser, browser_context_args):
    """A phone: 375px wide with a touch screen, so (pointer: coarse) matches."""
    context = browser.new_context(
        **{**browser_context_args, "viewport": PHONE, "is_mobile": True, "has_touch": True}
    )
    page = context.new_page()
    yield page
    context.close()


def _report(problems: list) -> None:
    assert not problems, "Tap targets under 44px on a touch screen:\n" + "\n".join(problems)


def test_tap_targets_signed_out(touch_page: Page, base_url: str):
    page = touch_page
    reset_allowed()
    problems = []
    for path in ("auth/login", "auth/signup", "auth/forgot-password"):
        page.goto(f"{base_url}/en/{path}", wait_until="load")
        expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
        assert_touch_screen(page)
        problems += small_targets(page, path)
    _report(problems)
    assert not stale_allowed(), f"Allow-list entries no page needed: {stale_allowed()}"


def test_tap_targets_onboarding_and_invite(touch_page: Page, base_url: str, api_base_url: str, fresh_user):
    page = touch_page
    problems = []
    sign_in(page, base_url, fresh_user)
    page.goto(f"{base_url}/en/onboarding", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert_touch_screen(page)
    problems += small_targets(page, "onboarding")

    owner = pooled_user(api_base_url, "owner")
    workspace = create_workspace(api_base_url, owner, "Tap Lab", timezone="Asia/Jerusalem")
    invite = create_invite(api_base_url, owner, workspace["id"], fresh_user.email)
    page.goto(f"{base_url}{invite_path(invite['inviteUrl'])}", wait_until="load")
    expect(page.get_by_role("button", name="Accept invite")).to_be_visible(timeout=NORMAL_TIMEOUT)
    problems += small_targets(page, "invite accept")
    _report(problems)


def test_tap_targets_shell_settings_members(
    touch_page: Page, base_url: str, api_base_url: str, fresh_owner, second_user
):
    """The shell's bars and More sheet (the dashboard's own blocks belong to the dashboard
    suites), settings with a rule, and members with a member, a pending invite and a new link."""
    page = touch_page
    owner, workspace = fresh_owner
    member = second_user
    invite = create_invite(api_base_url, owner, workspace["id"], member.email, role="editor")
    accept_invite(api_base_url, member, invite_token(invite["inviteUrl"]))
    create_invite(api_base_url, owner, workspace["id"], new_mailbox())
    problems = []

    sign_in(page, base_url, owner)
    page.goto(f"{base_url}/en/dashboard", wait_until="load")
    expect(page.get_by_role("navigation", name="Sections")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert_touch_screen(page)
    problems += small_targets(page, "top bar", TOP_BAR)
    problems += small_targets(page, "tab bar", TAB_BAR)
    page.get_by_role("navigation", name="Sections").get_by_role("button", name="More").click()
    expect(page.get_by_role("dialog", name="More")).to_be_visible()
    problems += small_targets(page, "More sheet", "[role=dialog]")
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog", name="More")).to_be_hidden()

    page.goto(f"{base_url}/en/settings", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Settings", timeout=NORMAL_TIMEOUT)
    page.get_by_role("button", name="Add rule").click()
    problems += small_targets(page, "settings")

    page.goto(f"{base_url}/en/settings/members", wait_until="load")
    page.get_by_role("button", name="Share", exact=True).click()
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_role("heading", name="Pending invites")).to_be_visible(timeout=NORMAL_TIMEOUT)
    dialog.get_by_label("Email addresses").fill(new_mailbox())
    dialog.get_by_role("button", name="Send invite").click()
    expect(page.get_by_text("Invite sent")).to_be_visible(timeout=NORMAL_TIMEOUT)
    choose(dialog.get_by_role("combobox", name="General access"), "Anyone with the link")
    expect(dialog.get_by_role("button", name="Reset link")).to_be_visible(timeout=NORMAL_TIMEOUT)
    problems += small_targets(page, "members")
    _report(problems)
