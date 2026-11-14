"""
Landing page (HOME) security checks — no sensitive data in visible content, safe external links.
"""
from playwright.sync_api import Page


def test_landing_no_tokens_in_visible_content(page: Page, app_url: str):
    """Asserts the public landing page does not expose idToken or refreshToken in visible text."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    visible_text = page.locator("body").inner_text()
    assert "idToken" not in visible_text
    assert "refreshToken" not in visible_text


def test_landing_new_tab_links_are_isolated(page: Page, app_url: str):
    """Every link that opens a new tab carries rel="noopener" (no window.opener for the target)."""
    page.goto(app_url, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    rels = page.evaluate(
        "() => [...document.querySelectorAll('a[target=\"_blank\"]')].map((a) => a.rel)"
    )
    assert rels, "expected the footer's external links"
    assert all("noopener" in rel for rel in rels), f"links without noopener: {rels}"
