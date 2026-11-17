"""
App shell accessibility: axe with every rule on the dashboard (English light, Hebrew dark), with
the command palette open, in the collapsed rail, and on a phone with the More sheet open.
"""
import re

from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def _open(page: Page, url: str) -> None:
    page.goto(url, wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_dashboard_accessibility_en(page: Page, app_url: str, authenticated_page: Page):
    _open(page, f"{app_url}/dashboard")
    _assert_clean(page)


def test_dashboard_accessibility_he_dark(
    page: Page, base_url: str, authenticated_page: Page
):
    page.emulate_media(color_scheme="dark")
    page.evaluate("() => localStorage.setItem('todolist-ui-theme', 'dark')")
    _open(page, f"{base_url}/he/dashboard")
    expect(page.locator("html")).to_have_class(re.compile(r"\bdark\b"))
    _assert_clean(page)


def test_command_palette_accessibility(page: Page, app_url: str, authenticated_page: Page):
    _open(page, f"{app_url}/dashboard")
    page.keyboard.press("Control+k")
    expect(page.get_by_role("dialog", name="Command menu")).to_be_visible()
    _assert_clean(page)


def test_collapsed_rail_accessibility(page: Page, app_url: str, authenticated_page: Page):
    page.evaluate("() => localStorage.setItem('todolist-sidebar-collapsed', '1')")
    _open(page, f"{app_url}/t/college")
    expect(page.get_by_role("button", name="Expand sidebar")).to_be_visible()
    _assert_clean(page)


def test_phone_more_sheet_accessibility(page: Page, app_url: str, authenticated_page: Page):
    page.set_viewport_size({"width": 390, "height": 844})
    _open(page, f"{app_url}/dashboard")
    page.get_by_role("navigation", name="Sections").get_by_role("button", name="More").click()
    expect(page.get_by_role("dialog", name="More")).to_be_visible()
    _assert_clean(page)


def test_skip_link_reaches_the_page(page: Page, app_url: str, authenticated_page: Page):
    _open(page, f"{app_url}/dashboard")
    page.keyboard.press("Tab")
    skip = page.get_by_role("link", name="Skip to content")
    expect(skip).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.locator("main#main")).to_be_focused()
