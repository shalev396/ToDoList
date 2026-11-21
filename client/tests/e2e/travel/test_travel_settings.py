"""
Settings -> Travel (docs/superpowers/specs/2026-11-17-travel-time-design.md, as the owner's
decision of 2026-11-18 amends it): places as a name and an optional address (never looked up, no
coordinates) with the Home badge, a rule built with the sentence filter, the options (going home,
the default mode; no factors or buffers: trip lengths are set on the trips), and the tab in Hebrew
on a phone. Places and rules are set up through the API (tests/helpers/travel.py) where a test
isn't about adding them; the page is driven through the UI.
"""
import re
from datetime import date, timedelta

import pytest
import requests
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.helpers.select import choose
from tests.helpers.tap_targets import assert_touch_screen, small_targets
from tests.helpers.travel import create_place, create_rule, get_settings, list_rules
from tests.helpers.workspaces import ensure_topics, open_as

IPHONE = {"width": 393, "height": 852}


def _travel_call(method: str, path: str):
    """A response of the travel route `path` (places, rules, settings) with this method."""
    return lambda response: (
        response.request.method == method and f"/travel/{path}" in response.url
    )


def _open(page: Page, base_url: str, user, language: str = "en") -> None:
    open_as(
        page,
        base_url,
        user,
        f"/{language}/settings/travel",
        h1="Settings" if language == "en" else "הגדרות",
    )
    expect(page.locator("[data-places]")).to_be_visible(timeout=NORMAL_TIMEOUT)


def _add_place(page: Page, name: str, address: str = "", aliases: str = "", home: bool = False):
    form = page.locator("[data-place-form=add]")
    form.get_by_label("Name", exact=True).fill(name)
    if address:
        form.get_by_label("Address (optional)").fill(address)
    if aliases:
        form.get_by_label("Other names").fill(aliases)
    if home:
        form.get_by_role("checkbox", name="This is my Home").check()
    with page.expect_response(_travel_call("POST", "places"), timeout=APP_REQUEST_TIMEOUT) as created:
        form.get_by_role("button", name="Add place").click()
    return created.value


def _tomorrow_in_jerusalem(page: Page) -> str:
    today = page.evaluate(
        "() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())"
    )
    return (date.fromisoformat(today) + timedelta(days=1)).isoformat()


def test_add_home_and_a_place_by_name_and_address(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    _open(page, base_url, user)
    expect(page.get_by_role("link", name="Travel", exact=True)).to_have_attribute("aria-current", "page")
    expect(page.locator("[data-places]")).to_contain_text("No places yet. Start with Home.")
    # No outside service: no notice about a routing key, no factors or buffers.
    expect(page.locator("[data-ors-missing]")).to_have_count(0)
    expect(page.get_by_text("OpenRouteService")).to_have_count(0)
    expect(page.locator("[data-places]")).to_contain_text(
        "Only used to open Waze or Google Maps on your device. Nothing is looked up."
    )

    # A name alone is a place.
    created = _add_place(page, "Home", home=True)
    assert created.status == 201, created.text()
    assert created.request.post_data_json == {"name": "Home", "aliases": [], "home": True}
    home = page.locator('[data-place="Home"]')
    expect(home.locator("[data-home-badge]")).to_have_text("Home")
    expect(home.locator("[data-place-address]")).to_have_count(0)

    # An address goes as typed (trimmed): text only, never coordinates.
    created = _add_place(page, "Braude", " Snunit St 51, Karmiel ", aliases="ORT Braude, בראודה")
    assert created.status == 201, created.text()
    body = created.request.post_data_json
    assert body["address"] == "Snunit St 51, Karmiel"
    assert "coords" not in body
    assert "lat" not in created.text()
    braude = page.locator('[data-place="Braude"]')
    # The address is shown to its owner (it is in no one else's answers: the privacy tests).
    expect(braude.locator("[data-place-address]")).to_have_text("Snunit St 51, Karmiel")
    expect(braude).to_contain_text("Also called ORT Braude, בראודה")
    expect(braude.locator("[data-home-badge]")).to_have_count(0)
    # The add form is empty again, ready for the next place.
    expect(page.locator("[data-place-form=add]").get_by_label("Name", exact=True)).to_have_value("")

    # Braude becomes Home; the old Home becomes a plain place.
    with page.expect_response(_travel_call("PATCH", "places/"), timeout=APP_REQUEST_TIMEOUT) as patched:
        braude.get_by_role("button", name="Make Braude your Home").click()
    assert patched.value.status == 200
    assert patched.value.request.post_data_json == {"home": True}
    expect(braude.locator("[data-home-badge]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(home.locator("[data-home-badge]")).to_have_count(0)
    # Its Make Home button went: the keyboard is on its Edit button.
    expect(braude.get_by_role("button", name="Edit Braude")).to_be_focused()

    page.reload()
    expect(page.locator("[data-place]")).to_have_count(2, timeout=NORMAL_TIMEOUT)
    expect(page.locator('[data-place="Braude"] [data-home-badge]')).to_be_visible()

    # The keyboard follows the place: editing starts on its name, and Cancel or Save goes back to
    # its Edit button.
    home.get_by_role("button", name="Edit Home").click()
    name = home.get_by_label("Name", exact=True)
    expect(name).to_be_focused()
    home.get_by_role("button", name="Cancel").click()
    expect(home.get_by_role("button", name="Edit Home")).to_be_focused()
    home.get_by_role("button", name="Edit Home").press("Enter")
    expect(name).to_be_focused()
    name.fill("Old home")
    with page.expect_response(_travel_call("PATCH", "places/"), timeout=APP_REQUEST_TIMEOUT) as patched:
        name.press("Enter")
    assert patched.value.request.post_data_json == {"name": "Old home"}
    old_home = page.locator('[data-place="Old home"]')
    expect(old_home.get_by_role("button", name="Edit Old home")).to_be_focused()

    # Removing a place puts the keyboard on the next one, and on adding a place once none is left.
    old_home.get_by_role("button", name="Remove Old home").click()
    with page.expect_response(_travel_call("DELETE", "places/"), timeout=APP_REQUEST_TIMEOUT):
        page.get_by_role("alertdialog").get_by_role("button", name="Remove").click()
    expect(page.locator('[data-place="Old home"]')).to_have_count(0)
    expect(braude.get_by_role("button", name="Edit Braude")).to_be_focused()
    braude.get_by_role("button", name="Remove Braude").click()
    with page.expect_response(_travel_call("DELETE", "places/"), timeout=APP_REQUEST_TIMEOUT):
        page.get_by_role("alertdialog").get_by_role("button", name="Remove").click()
    expect(page.locator("[data-place]")).to_have_count(0)
    expect(page.locator("[data-place-form=add]").get_by_label("Name", exact=True)).to_be_focused()


def test_rule_with_sentence_filter_saves(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    wid = workspace["id"]
    create_place(api_base_url, user, wid, "Home", home=True)
    braude = create_place(api_base_url, user, wid, "Braude")
    ensure_topics(api_base_url, user, wid, ["work"])  # a new workspace has Personal only
    _open(page, base_url, user)
    tomorrow = _tomorrow_in_jerusalem(page)

    new_rule = page.locator("[data-new-travel-rule]")
    add = new_rule.get_by_role("button", name="Add rule")
    # A rule without a condition would add travel to everything: it can't be added.
    expect(add).to_be_disabled(timeout=NORMAL_TIMEOUT)
    expect(new_rule).to_contain_text("When")
    expect(new_rule).not_to_contain_text("sorted by")
    # A new rule starts on the default mode (public transport).
    expect(new_rule.get_by_role("combobox", name="How you travel")).to_contain_text("Public transport")

    # "When … where [Title] [contains] [Lecture] → by [Driving], [There] to [Braude]"
    new_rule.get_by_role("button", name="Add a condition").click()
    condition = new_rule.locator("[data-sentence-condition]").first
    # The default field is Topic: its values read as topic names, never as ids.
    topic_values = condition.get_by_role("group", name="Value")
    expect(topic_values).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(topic_values.get_by_label("Personal")).to_be_visible()
    expect(topic_values.get_by_label("Work")).to_be_visible()
    expect(topic_values).not_to_contain_text(re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-"))
    choose(condition.get_by_role("combobox", name="Field", exact=True), "Title")
    choose(condition.get_by_role("combobox", name="Condition", exact=True), "contains")
    condition.get_by_role("textbox", name="Value").fill("Lecture")
    choose(new_rule.get_by_role("combobox", name="How you travel"), "Driving")
    choose(new_rule.get_by_role("combobox", name="Which trips"), "There")
    choose(new_rule.get_by_role("combobox", name="Where to"), "Braude")
    expect(add).to_be_enabled()
    with page.expect_response(_travel_call("POST", "rules"), timeout=APP_REQUEST_TIMEOUT) as created:
        add.click()
    assert created.value.status == 201, created.value.text()
    body = created.value.request.post_data_json
    assert body == {
        "scope": {
            "kind": "where",
            "where": {
                "combinator": "and",
                "rules": [{"field": "title", "operator": "contains", "value": "Lecture"}],
            },
        },
        "mode": "drive",
        "direction": "there",
        "placeId": braude["id"],
        # Arrive early and the rule's own lengths were left blank: the form sends null (none).
        "arriveEarlyMinutes": None,
        "lengths": None,
    }

    card = page.locator("[data-travel-rule]")
    expect(card).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(card.get_by_role("textbox", name="Value")).to_have_value("Lecture")
    expect(card.get_by_role("combobox", name="How you travel")).to_contain_text("Driving")
    expect(card.get_by_role("combobox", name="Where to")).to_contain_text("Braude")
    # The new-rule form starts over.
    expect(new_rule.locator("[data-sentence-condition]")).to_have_count(0)

    # Both ways now: there and back.
    choose(card.get_by_role("combobox", name="Which trips"), "There and back")
    with page.expect_response(_travel_call("PATCH", "rules/"), timeout=APP_REQUEST_TIMEOUT) as saved:
        card.get_by_role("button", name="Save rule").click()
    assert saved.value.status == 200, saved.value.text()
    assert saved.value.request.post_data_json["direction"] == "both"
    expect(card.get_by_role("button", name="Save rule")).to_have_count(0, timeout=NORMAL_TIMEOUT)
    # The card shows the saved rule (the PATCH answer), never its old values in between.
    expect(card.get_by_role("combobox", name="Which trips")).to_contain_text("There and back")

    rules = list_rules(api_base_url, user, wid)
    assert [(rule["mode"], rule["direction"], rule["placeId"]) for rule in rules] == [
        ("drive", "both", braude["id"])
    ]

    page.reload()
    card = page.locator("[data-travel-rule]")
    expect(card.get_by_role("combobox", name="Which trips")).to_contain_text(
        "There and back", timeout=NORMAL_TIMEOUT
    )

    # Next 14 days: tomorrow links to its day panel on this page.
    day = page.locator(f'[data-travel-day="{tomorrow}"]')
    expect(page.locator("[data-travel-day]")).to_have_count(14, timeout=NORMAL_TIMEOUT)
    expect(day).to_have_attribute("href", f"/en/settings/travel?travelDay={tomorrow}")


# The legs a rule makes are stored items of kind `travel`. The dev database's Items validator
# predates that kind and refuses them (the server catches and logs it; the page is unaffected)
# until the branch reaches dev and sync-db runs. strict: once legs are stored, the XPASS fails the
# run, so the marker is removed then.
DEFERRED_LEGS = (
    "DEFERRED until merge to dev: the dev Items validator rejects kind travel until sync-db runs"
)


def test_next_14_days_counts_stored_legs_and_removals(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    wid = workspace["id"]
    create_place(api_base_url, user, wid, "Home", home=True)
    braude = create_place(api_base_url, user, wid, "Braude")
    _open(page, base_url, user)
    tomorrow = _tomorrow_in_jerusalem(page)
    # A lecture tomorrow 10:00-12:00 (Jerusalem, UTC+2 in November), and a rule that drives there
    # and back for it.
    response = requests.post(
        f"{api_base_url}/private/workspaces/{wid}/items",
        json={
            "title": "Lecture: Calculus",
            "startAt": f"{tomorrow}T08:00:00.000Z",
            "endAt": f"{tomorrow}T10:00:00.000Z",
        },
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=30,
    )
    assert response.status_code == 201, response.text
    create_rule(
        api_base_url,
        user,
        wid,
        {"combinator": "and", "rules": [{"field": "title", "operator": "contains", "value": "Lecture"}]},
        mode="drive",
        direction="both",
        place_id=braude["id"],
    )
    page.reload()
    days = page.locator("[data-travel-day]")
    expect(days).to_have_count(14, timeout=NORMAL_TIMEOUT)
    day = page.locator(f'[data-travel-day="{tomorrow}"]')
    expect(day).to_have_attribute("href", f"/en/settings/travel?travelDay={tomorrow}")

    # The stored legs: Home → Braude before the lecture, Braude → Home after it.
    expect(day).to_have_attribute("data-legs", "2", timeout=NORMAL_TIMEOUT)
    expect(day).to_have_attribute("data-removed", "0")
    expect(day).to_contain_text("2 trips")

    # The rule goes, and with it both legs: the day counts them as removed.
    page.locator("[data-travel-rule]").get_by_role("button", name="Remove rule").click()
    with page.expect_response(_travel_call("DELETE", "rules/"), timeout=APP_REQUEST_TIMEOUT):
        page.get_by_role("alertdialog").get_by_role("button", name="Remove").click()
    expect(day).to_have_attribute("data-legs", "0", timeout=NORMAL_TIMEOUT)
    expect(day).to_have_attribute("data-removed", "2")
    expect(day).to_contain_text("No travel · 2 removed")


def test_settings_defaults_shown_and_saved(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _open(page, base_url, user)
    assert get_settings(api_base_url, user, workspace["id"]) == {
        "settings": {
            "goHome": {"enabled": False, "minWindowMinutes": 180, "minAtHomeMinutes": 60},
            "defaultMode": "transit",
        },
        "containerPlaces": [],
    }
    options = page.locator("[data-travel-settings]")
    expect(page.get_by_role("heading", name="Options", exact=True)).to_be_visible()
    # Trip lengths are no setting: the page says where they are set.
    expect(page.get_by_text("How long a trip takes is set on the trip itself, once")).to_be_visible()
    expect(page.locator("[data-travel-mode]")).to_have_count(0)
    expect(options.get_by_role("textbox", name=re.compile("factor|buffer"))).to_have_count(0)
    go_home = page.get_by_role("switch", name="Go home in a long window")
    expect(go_home).to_have_attribute("aria-checked", "false")
    expect(page.get_by_label("Window of at least")).to_have_value("180")
    expect(page.get_by_label("Window of at least")).to_be_disabled()
    expect(page.get_by_label("Time at home of at least")).to_have_value("60")
    expect(page.get_by_role("radio", name="Public transport")).to_be_checked()
    save = page.get_by_role("button", name="Save options")
    expect(save).to_be_disabled()

    go_home.click()
    expect(go_home).to_have_attribute("aria-checked", "true")
    window = page.get_by_label("Window of at least")
    expect(window).to_be_enabled()
    window.fill("240")
    page.locator("label", has=page.get_by_role("radio", name="Driving")).click()
    expect(page.get_by_role("radio", name="Driving")).to_be_checked()

    with page.expect_response(_travel_call("PATCH", "settings"), timeout=APP_REQUEST_TIMEOUT) as saved:
        save.click()
    assert saved.value.status == 200, saved.value.text()
    # The new rule, untouched, follows the new default mode at once.
    expect(
        page.locator("[data-new-travel-rule]").get_by_role("combobox", name="How you travel")
    ).to_contain_text("Driving", timeout=NORMAL_TIMEOUT)
    settings = saved.value.json()["data"]["settings"]
    assert saved.value.request.post_data_json.keys() == {"goHome", "defaultMode"}
    assert sorted(settings) == ["defaultMode", "goHome"]
    assert settings["goHome"] == {"enabled": True, "minWindowMinutes": 240, "minAtHomeMinutes": 60}
    assert settings["defaultMode"] == "drive"
    expect(save).to_be_disabled(timeout=NORMAL_TIMEOUT)

    page.reload()
    expect(page.get_by_role("switch", name="Go home in a long window")).to_have_attribute(
        "aria-checked", "true", timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_label("Window of at least")).to_have_value("240")
    expect(page.get_by_role("radio", name="Driving")).to_be_checked()
    # A new rule starts on the default mode.
    expect(
        page.locator("[data-new-travel-rule]").get_by_role("combobox", name="How you travel")
    ).to_contain_text("Driving")


@pytest.fixture
def phone(browser, browser_context_args):
    """An iPhone-sized touch screen, so (pointer: coarse) matches."""
    context = browser.new_context(
        **{**browser_context_args, "viewport": IPHONE, "is_mobile": True, "has_touch": True}
    )
    page = context.new_page()
    yield page
    context.close()


def test_travel_tab_in_hebrew(phone: Page, base_url: str, api_base_url: str, fresh_owner):
    page = phone
    user, workspace = fresh_owner
    wid = workspace["id"]
    create_place(api_base_url, user, wid, "בית", home=True)
    braude = create_place(
        api_base_url, user, wid, "Braude", address="סנונית 51, כרמיאל", aliases=["בראודה"]
    )
    create_rule(
        api_base_url,
        user,
        wid,
        {"combinator": "and", "rules": [{"field": "title", "operator": "contains", "value": "הרצאה"}]},
        place_id=braude["id"],
    )
    _open(page, base_url, user, "he")
    assert page.evaluate("document.documentElement.dir") == "rtl"
    assert_touch_screen(page)

    expect(page.get_by_role("link", name="נסיעות", exact=True)).to_have_attribute("aria-current", "page")
    for heading in ("מקומות", "כללים", "אפשרויות", "מקומות ברירת מחדל", "14 הימים הקרובים"):
        expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()
    expect(page.locator('[data-place="בית"] [data-home-badge]')).to_have_text("בית")
    expect(page.locator('[data-place="Braude"]')).to_contain_text("נקרא גם בראודה")
    expect(page.locator('[data-place="Braude"] [data-place-address]')).to_have_text("סנונית 51, כרמיאל")
    rule = page.locator("[data-travel-rule]")
    expect(rule).to_contain_text("עבור")
    expect(rule.get_by_role("combobox", name="איך נוסעים")).to_contain_text("תחבורה ציבורית")
    expect(rule.get_by_role("combobox", name="אילו נסיעות")).to_contain_text("הלוך וחזור")
    expect(page.get_by_text("כמה זמן לוקחת נסיעה קובעים בנסיעה עצמה")).to_be_visible()
    expect(page.get_by_text("OpenRouteService")).to_have_count(0)

    days = page.locator("[data-travel-day]")
    expect(days).to_have_count(14, timeout=NORMAL_TIMEOUT)
    expect(days.first).to_contain_text("היום")

    assert_no_horizontal_overflow(page, "travel-he-iphone", IPHONE["width"])
    problems = small_targets(page, "Settings → Travel (he)", root="main")
    assert not problems, "Tap targets under 44px on a touch screen:\n" + "\n".join(problems)
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"

    # A day opens its day panel on this page (Task 17 mounts it on ?travelDay=).
    first_day = days.first.get_attribute("data-travel-day")
    days.first.click()
    expect(page).to_have_url(f"{base_url}/he/settings/travel?travelDay={first_day}")
