"""
Privacy policy page (legal/privacy) smoke tests.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT


def test_privacy_loads(page: Page, app_url: str):
    """Asserts the privacy page loads with its title, h1 and the draft-for-review note."""
    page.goto(f"{app_url}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page).to_have_title(re.compile(r"Privacy policy"))
    expect(page.get_by_role("heading", level=1)).to_have_text("Privacy policy", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("note")).to_contain_text("reviewed by a lawyer before launch")


def test_privacy_is_about_todolist(page: Page, app_url: str):
    """Asserts the policy covers tokens and sharing, and no longer describes a template."""
    page.goto(f"{app_url}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="How connection secrets are stored")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", name="Sharing and who can see what")).to_be_visible()
    assert "template" not in page.get_by_role("main").inner_text().lower()


def test_privacy_links_to_terms(page: Page, app_url: str):
    """Asserts the privacy page links to the terms with the right href."""
    page.goto(f"{app_url}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    link = page.get_by_role("main").get_by_role("link", name="Terms of service")
    expect(link).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(link).to_have_attribute("href", "/en/legal/terms")
