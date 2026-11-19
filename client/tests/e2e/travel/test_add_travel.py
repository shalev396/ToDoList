"""
"Add travel time" (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Where travel comes
from", as the owner's decision of 2026-11-18 amends it): the New to-do form's switch and panel
(how long the trip takes, every time, and this trip's own leave and arrive; a trip with no length
yet shows the placeholder and "Set how long"), a to-do with a due date only asked for a time, and
"Add travel" in the item sheet of a repeating event, which asks "Every occurrence?".

Home and Braude are seeded by name through the API (tests/helpers/travel.py): nothing is looked up.
The forms and the sheet are driven through the UI.

DEFERRED until the branch is merged to dev: the dev database's Items validator predates kind
`travel`, so the legs a mark makes are refused there (the server catches and logs it; the mark still
answers, with no legs). Every assertion that needs a stored leg is in its own test below, marked
`xfail(strict=True)` with the exact leg expected: once dev stores legs those tests pass, the strict
xfail turns that into a failure, and the marks must come off. Nothing here is gated on a result.
"""
import re
import time
from datetime import datetime

import pytest
import requests
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Locator, Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.dashboards import create_dashboard
from tests.helpers.scheduled import add_days, open_new_sheet, this_sunday, zoned_iso
from tests.helpers.select import choose
from tests.helpers.travel import create_place, list_rules
from tests.helpers.users import pooled_user
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

DEFERRED = (
    "DEFERRED until merge to dev: the dev Items validator rejects kind travel, so no leg is stored"
)
# U+2066 / U+2069: the times are isolated left to right inside the line (it reads right in Hebrew).
LTR, END = "\u2066", "\u2069"


def _is_create(response) -> bool:
    return response.request.method == "POST" and response.url.split("?")[0].endswith("/items")


def _is_mark(response) -> bool:
    return response.request.method == "POST" and "/travel/items/" in response.url


def _epoch_ms(iso: str) -> int:
    return round(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _same_instant(a: str, b: str) -> bool:
    return _epoch_ms(a) == _epoch_ms(b)


def _tomorrow(page: Page) -> str:
    today = page.evaluate(
        "() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())"
    )
    return add_days(today, 1)


def _seed_places(api_base_url: str, user, workspace_id: str) -> tuple[dict, dict]:
    home = create_place(api_base_url, user, workspace_id, "Home", home=True)
    braude = create_place(api_base_url, user, workspace_id, "Braude")
    return home, braude


def _is_preview(mode: str):
    """`POST …/travel/preview` of a trip by `mode`, for page.expect_request."""
    return lambda request: (
        request.method == "POST"
        and request.url.endswith("/travel/preview")
        and (request.post_data_json or {}).get("mode") == mode
    )


def _previews(page: Page) -> list:
    """Every `POST …/travel/preview` body the page sends, as it sends them."""
    sent: list = []
    page.on(
        "request",
        lambda request: sent.append(request.post_data_json)
        if request.method == "POST" and request.url.endswith("/travel/preview")
        else None,
    )
    return sent


def _todo_with_travel(page: Page, base_url: str, api_base_url: str, fresh_owner):
    """A to-do tomorrow at 14:00, driving to Braude both ways, the trip there typed as 40 minutes,
    saved through the New sheet. Returns (created, marked, home, braude, tomorrow, previews)."""
    user, workspace = fresh_owner
    home, braude = _seed_places(api_base_url, user, workspace["id"])
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    previews = _previews(page)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    tomorrow = _tomorrow(page)

    sheet = open_new_sheet(page)
    form = sheet.locator("form")
    form.get_by_label("Title", exact=True).fill("Meet at Braude")
    form.get_by_label("Due", exact=True).fill(tomorrow)
    form.get_by_label("Time", exact=True).fill("14:00")

    switch = form.get_by_role("switch", name="Add travel time")
    expect(switch).to_have_attribute("aria-checked", "false")
    expect(form.locator("[data-travel-panel]")).to_have_count(0)
    # The default trip (public transport, Home → Braude) is asked once it stops changing.
    with page.expect_request(_is_preview("transit"), timeout=APP_REQUEST_TIMEOUT):
        switch.click()
    panel = form.locator("[data-travel-panel]")
    expect(panel).to_be_visible()
    # Public transport is the default mode; From is Home, To the only other place.
    expect(panel.get_by_role("radio", name="Public transport")).to_be_checked()
    expect(panel.get_by_role("combobox", name="From")).to_contain_text("Home")
    expect(panel.get_by_role("combobox", name="To")).to_contain_text("Braude")
    expect(panel.get_by_role("checkbox", name="There")).to_be_checked()
    expect(panel.get_by_role("checkbox", name="Back")).to_be_checked()
    # Arriving by 14:00. No length is set for the trip yet: it shows the 30-minute placeholder
    # and asks for one (no stored leg needed for a preview).
    expect(panel.get_by_label("Arrive", exact=True)).to_have_value("14:00")
    line = panel.locator("[data-travel-preview]")
    with page.expect_request(_is_preview("drive"), timeout=APP_REQUEST_TIMEOUT):
        panel.get_by_text("Drive", exact=True).click()
    expect(panel.get_by_role("radio", name="Drive")).to_be_checked()
    expect(line).to_have_text(
        f"Leave {LTR}13:30{END} · arrive {LTR}14:00{END} · 30 min (not set yet)",
        timeout=NORMAL_TIMEOUT,
    )
    length = panel.get_by_label("How long this trip takes (every time), in minutes")
    expect(length).to_have_value("")
    expect(length).to_have_attribute("placeholder", "Set how long")
    expect(panel.locator("[data-travel-length-hint]")).to_have_text(
        "Not set yet: it’s shown as 30 min until you set it."
    )
    expect(panel.locator("[data-travel-times]")).to_contain_text("This trip only")
    asked = len(previews)

    # The trip there takes 40 minutes, every time: leave at 13:20.
    length.fill("40")
    expect(panel.get_by_label("Leave", exact=True)).to_have_value("13:20")
    expect(line).to_have_text(f"Leave {LTR}13:20{END} · arrive {LTR}14:00{END} · 40 min (set by you)")
    expect(panel.locator("[data-travel-length-hint]")).to_have_text(
        "Set once: every repeat of this trip uses it."
    )
    page.wait_for_timeout(1000)
    # Typing the times asks for no preview: only a new trip (mode or places) does.
    assert len(previews) == asked, previews

    with page.expect_response(_is_create, timeout=APP_REQUEST_TIMEOUT) as created:
        with page.expect_response(_is_mark, timeout=APP_REQUEST_TIMEOUT) as marked:
            form.locator("[data-new-todo-save]").click()
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)
    return created.value, marked.value, home, braude, tomorrow, previews


def test_new_todo_with_travel_starts_at_its_time_and_is_marked(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    created, marked, home, braude, tomorrow, previews = _todo_with_travel(
        page, base_url, api_base_url, fresh_owner
    )
    two_pm = zoned_iso(page, tomorrow, "14:00")

    # The to-do starts at its due time: travel needs a start.
    assert created.status == 201, created.text()[:300]
    sent = created.request.post_data_json
    assert sent["title"] == "Meet at Braude"
    assert sent["allDay"] is False
    assert _same_instant(sent["dueAt"], two_pm)
    assert _same_instant(sent["startAt"], two_pm)
    todo = created.json()["data"]

    # Then it is marked: by car, both ways, to Braude, the trip there 40 minutes from Home.
    assert marked.url.split("?")[0].endswith(f"/travel/items/{todo['id']}")
    assert marked.request.post_data_json == {
        "mode": "drive",
        "direction": "both",
        "placeId": braude["id"],
        "there": {"minutes": 40, "fromPlaceId": home["id"]},
    }
    assert marked.status == 200, marked.text()[:300]
    rule = marked.json()["data"]["rule"]
    assert rule["scope"] == {"kind": "item", "itemId": todo["id"], "occurrence": "single"}
    assert (rule["mode"], rule["direction"], rule["placeId"]) == ("drive", "both", braude["id"])
    assert [(r["id"], r["scope"]) for r in list_rules(api_base_url, user, workspace["id"])] == [
        (rule["id"], rule["scope"])
    ]
    # Previews were asked per trip only (public transport, then driving), each Home → Braude; the
    # mark (a travel change) reads the open trip's length again, never another trip's.
    trips = [(p["mode"], p["toPlaceId"]) for p in previews]
    assert trips[:2] == [("transit", braude["id"]), ("drive", braude["id"])], trips
    assert set(trips[2:]) <= {("drive", braude["id"])}, trips


def test_new_todo_leg_shows_before_it_in_calendar(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    created, marked, home, braude, tomorrow, _ = _todo_with_travel(
        page, base_url, api_base_url, fresh_owner
    )
    todo = created.json()["data"]
    legs = marked.json()["data"]["legs"]
    # Exactly the drive there (13:20–14:00, his 40 minutes) and the drive home from 14:00.
    assert [leg["props"]["travel"]["direction"] for leg in legs] == ["there", "back"], legs
    there, back = legs
    assert there["title"] == "Drive to Braude"
    assert _same_instant(there["startAt"], zoned_iso(page, tomorrow, "13:20"))
    assert _same_instant(there["endAt"], zoned_iso(page, tomorrow, "14:00"))
    trip = there["props"]["travel"]
    assert (trip["anchorItemId"], trip["mode"], trip["toPlaceId"], trip["fromHome"]) == (
        todo["id"],
        "drive",
        braude["id"],
        True,
    )
    # The trip's own length, every time: not a hand edit of the leg.
    assert (trip["minutes"], trip["source"], trip["lengthUnset"], trip["edited"]) == (
        40,
        "set",
        False,
        False,
    )
    assert back["title"] == "Drive home"
    assert _same_instant(back["startAt"], zoned_iso(page, tomorrow, "14:00"))
    assert back["props"]["travel"]["toHome"] is True
    expect(page.locator("[data-sonner-toast]", has_text="Travel added: 2 trips.")).to_be_visible()

    # The leg shows in the calendar, ending where the to-do starts.
    calendar = page.locator("[data-calendar-view]")
    if tomorrow >= add_days(this_sunday(page), 7):
        calendar.get_by_role("button", name="Next", exact=True).click()
    leg = calendar.locator(".fc-event.tc-travel", has_text="Drive to Braude")
    meeting = calendar.locator(".fc-event", has_text="Meet at Braude")
    expect(leg).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(meeting).to_have_count(1)
    leg_box, meeting_box = leg.bounding_box(), meeting.bounding_box()
    assert leg_box is not None and meeting_box is not None
    assert leg_box["y"] + leg_box["height"] <= meeting_box["y"] + 2, (leg_box, meeting_box)


def test_add_your_home_closes_the_new_sheet_on_the_way_to_settings(
    page: Page, base_url: str, fresh_owner
):
    """With travel on and no Home, "Add your Home" lands on Settings → Travel with the New sheet
    closed (a shell sheet closes when the page changes), not left covering it."""
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    tomorrow = _tomorrow(page)

    sheet = open_new_sheet(page)
    form = sheet.locator("form")
    form.get_by_label("Title", exact=True).fill("Meet at Braude")
    form.get_by_label("Due", exact=True).fill(tomorrow)
    form.get_by_label("Time", exact=True).fill("14:00")
    form.get_by_role("switch", name="Add travel time").click()
    missing = form.locator("[data-travel-home-missing]")
    expect(missing).to_be_visible(timeout=NORMAL_TIMEOUT)

    missing.get_by_role("link", name="Add your Home in Settings").click()
    expect(page).to_have_url(re.compile(r"/en/settings/travel"), timeout=NORMAL_TIMEOUT)
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)
    # Settings → Travel has no heading of its own: its first section is where Home is added.
    expect(page.get_by_role("heading", name="Places", exact=True)).to_be_visible()


def test_due_only_todo_asks_for_a_time(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _seed_places(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    tomorrow = _tomorrow(page)
    setup_reads: list = []
    page.on(
        "request",
        lambda request: setup_reads.append(request.url)
        if "/travel/places" in request.url or "/travel/settings" in request.url
        else None,
    )

    sheet = open_new_sheet(page)
    form = sheet.locator("form")
    form.get_by_label("Title", exact=True).fill("Hand in the lab report")
    form.get_by_label("Due", exact=True).fill(tomorrow)
    time = form.get_by_label("Time", exact=True)
    expect(time).to_have_value("")
    save = form.locator("[data-new-todo-save]")
    expect(save).to_be_enabled()
    # The form reads no travel setup until "Add travel time" is turned on.
    assert setup_reads == [], setup_reads

    # When the places can't be read, turning it on says so (the switch stays usable).
    def refuse(route):
        route.fulfill(status=500, json={"message": "Internal server error"})

    page.route("**/travel/places", refuse)
    switch = form.get_by_role("switch", name="Add travel time")
    switch.click()
    expect(form.locator("[data-travel-setup-failed]")).to_have_text(
        "Your places couldn’t be loaded, so travel can’t be added right now.",
        timeout=NORMAL_TIMEOUT,
    )
    expect(form.locator("[data-travel-panel]")).to_have_count(0)
    switch.click()
    expect(form.locator("[data-travel-setup-failed]")).to_have_count(0)
    page.unroute("**/travel/places", refuse)

    switch.click()
    panel = form.locator("[data-travel-panel]")
    expect(panel).to_be_visible(timeout=NORMAL_TIMEOUT)
    # A due date only: travel needs a time, which the form asks for, and nothing can be saved.
    asks = form.locator("[data-travel-needs-time]")
    expect(asks).to_have_text("Travel needs a time: add when it starts.")
    expect(asks).to_have_attribute("role", "alert")
    expect(time).to_have_attribute("aria-invalid", "true")
    expect(save).to_be_disabled()
    for field in ("Leave", "Arrive"):
        expect(panel.get_by_label(field, exact=True)).to_be_disabled()
    expect(panel.get_by_label("How long this trip takes (every time), in minutes")).to_be_disabled()

    # With a time it can: the trip arrives by it.
    time.fill("09:30")
    expect(asks).to_have_count(0)
    expect(time).to_have_attribute("aria-invalid", "false")
    expect(panel.get_by_label("Arrive", exact=True)).to_have_value("09:30")
    expect(panel.get_by_label("Arrive", exact=True)).to_be_enabled()
    expect(save).to_be_enabled()

    # Without the date the time goes too, and so does the start travel needs.
    form.get_by_label("Due", exact=True).fill("")
    expect(asks).to_be_visible()
    expect(save).to_be_disabled()
    form.get_by_label("Due", exact=True).fill(tomorrow)
    time.fill("09:30")
    expect(save).to_be_enabled()

    # A repeating to-do gets its travel from its event: the switch says so and is off.
    choose(form.get_by_role("combobox", name="Repeat"), "Daily")
    switch = form.get_by_role("switch", name="Add travel time")
    expect(switch).to_be_disabled()
    expect(switch).to_have_attribute("aria-checked", "false")
    expect(form.locator("[data-travel-create]")).to_contain_text(
        "A repeating to-do gets its travel from its event, once it’s created."
    )
    expect(form.locator("[data-travel-panel]")).to_have_count(0)
    choose(form.get_by_role("combobox", name="Repeat"), "Does not repeat")
    expect(switch).to_be_enabled()
    expect(form.locator("[data-travel-panel]")).to_be_visible()

    wait_for_fade_in(page)
    violations = Axe().run(page, context="[data-new-todo]").response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"

    # Off again: the to-do saves as before, with no start and no travel.
    switch.click()
    expect(form.locator("[data-travel-panel]")).to_have_count(0)
    with page.expect_response(_is_create, timeout=APP_REQUEST_TIMEOUT) as created:
        save.click()
    assert created.value.status == 201, created.value.text()[:300]
    assert "startAt" not in created.value.request.post_data_json
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)
    assert list_rules(api_base_url, user, workspace["id"]) == []


# ─── The item sheet: a repeating event (the demo's weekly Data Structures lecture) ─────────────


@pytest.fixture
def demo_owner(api_base_url, new_workspace):
    """The worker's owner account, owning a new workspace with the demo data: its Google
    calendar mirror has "Data Structures lecture", weekly at 10:00 from 13 days ago (the occurrence
    in 8 days is cancelled), at "Building L, Room 105". Deleted after the test."""
    user = pooled_user(api_base_url, "owner")
    return user, new_workspace(
        user, "Travel demo", timezone="Asia/Jerusalem", loadDemoData=True
    )


def _lecture(api_base_url: str, user, workspace_id: str) -> dict:
    """The demo's Data Structures series (its master item). The demo data is written after the
    workspace answers, so it is waited for (up to 60 s) rather than assumed."""
    series: list = []
    for _ in range(30):
        response = requests.get(
            f"{api_base_url}/private/workspaces/{workspace_id}/items",
            params={"provider": "google_calendar", "q": "Data Structures"},
            headers={"Authorization": f"Bearer {user.id_token}"},
            timeout=30,
        )
        assert response.status_code == 200, response.text[:300]
        series = [
            item for item in response.json()["data"]["items"] if item["props"].get("recurrence")
        ]
        if series:
            break
        time.sleep(2)
    assert len(series) == 1, series
    return series[0]


def _open_lectures_sheet(page: Page, base_url: str, api_base_url: str, demo_owner):
    """Opens tomorrow's lecture in the item sheet. Returns (sheet, lecture, home, braude, slot)."""
    user, workspace = demo_owner
    home, braude = _seed_places(api_base_url, user, workspace["id"])
    lecture = _lecture(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    slot = zoned_iso(page, _tomorrow(page), "10:00")
    page.goto(f"{base_url}/en/dashboard?item={lecture['id']}&occurrence={_epoch_ms(slot)}")
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text(
        "Data Structures lecture", timeout=NORMAL_TIMEOUT
    )
    return sheet, lecture, home, braude, slot


def _mark_through_dialog(page: Page, travel: Locator, choice: str):
    """Save travel, then answer "Every occurrence?" with `choice` ("every" or "one")."""
    save = travel.locator("[data-travel-save]")
    save.click()
    dialog = page.locator("[data-every-occurrence]")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("heading", name="Every occurrence?")).to_be_visible()
    with page.expect_response(_is_mark, timeout=APP_REQUEST_TIMEOUT) as marked:
        dialog.locator(f"[data-every-choice={choice}]").click()
    expect(dialog).to_be_hidden()
    return marked.value


def test_series_every_occurrence_creates_rule(
    page: Page, base_url: str, api_base_url: str, demo_owner
):
    user, workspace = demo_owner
    sheet, lecture, home, braude, slot = _open_lectures_sheet(
        page, base_url, api_base_url, demo_owner
    )
    travel = sheet.locator("[data-item-travel]")
    expect(travel.get_by_role("heading", name="Travel")).to_be_visible()
    add = travel.get_by_role("button", name="Add travel")
    add.click()
    panel = travel.locator("[data-travel-panel]")
    expect(panel).to_be_visible()
    # Its location ("Building L, Room 105") names none of his places: it goes to its own place,
    # worked out once saved.
    expect(panel.get_by_role("combobox", name="To")).to_contain_text("Its own place")
    expect(panel.locator("[data-travel-preview]")).to_have_attribute(
        "data-travel-preview", "own-place"
    )
    expect(panel.get_by_label("Arrive", exact=True)).to_have_value("10:00")

    # Cancel asks nothing: Save opens the dialog, and its Cancel goes back to Save.
    travel.locator("[data-travel-save]").click()
    dialog = page.locator("[data-every-occurrence]")
    expect(dialog).to_be_visible()
    expect(dialog.locator("[data-every-choice]")).to_have_count(2)
    dialog.get_by_role("button", name="Cancel").click()
    expect(dialog).to_be_hidden()
    expect(travel.locator("[data-travel-save]")).to_be_focused()

    # A series: the hint says up front that every occurrence keeps a length only.
    expect(panel.locator("[data-travel-span]")).to_contain_text(
        "Every occurrence keeps only the length, arriving as each one starts."
    )
    # He types a 30-minute bus arriving at 09:50: choosing every occurrence is told it keeps the
    # 30 minutes only (each occurrence arrives as it starts), never dropped without a word.
    panel.get_by_label("How long this trip takes (every time), in minutes").fill("30")
    panel.get_by_label("Arrive", exact=True).fill("09:50")
    expect(panel.get_by_label("Leave", exact=True)).to_have_value("09:20")
    travel.locator("[data-travel-save]").click()
    expect(dialog.locator("[data-every-length-only]")).to_have_text(
        "Every occurrence keeps only the length you typed (30 min), arriving as each one starts. "
        "The leave and arrive times you typed are kept if you choose This one only."
    )
    with page.expect_response(_is_mark, timeout=APP_REQUEST_TIMEOUT) as answered:
        dialog.locator("[data-every-choice=every]").click()
    expect(dialog).to_be_hidden()
    marked = answered.value
    # Every occurrence: a series rule, with no occurrence sent, and the length he typed.
    assert marked.url.split("?")[0].endswith(f"/travel/items/{lecture['id']}")
    assert marked.request.post_data_json == {
        "mode": "transit",
        "direction": "both",
        "placeId": None,
        "every": True,
        "there": {"minutes": 30, "fromPlaceId": home["id"]},
    }
    assert marked.status == 200, marked.text()[:300]
    series_rule = marked.json()["data"]["rule"]
    assert series_rule["scope"] == {"kind": "series", "itemId": lecture["id"]}
    # Its place isn't known yet, so the 30 minutes name no trip: nothing is stored, and it says so.
    assert marked.json()["data"]["lengthStored"] is False
    # A calm note, not an error, and it has the focus.
    note = travel.locator("[data-travel-note]")
    expect(note).to_have_text(
        "Travel is on. Trips appear after the next sync. "
        "If none appear, set its place for travel in its details. "
        "The length you typed wasn’t saved: its place isn’t known yet. "
        "Choose where you go, then set it again."
    )
    expect(note).to_be_focused()
    expect(travel.locator("[data-travel-error]")).to_have_count(0)
    status = travel.locator("[data-travel-status]")
    expect(status).to_contain_text(
        "Public transport · There and back · to its own place", timeout=NORMAL_TIMEOUT
    )
    expect(status).to_contain_text("Every occurrence")
    rules = list_rules(api_base_url, user, workspace["id"])
    assert [(r["scope"], r["mode"], r["direction"]) for r in rules] == [
        ({"kind": "series", "itemId": lecture["id"]}, "transit", "both")
    ]

    # "Place for travel" pins the lecture to Braude.
    place = travel.locator("[data-travel-place]")
    choose(place.get_by_role("combobox", name="Place for travel"), "Braude")
    with page.expect_response(
        lambda r: r.request.method == "PUT" and "/travel/item-places/" in r.url,
        timeout=APP_REQUEST_TIMEOUT,
    ) as pinned:
        place.get_by_role("button", name="Set place").click()
    assert pinned.value.status == 204
    assert pinned.value.url.endswith(f"/travel/item-places/{lecture['id']}")
    assert pinned.value.request.post_data_json == {"placeId": braude["id"]}
    expect(place).to_contain_text("Its place for travel was saved.")

    # This one only: tomorrow's occurrence by its original start, driving there.
    travel.get_by_role("button", name="Change travel").click()
    panel.get_by_text("Drive", exact=True).click()
    travel.get_by_role("checkbox", name="Back").click()
    marked = _mark_through_dialog(page, travel, "one")
    body = marked.request.post_data_json
    assert set(body) == {"mode", "direction", "placeId", "occurrence"}, body
    assert (body["mode"], body["direction"], body["placeId"]) == ("drive", "there", None)
    assert _same_instant(body["occurrence"], slot)
    assert marked.status == 200, marked.text()[:300]
    # No length typed: nothing to say about one.
    assert marked.json()["data"]["lengthStored"] is None
    scope = marked.json()["data"]["rule"]["scope"]
    assert (scope["kind"], scope["itemId"]) == ("item", lecture["id"])
    assert _same_instant(scope["occurrence"], slot)
    expect(status).to_contain_text("Driving · There · to its own place", timeout=NORMAL_TIMEOUT)
    expect(status).to_contain_text("This occurrence")

    # Removing this one's leaves every occurrence's; then that goes too.
    with page.expect_response(
        lambda r: r.request.method == "DELETE" and "/travel/items/" in r.url,
        timeout=APP_REQUEST_TIMEOUT,
    ) as removed:
        travel.get_by_role("button", name="Remove travel", exact=True).click()
    assert removed.value.status == 204
    assert "occurrence=" in removed.value.url and "every=" not in removed.value.url
    expect(status).to_contain_text("Every occurrence", timeout=NORMAL_TIMEOUT)
    with page.expect_response(
        lambda r: r.request.method == "DELETE" and "/travel/items/" in r.url,
        timeout=APP_REQUEST_TIMEOUT,
    ) as removed:
        travel.get_by_role("button", name="Remove travel from every occurrence").click()
    assert removed.value.status == 204
    assert removed.value.url.endswith("?every=true")
    expect(travel.get_by_role("button", name="Add travel")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(travel.locator("[data-travel-note]")).to_have_text("Travel removed.")
    assert list_rules(api_base_url, user, workspace["id"]) == []

    # A save that fails leaves focus on what went wrong, not on the page.
    def refuse(route):
        route.fulfill(status=500, json={"message": "Internal server error"})

    page.route("**/travel/items/**", refuse)
    travel.get_by_role("button", name="Add travel").click()
    _mark_through_dialog(page, travel, "every")
    error = travel.locator("[data-travel-error]")
    expect(error).to_contain_text("Travel couldn’t be added.")
    expect(error).to_be_focused()
    page.unroute("**/travel/items/**", refuse)
    assert list_rules(api_base_url, user, workspace["id"]) == []


def test_moved_occurrence_shows_its_mark(page: Page, base_url: str, api_base_url: str, demo_owner):
    """The demo's lecture 6 days ago was moved from 10:00 to 13:00: a row of its own, whose marks
    the server keeps under the series at the original start. Its sheet finds them there."""
    user, workspace = demo_owner
    _seed_places(api_base_url, user, workspace["id"])
    lecture = _lecture(api_base_url, user, workspace["id"])
    headers = {"Authorization": f"Bearer {user.id_token}"}
    response = requests.get(
        f"{api_base_url}/private/workspaces/{workspace['id']}/items",
        params={"provider": "google_calendar", "q": "Data Structures"},
        headers=headers,
        timeout=30,
    )
    rows = [
        item
        for item in response.json()["data"]["items"]
        if item["props"].get("recurringEventId") == lecture["props"]["eventId"]
        and item["status"] != "cancelled"
    ]
    assert len(rows) == 1, rows
    moved = rows[0]
    original = moved["props"]["originalStartAt"]
    # Its view names its series and original start: ids and times only.
    detail = requests.get(
        f"{api_base_url}/private/workspaces/{workspace['id']}/items/{moved['id']}",
        headers=headers,
        timeout=30,
    ).json()["data"]
    assert detail["seriesOccurrence"]["seriesId"] == lecture["id"]
    assert _same_instant(detail["seriesOccurrence"]["originalStart"], original)

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    page.goto(f"{base_url}/en/dashboard?item={moved['id']}&occurrence={_epoch_ms(original)}")
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text(
        "Data Structures lecture", timeout=NORMAL_TIMEOUT
    )
    travel = sheet.locator("[data-item-travel]")
    travel.get_by_role("button", name="Add travel").click()
    # A moved occurrence is one of a series: Save asks, and "This one only" names its slot.
    marked = _mark_through_dialog(page, travel, "one")
    assert marked.url.split("?")[0].endswith(f"/travel/items/{moved['id']}")
    assert _same_instant(marked.request.post_data_json["occurrence"], original)
    assert marked.status == 200, marked.text()[:300]
    scope = marked.json()["data"]["rule"]["scope"]
    assert (scope["kind"], scope["itemId"]) == ("item", lecture["id"])
    assert _same_instant(scope["occurrence"], original)
    # The sheet shows the mark kept under the series, with Change and Remove.
    status = travel.locator("[data-travel-status]")
    expect(status).to_contain_text("Public transport · There and back", timeout=NORMAL_TIMEOUT)
    expect(status).to_contain_text("This occurrence")
    expect(travel.get_by_role("button", name="Change travel")).to_be_visible()
    with page.expect_response(
        lambda r: r.request.method == "DELETE" and "/travel/items/" in r.url,
        timeout=APP_REQUEST_TIMEOUT,
    ) as removed:
        travel.get_by_role("button", name="Remove travel", exact=True).click()
    assert removed.value.status == 204
    assert "occurrence=" in removed.value.url
    expect(travel.get_by_role("button", name="Add travel")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert list_rules(api_base_url, user, workspace["id"]) == []


def test_series_every_occurrence_makes_legs_each_week(
    page: Page, base_url: str, api_base_url: str, demo_owner
):
    sheet, lecture, home, braude, slot = _open_lectures_sheet(
        page, base_url, api_base_url, demo_owner
    )
    travel = sheet.locator("[data-item-travel]")
    travel.get_by_role("button", name="Add travel").click()
    panel = travel.locator("[data-travel-panel]")
    choose(panel.get_by_role("combobox", name="To"), "Braude")
    marked = _mark_through_dialog(page, travel, "every")
    assert marked.status == 200, marked.text()[:300]
    legs = marked.json()["data"]["legs"]
    tomorrow = _tomorrow(page)
    # The whole 14-day horizon holds exactly two legs, tomorrow's: the bus there, arriving as the
    # 10:00 lecture starts, and the bus home as it ends at 12:00. The occurrence in 8 days is
    # cancelled, and the next one (in 15 days) is past the horizon.
    assert [
        (
            leg["title"],
            leg["props"]["travel"]["direction"],
            leg["props"]["travel"]["anchorItemId"],
            leg["props"]["travel"]["mode"],
        )
        for leg in legs
    ] == [
        ("Bus to Braude", "there", lecture["id"], "transit"),
        ("Bus home", "back", lecture["id"], "transit"),
    ], legs
    there, back = legs
    assert _same_instant(there["props"]["travel"]["occurrence"], slot)
    assert _same_instant(back["props"]["travel"]["occurrence"], slot)
    assert there["props"]["travel"]["toPlaceId"] == braude["id"]
    assert _same_instant(there["endAt"], slot)
    assert _same_instant(back["startAt"], zoned_iso(page, tomorrow, "12:00"))
    expect(travel.locator("[data-travel-note]")).to_have_text("Travel added: 2 trips.")
    # And no leg of the lecture on any other day of the next 14.
    today = add_days(tomorrow, -1)
    response = requests.get(
        f"{api_base_url}/private/workspaces/{demo_owner[1]['id']}/travel/days",
        params={"from": today, "to": add_days(today, 13)},
        headers={"Authorization": f"Bearer {demo_owner[0].id_token}"},
        timeout=30,
    )
    assert response.status_code == 200, response.text[:300]
    days_with_lecture = [
        day["date"]
        for day in response.json()["data"]["days"]
        if any(leg["props"]["travel"]["anchorItemId"] == lecture["id"] for leg in day["legs"])
    ]
    assert days_with_lecture == [tomorrow]
