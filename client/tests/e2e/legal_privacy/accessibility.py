"""
Privacy policy page (legal/privacy) accessibility tests.
"""
import pytest
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect
from tests.helpers.animations import wait_for_fade_in


@pytest.mark.parametrize("lng", ["en", "he"])
def test_privacy_accessibility(page: Page, base_url: str, lng: str):
    """Runs axe-core on the privacy page with every rule on; asserts no violations."""
    page.goto(f"{base_url}/{lng}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    wait_for_fade_in(page)
    results = Axe().run(page)
    violations = results.response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


# The policy's parts, as PrivacyPolicyPage.tsx lists them (SECTIONS): one h2 each.
PRIVACY_SECTIONS = 12


def test_privacy_landmarks(page: Page, app_url: str):
    """Asserts one main landmark, one h1, and a section heading per part of the policy."""
    page.goto(f"{app_url}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("main")).to_have_count(1)
    expect(page.get_by_role("heading", level=1)).to_have_count(1)
    expect(page.get_by_role("main").get_by_role("heading", level=2)).to_have_count(
        PRIVACY_SECTIONS
    )
