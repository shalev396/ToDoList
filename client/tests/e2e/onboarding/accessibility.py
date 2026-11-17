"""
Onboarding accessibility: axe with every rule, in English (light) and Hebrew (dark).
"""
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.helpers.animations import wait_for_fade_in
from tests.helpers.workspaces import open_as


def _violations(page: Page) -> list:
    wait_for_fade_in(page)
    return Axe().run(page).response.get("violations", [])


def test_onboarding_accessibility_en(page: Page, base_url: str, fresh_user):
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    page.get_by_label("Name", exact=True).fill("Ada Lab")
    violations = _violations(page)
    assert violations == [], f"Accessibility violations: {violations}"


def test_onboarding_accessibility_he_dark(page: Page, base_url: str, fresh_user):
    page.emulate_media(color_scheme="dark")
    open_as(page, base_url, fresh_user, "/he/onboarding")
    expect(page.locator("html")).to_have_attribute("dir", "rtl")
    expect(page.get_by_role("heading", level=1)).to_be_visible()
    violations = _violations(page)
    assert violations == [], f"Accessibility violations: {violations}"


def test_onboarding_fields_have_labels(page: Page, base_url: str, fresh_user):
    open_as(page, base_url, fresh_user, "/en/onboarding", h1="Welcome to TodoList")
    expect(page.get_by_label("Name", exact=True)).to_be_visible()
    expect(page.get_by_label("Link name")).to_be_visible()
    expect(page.get_by_label("Time zone")).to_be_visible()
    expect(page.get_by_role("checkbox", name="Load demo data")).to_be_visible()
