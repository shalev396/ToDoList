"""
Onboarding at every viewport, in both languages: the form is visible and nothing overflows.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.workspaces import sign_in
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.viewports import VIEWPORTS


def test_onboarding_responsive(page: Page, base_url: str, fresh_user):
    sign_in(page, base_url, fresh_user)
    for lng in ("en", "he"):
        for vp in VIEWPORTS:
            page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
            page.goto(f"{base_url}/{lng}/onboarding", wait_until="load")
            expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
            expect(page.locator("form button[type=submit]")).to_be_visible()
            assert_no_horizontal_overflow(page, f"{lng}-{vp['name']}", vp["width"])
