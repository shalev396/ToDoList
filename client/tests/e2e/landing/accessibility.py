"""
Landing page (HOME) accessibility tests — axe scans and heading hierarchy.
"""
import pytest
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect
from tests.helpers.animations import wait_for_fade_in

THEME_STORAGE_KEY = "todolist-ui-theme"


@pytest.mark.parametrize("lng,theme", [("en", "light"), ("he", "dark")])
def test_landing_accessibility(page: Page, base_url: str, lng: str, theme: str):
    """Runs axe-core on the whole landing page; asserts no violations, in English with the light
    theme and in Hebrew (RTL) with the dark theme."""
    page.goto(f"{base_url}/{lng}", wait_until="domcontentloaded")
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [THEME_STORAGE_KEY, theme])
    page.reload(wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    wait_for_fade_in(page)
    results = Axe().run(page)
    violations = results.response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def test_heading_hierarchy(page: Page, app_url: str):
    """Asserts one visible h1, and that no heading level is skipped going down the page."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", level=1)).to_have_count(1)
    expect(page.get_by_role("heading", level=1)).to_be_visible()
    levels = page.evaluate(
        "() => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]))"
    )
    for previous, current in zip(levels, levels[1:]):
        assert current <= previous + 1, f"heading level jumps from h{previous} to h{current}"
