"""
Onboarding (/onboarding): a signed-in user without a workspace creates one, or sees the
invites waiting for their email. Each fresh user is a new Cognito account (Mail.tm signup).
"""
import re

from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.users import pooled_user
from tests.helpers.workspaces import create_invite, open_as, sign_in


def test_onboarding_redirects_unauthenticated(page: Page, app_url: str):
    """A signed-out visitor logs in first and is brought back."""
    page.goto(f"{app_url}/onboarding", wait_until="load")
    expect(page).to_have_url(f"{app_url}/auth/login?next=%2Fen%2Fonboarding")


def test_user_without_workspace_is_sent_to_onboarding(
    page: Page, base_url: str, app_url: str, fresh_user
):
    """The dashboard and the workspace pages send a user without one to onboarding; the
    profile stays reachable."""
    sign_in(page, base_url, fresh_user)
    for path in ("dashboard", "settings", "t/work"):
        page.goto(f"{app_url}/{path}", wait_until="load")
        expect(page).to_have_url(f"{app_url}/onboarding", timeout=LONG_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_text("Welcome to TodoList")
    page.goto(f"{app_url}/profile", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Profile", timeout=NORMAL_TIMEOUT)


def test_login_without_workspace_goes_to_onboarding(page: Page, app_url: str, fresh_user):
    """Logging in through the form with no workspace lands on onboarding."""
    page.goto(f"{app_url}/auth/login", wait_until="load")
    page.get_by_label("Email").fill(fresh_user.email)
    page.get_by_label("Password").fill(fresh_user.password)
    page.get_by_role("button", name="Log in", exact=True).click()
    expect(page).to_have_url(f"{app_url}/onboarding", timeout=LONG_TIMEOUT)


def test_slug_preview_follows_the_name_until_edited(
    page: Page, base_url: str, app_url: str, fresh_user
):
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    name = page.get_by_label("Name", exact=True)
    slug = page.get_by_label("Link name")
    name.fill("Ada Lab 2026")
    expect(slug).to_have_value("ada-lab-2026")
    slug.fill("My Workspace_Name")
    expect(slug).to_have_value("my-workspace-name")
    name.fill("Something else")
    expect(slug).to_have_value("my-workspace-name")


def test_hebrew_name_gets_a_random_slug(page: Page, base_url: str, app_url: str, fresh_user):
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    page.get_by_label("Name", exact=True).fill("לימודים ועבודה")
    expect(page.get_by_label("Link name")).to_have_value(re.compile(r"^workspace-[a-z0-9]{6}$"))


def test_create_workspace_opens_its_dashboard(
    page: Page, base_url: str, app_url: str, fresh_user
):
    """Name, the browser's time zone and demo data (offered on dev and qa), then the new dashboard."""
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    expect(page.get_by_role("checkbox", name="Load demo data")).to_be_checked()
    expect(page.get_by_role("button", name="Create workspace")).to_be_disabled()
    page.get_by_label("Name", exact=True).fill("Ada Lab")
    page.get_by_role("button", name="Create workspace").click()
    expect(page).to_have_url(f"{app_url}/dashboard", timeout=LONG_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_accessible_name("Dashboard")
    expect(page.get_by_role("button", name="Ada Lab, switch workspace")).to_be_visible()


def test_create_without_demo_data_starts_with_one_empty_personal_page(
    page: Page, base_url: str, app_url: str, fresh_user
):
    """D1: no demo data means the Personal topic only and one empty Personal page, with a friendly
    empty state: Add block and Use a template."""
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    page.get_by_role("checkbox", name="Load demo data").uncheck()
    page.get_by_label("Name", exact=True).fill("Minimal Lab")
    page.get_by_role("button", name="Create workspace").click()
    expect(page).to_have_url(f"{app_url}/t/personal", timeout=LONG_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_text("Personal")
    expect(page.get_by_text("This page is empty")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("button", name="Add block")).to_be_visible()
    expect(page.get_by_role("link", name="Use a template")).to_be_visible()
    nav = page.get_by_role("navigation", name="Main")
    expect(nav.get_by_role("link", name="Personal", exact=True)).to_be_visible()
    for topic in ("Work", "College"):
        expect(nav.get_by_role("link", name=topic, exact=True)).to_have_count(0)


def test_taken_slug_is_reported_on_the_field(
    page: Page, base_url: str, app_url: str, api_base_url: str, fresh_user, new_workspace
):
    owner = pooled_user(api_base_url, "owner")
    taken = new_workspace(owner, "Taken Lab")["slug"]
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    page.get_by_label("Name", exact=True).fill("Another Lab")
    page.get_by_label("Link name").fill(taken)
    page.get_by_role("button", name="Create workspace").click()
    expect(page.get_by_text("That link name is taken. Try another one.")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(page).to_have_url(f"{app_url}/onboarding")


def test_pending_invites_are_listed(
    page: Page, base_url: str, app_url: str, api_base_url: str, fresh_user, new_workspace
):
    """Invites sent to my email show with the workspace's name; joining needs the link."""
    owner = pooled_user(api_base_url, "owner")
    workspace = new_workspace(owner, "Invite Lab")
    create_invite(api_base_url, owner, workspace["id"], fresh_user.email, "viewer")
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    invites = page.get_by_role("region", name=f"Invites for {fresh_user.email}")
    expect(invites.get_by_text("Invite Lab")).to_be_visible()
    expect(invites.get_by_text("Viewer access, valid until", exact=False)).to_be_visible()
    expect(invites.get_by_text("To join, open the link in the invite email.")).to_be_visible()


def test_onboarding_for_a_second_workspace(
    page: Page, base_url: str, app_url: str, fresh_owner
):
    """From the switcher's "Create workspace": a way back to the current one."""
    user, workspace = fresh_owner
    open_as(page, base_url, user, "/en/onboarding", h1="Create a workspace")
    page.get_by_role("link", name=f"Back to {workspace['name']}").click()
    expect(page).to_have_url(f"{app_url}/dashboard", timeout=NORMAL_TIMEOUT)
