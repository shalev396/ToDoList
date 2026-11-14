"""
404 page smoke tests.
"""
from playwright.sync_api import Page, expect


def test_404_loads(page: Page, app_url: str):
    """Asserts the 404 page shows its heading and a link home for an unknown route."""
    page.goto(f"{app_url}/invalid-route-xyz", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Page not found")).to_be_visible()
    expect(page.get_by_role("link", name="Go to the home page")).to_be_visible()


def test_404_message(page: Page, app_url: str):
    """Asserts the 404 page explains the problem and shows the address that was asked for."""
    page.goto(f"{app_url}/invalid-route-xyz", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_text("There’s nothing at this address.")).to_be_visible()
    expect(page.locator("main code")).to_have_text("/en/invalid-route-xyz")


def test_404_address_is_text(page: Page, app_url: str):
    """An address with markup in it is shown as text, never rendered."""
    page.goto(f"{app_url}/%3Cb%3Ebold%3C%2Fb%3E", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Page not found")).to_be_visible()
    expect(page.locator("main code b")).to_have_count(0)


def test_404_back_home_button(page: Page, app_url: str):
    """Asserts the home link points to /en, and pricing is offered too."""
    page.goto(f"{app_url}/invalid-route-xyz", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    link = page.get_by_role("link", name="Go to the home page")
    expect(link).to_be_visible()
    expect(link).to_have_attribute("href", "/en")
    expect(page.get_by_role("main").get_by_role("link", name="See pricing")).to_have_attribute(
        "href", "/en/pricing"
    )
