"""
Terms of service page (legal/terms) smoke tests.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT

# Draft or review wording that must never reach the public page, in either language.
DRAFT_WORDING = ("lawyer", "draft", "todo:", "placeholder", "before launch", "עורך דין", "טיוטה")


def _open(page: Page, app_url: str, lang: str = "en") -> None:
    """Opens the terms page in a language and waits for it to settle."""
    base = app_url.removesuffix("/en")
    page.goto(f"{base}/{lang}/legal/terms", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")


def test_terms_loads(page: Page, app_url: str):
    """Asserts the terms page loads with its title and h1, and shows no draft or review note."""
    _open(page, app_url)
    expect(page).to_have_title(re.compile(r"Terms of service"))
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "Terms of service", timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_role("note")).to_have_count(0)


def test_terms_have_no_draft_wording(page: Page, app_url: str):
    """Asserts neither the English nor the Hebrew terms carry draft, review or placeholder
    wording."""
    for lang in ("en", "he"):
        _open(page, app_url, lang)
        main = page.get_by_role("main")
        expect(main.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
        text = main.inner_text().lower()
        for phrase in DRAFT_WORDING:
            assert phrase not in text, (lang, phrase)


def test_terms_are_about_todolist(page: Page, app_url: str):
    """Asserts the terms cover the free service, fair use, acceptable use, liability and the
    governing law, and no longer describe a template."""
    _open(page, app_url)
    expect(page.get_by_role("heading", name="Free for individuals")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", name="Business and school use")).to_be_visible()
    expect(page.get_by_role("heading", name="Acceptable use")).to_be_visible()
    expect(page.get_by_role("heading", name="Limitation of liability")).to_be_visible()
    expect(page.get_by_role("heading", name="Governing law and courts")).to_be_visible()
    main_text = page.get_by_role("main").inner_text().lower()
    assert "template" not in main_text
    assert "mit license" not in main_text


def test_terms_governing_law_is_israel(page: Page, app_url: str):
    """Asserts the terms choose Israeli law and the Tel Aviv-Yafo courts, in English and Hebrew,
    and that deleting the account is covered."""
    _open(page, app_url)
    law = page.locator("section#law").inner_text()
    assert "laws of the State of Israel" in law
    assert "Tel Aviv-Yafo" in law
    assert "delete your account at any time" in page.locator("section#ending").inner_text()
    _open(page, app_url, "he")
    law_he = page.locator("section#law").inner_text()
    assert "דיני מדינת ישראל" in law_he
    assert "תל אביב-יפו" in law_he


def test_terms_links_to_privacy(page: Page, app_url: str):
    """Asserts the terms page links to the privacy policy with the right href."""
    _open(page, app_url)
    link = page.get_by_role("main").get_by_role("link", name="Privacy policy")
    expect(link).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(link).to_have_attribute("href", "/en/legal/privacy")
