"""
Terms of service page (legal/terms) smoke tests.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT


def test_terms_loads(page: Page, app_url: str):
    """Asserts the terms page loads with its title, h1 and the draft-for-review note."""
    page.goto(f"{app_url}/legal/terms", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_title(re.compile(r"Terms of service"))
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "Terms of service", timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_role("note")).to_contain_text("reviewed by a lawyer before launch")


def test_terms_are_about_todolist(page: Page, app_url: str):
    """Asserts the terms cover the free service and fair use, and no longer describe a template."""
    page.goto(f"{app_url}/legal/terms", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Free for individuals")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", name="Business and school use")).to_be_visible()
    main_text = page.get_by_role("main").inner_text().lower()
    assert "template" not in main_text
    assert "mit license" not in main_text


def test_terms_links_to_privacy(page: Page, app_url: str):
    """Asserts the terms page links to the privacy policy with the right href."""
    page.goto(f"{app_url}/legal/terms", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    link = page.get_by_role("main").get_by_role("link", name="Privacy policy")
    expect(link).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(link).to_have_attribute("href", "/en/legal/privacy")
