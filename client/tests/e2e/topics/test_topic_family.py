"""
Topic colour families (Settings → Topics): each topic shows its family's four shades and its name;
editors and owners pick another of the nine families from a menu, saved at once.

A new workspace has Personal only, which takes the first family of the cycle (blue); Work and
College, added after it, take the next two (orange, teal). The family is saved on the topic when
it is assigned (`nextFamily`, server/src/types/colours.ts). Each test owns a fresh workspace
(deleted after it).
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.helpers.workspaces import ensure_topics, list_topics, open_as
from tests.viewports import DESKTOP_VIEWPORT

FAMILIES_BY_SLUG = {"personal": "blue", "work": "orange", "college": "teal"}
HEBREW_FAMILIES = ["אפור", "אדום", "כתום", "ענבר", "ירוק", "טורקיז", "כחול", "סגול", "ורוד"]


def _topics(page: Page, heading: str = "Topics"):
    return page.locator("section").filter(has=page.get_by_role("heading", name=heading, exact=True))


def _row(page: Page, name: str, heading: str = "Topics"):
    return (
        _topics(page, heading)
        .get_by_role("listitem")
        .filter(has=page.get_by_role("link", name=name, exact=True))
    )


def _is_topic_patch(response) -> bool:
    return response.request.method == "PATCH" and re.search(r"/topics/[^/?]+$", response.url) is not None


def test_default_topics_have_their_families(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    topics = ensure_topics(api_base_url, user, workspace["id"], ["work", "college"])
    assert {topic["slug"]: topic["colour"] for topic in topics} == FAMILIES_BY_SLUG

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    for name, family, label in (
        ("Work", "orange", "Orange"),
        ("College", "teal", "Teal"),
        ("Personal", "blue", "Blue"),
    ):
        picker = _row(page, name).get_by_role("button", name=f"Colour of {name}: {label}")
        expect(picker).to_have_attribute("data-family", family, timeout=NORMAL_TIMEOUT)
        expect(picker).to_contain_text(label)
        # The preview: the family's four shades, in its own tokens.
        for role in ("area", "travel", "scheduled", "work"):
            expect(picker.locator(f'[data-family="{family}"][data-role="{role}"]')).to_have_count(1)


def test_picker_recolours_a_topic(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    ensure_topics(api_base_url, user, workspace["id"], ["work"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings", h1="Settings")

    _row(page, "Work").get_by_role("button", name="Colour of Work: Orange").click()
    menu = page.get_by_role("menu")
    expect(menu.get_by_role("menuitemradio")).to_have_count(9)
    expect(menu.get_by_role("menuitemradio", name="Orange")).to_have_attribute("aria-checked", "true")
    with page.expect_response(_is_topic_patch) as saved:
        menu.get_by_role("menuitemradio", name="Violet").click()
    assert saved.value.status == 200, saved.value.text()

    picker = _row(page, "Work").get_by_role("button", name="Colour of Work: Violet")
    expect(picker).to_have_attribute("data-family", "violet", timeout=NORMAL_TIMEOUT)
    work = next(t for t in list_topics(api_base_url, user, workspace["id"]) if t["slug"] == "work")
    assert work["colour"] == "violet"

    # Saved, not only shown: it is still violet after a reload.
    page.reload(wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Settings", timeout=NORMAL_TIMEOUT)
    picker = _row(page, "Work").get_by_role("button", name="Colour of Work: Violet")
    expect(picker).to_have_attribute("data-family", "violet", timeout=NORMAL_TIMEOUT)


def test_picker_in_hebrew_and_dark(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    ensure_topics(api_base_url, user, workspace["id"], ["work", "college"])
    page.emulate_media(color_scheme="dark")
    page.set_viewport_size({"width": 393, "height": 852})
    open_as(page, base_url, user, "/he/settings", h1="הגדרות")
    assert page.evaluate("() => document.documentElement.classList.contains('dark')")
    assert page.evaluate("() => document.documentElement.dir") == "rtl"

    for name, family in (("Personal", "כחול"), ("Work", "כתום"), ("College", "טורקיז")):
        picker = _row(page, name, "נושאים").get_by_role("button", name=f"הצבע של {name}: {family}")
        expect(picker).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(picker).to_contain_text(family)
    assert_no_horizontal_overflow(page, "iphone", 393)

    _row(page, "Work", "נושאים").get_by_role("button", name="הצבע של Work: כתום").click()
    menu = page.get_by_role("menu")
    expect(menu).to_contain_text("צבע")
    for family in HEBREW_FAMILIES:
        expect(menu.get_by_role("menuitemradio", name=family)).to_be_visible()
    assert_no_horizontal_overflow(page, "iphone", 393)
    page.keyboard.press("Escape")
    expect(menu).to_have_count(0)
