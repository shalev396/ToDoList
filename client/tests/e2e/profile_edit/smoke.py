"""
Edit Profile page (profile/edit) smoke tests.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.mailtm import navigate_to_profile_via_ui


def test_edit_profile_redirects_unauthenticated(page: Page, app_url: str):
    """Asserts unauthenticated users visiting /profile/edit are redirected to /auth/login."""
    page.goto(f"{app_url}/profile/edit", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_url(f"{app_url}/auth/login?next=%2Fen%2Fprofile%2Fedit")


def test_edit_profile_elements_authenticated(page: Page, app_url: str, authenticated_page: Page):
    """Asserts the edit profile page shows the Profile back link, Name/Email fields, Save changes when logged in."""
    navigate_to_profile_via_ui(page, app_url, timeout_ms=NORMAL_TIMEOUT)
    assert "/auth/login" not in page.url, "Authentication failed: redirected to login page"
    page.get_by_role("link", name="Edit Profile").click(timeout=NORMAL_TIMEOUT)
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("main").get_by_role("link", name="Profile", exact=True)).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_label("Name", exact=True)).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_label("Email")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("button", name="Save Changes")).to_be_visible(timeout=NORMAL_TIMEOUT)
