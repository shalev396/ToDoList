"""
Pricing page accessibility tests.
"""
import pytest
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page
from tests.helpers.animations import wait_for_fade_in

THEME_STORAGE_KEY = "todolist-ui-theme"


@pytest.mark.parametrize("lng,theme", [("en", "light"), ("he", "dark")])
def test_pricing_accessibility(page: Page, base_url: str, lng: str, theme: str):
    """Runs axe-core on the pricing page; asserts no violations (en light, he dark)."""
    page.goto(f"{base_url}/{lng}/pricing", wait_until="domcontentloaded")
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [THEME_STORAGE_KEY, theme])
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    wait_for_fade_in(page)
    results = Axe().run(page)
    violations = results.response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"
