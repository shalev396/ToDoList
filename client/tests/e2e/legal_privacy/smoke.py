"""
Privacy policy page (legal/privacy) smoke tests.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT

# Draft or review wording that must never reach the public page, in either language.
DRAFT_WORDING = ("lawyer", "draft", "todo:", "placeholder", "before launch", "עורך דין", "טיוטה")

# Google's Limited Use disclosure, word for word (the OAuth verification checks it).
LIMITED_USE = (
    "TodoList’s use and transfer to any other app of information received from Google APIs will "
    "adhere to the Google API Services User Data Policy, including the Limited Use requirements."
)


def _open(page: Page, app_url: str, lang: str = "en") -> None:
    """Opens the privacy page in a language and waits for it to settle."""
    base = app_url.removesuffix("/en")
    page.goto(f"{base}/{lang}/legal/privacy", wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")


def test_privacy_loads(page: Page, app_url: str):
    """Asserts the privacy page loads with its title and h1, and shows no draft or review note."""
    _open(page, app_url)
    expect(page).to_have_title(re.compile(r"Privacy policy"))
    expect(page.get_by_role("heading", level=1)).to_have_text("Privacy policy", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("note")).to_have_count(0)


def test_privacy_has_no_draft_wording(page: Page, app_url: str):
    """Asserts neither the English nor the Hebrew policy carries draft, review or placeholder
    wording."""
    for lang in ("en", "he"):
        _open(page, app_url, lang)
        main = page.get_by_role("main")
        expect(main.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
        text = main.inner_text().lower()
        for phrase in DRAFT_WORDING:
            assert phrase not in text, (lang, phrase)


def test_privacy_is_about_todolist(page: Page, app_url: str):
    """Asserts the policy covers tokens, sharing, rights and sub-processors, and no longer
    describes a template."""
    _open(page, app_url)
    expect(page.get_by_role("heading", name="How connection secrets are stored")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", name="Sharing and who can see what")).to_be_visible()
    expect(page.get_by_role("heading", name="Your rights")).to_be_visible()
    expect(page.get_by_role("heading", name="Sub-processors")).to_be_visible()
    assert "template" not in page.get_by_role("main").inner_text().lower()


def test_privacy_links_to_terms(page: Page, app_url: str):
    """Asserts the privacy page links to the terms with the right href."""
    _open(page, app_url)
    link = page.get_by_role("main").get_by_role("link", name="Terms of service")
    expect(link).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(link).to_have_attribute("href", "/en/legal/terms")


def test_privacy_google_section_matches_the_app(page: Page, app_url: str):
    """Asserts the Google section names every permission the connect asks for (calendar.app.created
    included), says writing waits for Read & write and lists each write, and that the Limited Use
    sentence is there word for word, linked to Google's policy."""
    _open(page, app_url)
    google = page.locator("section#google")
    expect(google).to_be_visible(timeout=NORMAL_TIMEOUT)
    text = google.inner_text()
    assert "make secondary calendars, and see, create, change and delete events on them" in text
    assert "only after you switch the connection to Read & write" in text
    for write in ("Also create in Google Calendar", "Repeating to-dos", "Sync to Google Calendar",
                  "Editing an event in TodoList", "Cleaning up"):
        assert write in text, write
    assert "never changes anything in Google Calendar" in text
    assert "with AI agents you connect over MCP" in text
    limited = page.locator("section#googleLimitedUse")
    assert LIMITED_USE in limited.inner_text()
    expect(limited.get_by_role("link", name="Google API Services User Data Policy")).to_have_attribute(
        "href", "https://developers.google.com/terms/api-services-user-data-policy"
    )


def test_privacy_links_each_provider_policy(page: Page, app_url: str):
    """Asserts the sub-processors and the connected sources link each provider's own privacy policy,
    in English and Hebrew, opening in a new tab."""
    processors = (
        "https://aws.amazon.com/privacy/",
        "https://www.mongodb.com/legal/privacy/privacy-policy",
        "https://policies.google.com/privacy",
    )
    sources = (
        "https://www.atlassian.com/legal/privacy-policy",
        "https://clickup.com/terms/privacy",
        "https://linear.app/privacy",
        "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
        "https://policies.google.com/privacy",
        "https://moodle.com/privacy-notice/",
    )
    for lang in ("en", "he"):
        _open(page, app_url, lang)
        for section, urls in (("processors", processors), ("sources", sources)):
            located = page.locator(f"section#{section}")
            expect(located).to_be_visible(timeout=NORMAL_TIMEOUT)
            for url in urls:
                link = located.locator(f'a[href="{url}"]')
                expect(link).to_have_count(1)
                expect(link).to_have_attribute("target", "_blank")
                expect(link).to_have_attribute("rel", "noopener noreferrer")


def test_privacy_rights_link_the_authority(page: Page, app_url: str):
    """Asserts the rights section links Israel's Privacy Protection Authority in the reader's
    language, and the contact email opens mail."""
    for lang in ("en", "he"):
        _open(page, app_url, lang)
        rights = page.locator("section#rights")
        expect(rights).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(
            rights.locator(f'a[href="https://www.gov.il/{lang}/departments/the_privacy_protection_authority"]')
        ).to_have_count(1)
        expect(rights.locator('a[href^="mailto:"]')).to_have_count(1)


def _travel_section_text(page: Page, app_url: str, lang: str) -> str:
    """Opens the privacy page in a language and returns the text of its travel section."""
    _open(page, app_url, lang)
    section = page.locator("section#travel")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    section.scroll_into_view_if_needed()
    return section.inner_text()


def test_privacy_travel_names_no_outside_service(page: Page, app_url: str):
    """Asserts the travel section names no routing or geocoding service (nothing is sent to one: the
    owner's decision of 2026-11-18) and says places and addresses stay private, are never logged or
    given to agents, and that an address only opens a map app, in English and Hebrew."""
    en = _travel_section_text(page, app_url, "en")
    for service in ("OpenRouteService", "Nominatim", "OpenStreetMap", "Moovit"):
        assert service not in en, service
    assert "Your places and addresses are private to you" in en
    assert "never shared with other members of a workspace, never logged, and never given to AI agents" in en
    assert "An address is used only to open a map app on your device" in en
    assert "doesn’t look addresses up" in en
    he = _travel_section_text(page, app_url, "he")
    for service in ("OpenRouteService", "Nominatim", "OpenStreetMap", "Moovit"):
        assert service not in he, service
    assert "המקומות והכתובות שלכם פרטיים" in he
    assert "לא נרשמים ביומני השרת ולא נמסרים לסוכני בינה מלאכותית" in he
    assert "כתובת משמשת רק לפתיחת אפליקציית מפות במכשיר שלכם" in he


def _processors_section_text(page: Page, app_url: str, lang: str) -> str:
    """Opens the privacy page in a language and returns the text of its processors section."""
    _open(page, app_url, lang)
    section = page.locator("section#processors")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    return section.inner_text()


def test_privacy_processor_list_has_no_travel_services(page: Page, app_url: str):
    """Asserts the processors list names no travel service (OpenRouteService, Nominatim), in
    English and Hebrew: travel sends nothing anywhere. It names the three sub-processors."""
    for lang in ("en", "he"):
        text = _processors_section_text(page, app_url, lang)
        for service in ("OpenRouteService", "Nominatim", "OpenStreetMap"):
            assert service not in text, (lang, service)
        for processor in ("Amazon Web Services", "MongoDB Atlas", "Google Cloud"):
            assert processor in text, (lang, processor)


def _section_text(page: Page, app_url: str, lang: str, section_id: str) -> str:
    """Opens the privacy page in a language and returns the text of one section."""
    _open(page, app_url, lang)
    section = page.locator(f"section#{section_id}")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    return section.inner_text()


def test_privacy_names_where_data_is_stored(page: Page, app_url: str):
    """Asserts "Where your data is stored" names the AWS Israel (Tel Aviv) region, the database in
    Frankfurt and the transfer out of Israel to the EU, in English and Hebrew."""
    en = _section_text(page, app_url, "en", "transfers")
    assert "Israel (Tel Aviv) region of Amazon Web Services" in en
    assert "MongoDB Atlas in Frankfurt, Germany, in the European Union" in en
    assert "transferred outside Israel, to the EU" in en
    assert "Amazon CloudFront" in en
    he = _section_text(page, app_url, "he", "transfers")
    assert "באזור ישראל (תל אביב) של Amazon Web Services" in he
    assert "MongoDB Atlas בפרנקפורט שבגרמניה, באיחוד האירופי" in he
    assert "מועבר אל מחוץ לישראל, לאיחוד האירופי" in he


def test_privacy_retention_promises_a_daily_clean_up(page: Page, app_url: str):
    """Asserts deleted items are promised to go for good 30 days later, by a daily clean-up (the
    hourly tick runs the purge once a day), with no "at least" hedge, in English and Hebrew."""
    en = _section_text(page, app_url, "en", "retention")
    assert "deleted for good 30 days later, by a clean-up that runs every day" in en
    assert "at least 30 days" not in en
    assert "never before 30 days after the trip" in en
    he = _section_text(page, app_url, "he", "retention")
    assert "ונמחקים סופית 30 יום אחר כך, בניקוי שרץ כל יום" in he
    assert "30 יום לפחות" not in he


def test_privacy_names_the_operator(page: Page, app_url: str):
    """Asserts the policy names its operator, Shalev Ben Moshe, spelled שליו בן משה in Hebrew."""
    assert "Shalev Ben Moshe" in _section_text(page, app_url, "en", "whoWeAre")
    he = _section_text(page, app_url, "he", "whoWeAre")
    assert "שליו בן משה" in he
    assert "שלו בן משה" not in he


def test_privacy_children_section(page: Page, app_url: str):
    """Asserts the Children section says TodoList isn't meant for children under 16, that their
    data isn't knowingly collected and that it is deleted if found, in English and Hebrew."""
    en = _section_text(page, app_url, "en", "children")
    assert (
        "TodoList isn’t meant for children under 16. We don’t knowingly collect their data, and if "
        "we find out we have, we delete it." in en
    )
    he = _section_text(page, app_url, "he", "children")
    assert "TodoList לא מיועד לילדים מתחת לגיל 16" in he
    assert "אנחנו לא אוספים ביודעין מידע עליהם, ואם נגלה שאספנו, נמחק אותו." in he
