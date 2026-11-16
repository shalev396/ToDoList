"""
Pricing page responsive tests.
"""
import pytest
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.viewports import VIEWPORTS


@pytest.mark.parametrize("lng,plan", [("en", "Individual"), ("he", "יחיד")])
def test_pricing_responsive(page: Page, base_url: str, lng: str, plan: str):
    """Asserts the plan heading and main content are visible at all viewports, with no horizontal
    overflow, in English and in Hebrew (RTL)."""
    for vp in VIEWPORTS:
        page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
        page.goto(f"{base_url}/{lng}/pricing", wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("heading", name=plan, exact=True)).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(page.get_by_role("main")).to_be_visible(timeout=NORMAL_TIMEOUT)
        assert_no_horizontal_overflow(page, f"{vp['name']} ({lng})", vp["width"])
