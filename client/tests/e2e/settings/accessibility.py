"""
Workspace settings accessibility: axe with every rule, English light and Hebrew dark, with
an unsaved change (the save bar) on screen.
"""
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.helpers.animations import wait_for_fade_in
from tests.helpers.workspaces import open_as


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def test_settings_accessibility_en(page: Page, base_url: str, fresh_owner):
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    page.get_by_role("button", name="Add rule").click()
    page.get_by_label("Name", exact=True).fill("Accessible Lab")
    expect(page.get_by_role("button", name="Save changes")).to_be_visible()
    _assert_clean(page)


def test_settings_accessibility_he_dark(page: Page, base_url: str, fresh_owner):
    user, _ = fresh_owner
    page.emulate_media(color_scheme="dark")
    open_as(page, base_url, user, "/he/settings", h1="הגדרות")
    _assert_clean(page)


def test_delete_dialog_accessibility(page: Page, base_url: str, fresh_owner):
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    page.get_by_role("button", name="Delete workspace").click()
    expect(page.get_by_role("alertdialog")).to_be_visible()
    _assert_clean(page)
