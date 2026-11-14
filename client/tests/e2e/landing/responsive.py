"""
Landing page (HOME) responsive tests — 7 viewports from mobile_small to desktop, both languages.
"""
import pytest
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.viewports import VIEWPORTS


@pytest.mark.parametrize("lng", ["en", "he"])
def test_landing_responsive(page: Page, base_url: str, lng: str):
    """Asserts navigation, the h1 and main content are visible at all viewports, with no
    horizontal overflow, in English and in Hebrew (RTL)."""
    for vp in VIEWPORTS:
        page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
        page.goto(f"{base_url}/{lng}", wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("navigation").first).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(page.get_by_role("main")).to_be_visible(timeout=NORMAL_TIMEOUT)
        assert_no_horizontal_overflow(page, f"{vp['name']} ({lng})", vp["width"])


def test_mobile_menu(page: Page, app_url: str):
    """On a phone the links move into a sheet: it opens from the menu button, lists Features,
    Pricing, Sign up and Log in, and closes again."""
    page.set_viewport_size({"width": 375, "height": 667})
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Open menu").click()
    sheet = page.get_by_role("dialog", name="Menu")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.get_by_role("link", name="Features")).to_be_visible()
    expect(sheet.get_by_role("link", name="Pricing")).to_have_attribute("href", "/en/pricing")
    expect(sheet.get_by_role("link", name="Sign up")).to_be_visible()
    expect(sheet.get_by_role("link", name="Log in")).to_be_visible()
    expect(sheet.get_by_role("button", name="עברית")).to_be_visible()
    sheet.get_by_role("button", name="Close menu").click()
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)
