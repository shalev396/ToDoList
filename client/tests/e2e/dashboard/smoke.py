"""
Dashboard page (dashboard) smoke tests.
"""
from playwright.sync_api import Page, expect


def test_dashboard_redirects_unauthenticated(page: Page, app_url: str):
    """Asserts unauthenticated users visiting /dashboard are redirected to /auth/login."""
    page.goto(f"{app_url}/dashboard", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_url(f"{app_url}/auth/login")


def test_dashboard_loads_authenticated(page: Page, app_url: str, authenticated_page: Page):
    """Asserts the dashboard's h1 is exactly "Dashboard" and it is the only heading with that word
    (the auth fixture waits for it by name)."""
    page.goto(f"{app_url}/dashboard", wait_until="load")
    assert "/auth/login" not in page.url, "Authentication failed: redirected to login page"
    expect(page.get_by_role("heading", level=1)).to_have_accessible_name("Dashboard")
    expect(page.get_by_role("heading", name="Dashboard")).to_have_count(1)


def test_dashboard_without_one_offers_the_template(
    page: Page, app_url: str, authenticated_page: Page
):
    """Asserts an owner without a main dashboard gets today's ring and "Create from template"
    (the shared user's workspace never gets a dashboard: tests that need one own theirs)."""
    page.goto(f"{app_url}/dashboard", wait_until="load")
    assert "/auth/login" not in page.url, "Authentication failed: redirected to login page"
    expect(page.get_by_text("Start your dashboard from a template")).to_be_visible()
    expect(page.get_by_role("img", name="Today on a 24-hour clock", exact=False)).to_be_visible()
    expect(page.get_by_role("button", name="Create from template")).to_be_visible()
