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


def _travel_section_text(page: Page, app_url: str, lang: str) -> str:
    """Opens the privacy page in a language and returns the text of its travel section."""
    base = app_url.removesuffix("/en")
    page.goto(f"{base}/{lang}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    section = page.locator("section#travel")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    section.scroll_into_view_if_needed()
    return section.inner_text()


def test_privacy_names_openrouteservice(page: Page, app_url: str):
    """Asserts the travel section names the two routing and geocoding services and says places stay private, in English and Hebrew."""
    en = _travel_section_text(page, app_url, "en")
    assert "OpenRouteService" in en
    assert "OpenStreetMap Nominatim" in en
    assert "never shared" in en and "never logged" in en
    assert "place names only" in en
    he = _travel_section_text(page, app_url, "he")
    assert "OpenRouteService" in he
    assert "Nominatim" in he
    assert re.search(r"[א-ת]", he)


def _processors_section_text(page: Page, app_url: str, lang: str) -> str:
    """Opens the privacy page in a language and returns the text of its processors section."""
    base = app_url.removesuffix("/en")
    page.goto(f"{base}/{lang}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    section = page.locator("section#processors")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    return section.inner_text()


def test_privacy_processor_list_has_the_travel_services(page: Page, app_url: str):
    """Asserts the processors list names OpenRouteService and OpenStreetMap Nominatim, in English and Hebrew, and the Hebrew travel text says places are private and not logged on the server."""
    for lang in ("en", "he"):
        text = _processors_section_text(page, app_url, lang)
        assert "OpenRouteService" in text, lang
        assert "Nominatim" in text, lang
    he = _travel_section_text(page, app_url, "he")
    assert "פרטיים" in he
    assert "ביומני השרת" in he
