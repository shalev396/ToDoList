"""
Landing page (HOME) visual tests — page load at desktop, and the clock is not mirrored in RTL.
"""
from playwright.sync_api import Page, expect

from tests.viewports import DESKTOP_VIEWPORT


def test_landing_visual(page: Page, app_url: str):
    """Asserts the landing page loads at desktop viewport."""
    page.set_viewport_size(DESKTOP_VIEWPORT)
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_url(app_url)


def test_clock_not_mirrored_in_hebrew(page: Page, base_url: str):
    """In Hebrew the page is right-to-left but the clock keeps 06 on the right and 18 on the left."""
    page.set_viewport_size(DESKTOP_VIEWPORT)
    page.goto(f"{base_url}/he", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.locator("html")).to_have_attribute("dir", "rtl")
    clock = page.locator("svg[role='img']").first
    expect(clock).to_be_visible()
    six = clock.locator("text", has_text="06").bounding_box()
    eighteen = clock.locator("text", has_text="18").bounding_box()
    assert six is not None and eighteen is not None
    assert six["x"] > eighteen["x"], "06 must stay on the right of the dial in RTL"
