"""
Travel to a painted area (time-blocks design, "Areas": "an area can carry travel"; travel design,
"The day plan", 7; the owner's ruling of 2026-11-18): the area form's "Add travel time", "Add
travel" in an area's sheet, and the legs of a day with a block inside the area at another place.

Home, Braude and the gym are seeded by name through the API (tests/helpers/travel.py): nothing is
looked up.

DEFERRED until the branch is merged to dev: the dev database's Items validator predates kinds
`block` and `travel`, so neither an area nor a leg can be stored there. What runs now is
`test_area_form_offers_travel_and_marks_the_new_area`: it answers the area's create (as the server
answers it) and its mark, and asserts the form and the bodies it sends. The test against the real
server is marked `xfail(strict=True)` with the exact legs expected; the area's create is where it
fails today. Once dev stores areas and legs it passes, the strict xfail turns that into a failure,
and the mark must come off. Nothing here is gated on a result.
"""
import json
import re
from datetime import datetime

import pytest
from playwright.sync_api import Page, Route, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.scheduled import (
    add_days,
    choose_kind,
    create_time_block,
    open_new_sheet,
    this_sunday,
    zoned_iso,
)
from tests.helpers.select import choose
from tests.helpers.travel import create_place, get_days, list_rules, mark_item
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

DEFERRED = (
    "DEFERRED until merge to dev: the dev Items validator rejects kinds block and travel, so no area "
    "or leg is stored"
)
AREA_ID = "area-stubbed-studying"
# U+2066 / U+2069: the times are isolated left to right inside the line (it reads right in Hebrew).
LTR, END = "\u2066", "\u2069"


def _tomorrow(page: Page) -> str:
    today = page.evaluate(
        "() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())"
    )
    return add_days(today, 1)


def _same_instant(a: str, b: str) -> bool:
    return datetime.fromisoformat(a.replace("Z", "+00:00")) == datetime.fromisoformat(
        b.replace("Z", "+00:00")
    )


def _is_mark(response) -> bool:
    return response.request.method == "POST" and "/travel/items/" in response.url


def _is_preview(mode: str):
    """`POST …/travel/preview` of a trip by `mode`, for page.expect_request."""
    return lambda request: (
        request.method == "POST"
        and request.url.endswith("/travel/preview")
        and (request.post_data_json or {}).get("mode") == mode
    )


def _answer(route: Route, status: int, data: dict) -> None:
    """Answers a cross-origin API call as the server would: its envelope and CORS headers."""
    origin = route.request.headers.get("origin", "*")
    route.fulfill(
        status=status,
        headers={
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "vary": "Origin",
            "content-type": "application/json",
        },
        body=json.dumps(data),
    )


def _seed(api_base_url: str, fresh_owner, page: Page, base_url: str) -> tuple:
    """Home, Braude and the gym by coordinates, the default dashboard, the page open on it.
    Returns (user, workspace, home, braude, gym)."""
    user, workspace = fresh_owner
    home = create_place(api_base_url, user, workspace["id"], "Home", home=True)
    braude = create_place(api_base_url, user, workspace["id"], "Braude")
    gym = create_place(api_base_url, user, workspace["id"], "Gym")
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    return user, workspace, home, braude, gym


def test_area_form_offers_travel_and_marks_the_new_area(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace, _home, braude, _gym = _seed(api_base_url, fresh_owner, page, base_url)
    sunday = add_days(this_sunday(page), 7)
    created: list = []
    marked: list = []

    def create(route: Route) -> None:
        body = route.request.post_data_json or {}
        created.append(body)
        _answer(
            route,
            201,
            {
                "success": True,
                "data": {
                    "id": AREA_ID,
                    "kind": "block",
                    "title": body.get("title"),
                    "topicId": None,
                    "status": "open",
                    "startAt": body.get("startAt"),
                    "endAt": body.get("endAt"),
                    "dueAt": None,
                    "allDay": False,
                    "containerId": None,
                    "props": {
                        "layer": "area",
                        "recurrence": body.get("recurrence"),
                        "exceptions": [],
                    },
                },
            },
        )

    def mark(route: Route) -> None:
        marked.append(route.request.post_data_json)
        _answer(route, 500, {"success": False, "message": "Internal server error"})

    page.route(re.compile(r".*/time-blocks$"), create)
    page.route(re.compile(rf".*/travel/items/{AREA_ID}$"), mark)

    sheet = open_new_sheet(page)
    form = choose_kind(sheet, "area")
    form.get_by_label("Title", exact=True).fill("Studying")
    form.get_by_label("Start date", exact=True).fill(sunday)
    form.get_by_label("Start time", exact=True).fill("08:00")
    form.get_by_label("End time", exact=True).fill("16:00")
    expect(form.get_by_label("Hours", exact=True)).to_have_value("8")
    choose(form.get_by_label("Repeat", exact=True), "Weekly on Sunday")

    # The area form offers travel, as the block form does: off until he turns it on.
    switch = form.get_by_role("switch", name="Add travel time")
    expect(switch).to_be_enabled()
    expect(switch).to_have_attribute("aria-checked", "false")
    expect(form.locator("[data-travel-panel]")).to_have_count(0)
    with page.expect_request(_is_preview("transit"), timeout=APP_REQUEST_TIMEOUT):
        switch.click()
    panel = form.locator("[data-travel-panel]")
    expect(panel).to_be_visible()
    expect(panel.get_by_role("combobox", name="From")).to_contain_text("Home")
    expect(panel.get_by_role("combobox", name="To")).to_contain_text("Braude")
    expect(panel.get_by_role("checkbox", name="There")).to_be_checked()
    expect(panel.get_by_role("checkbox", name="Back")).to_be_checked()
    # A weekly area's travel is for every occurrence: a length only, each trip arriving as its
    # occurrence starts (this one at 08:00).
    expect(panel.get_by_label("Arrive", exact=True)).to_have_count(0)
    expect(panel.get_by_label("How long this trip takes (every time), in minutes")).to_be_visible()
    expect(panel).to_contain_text("Every occurrence uses this length, arriving as each one starts.")
    # No length set for the trip yet: the 30-minute placeholder, said as such.
    expect(panel.locator("[data-travel-preview]")).to_have_text(
        f"Leave {LTR}07:30{END} · arrive {LTR}08:00{END} · 30 min (not set yet)",
        timeout=NORMAL_TIMEOUT,
    )

    form.locator("[data-time-block-save]").click()
    # The area was made; its travel answer failed here, and the toast names the area.
    toast = page.locator("[data-sonner-toast]", has_text="The area was created, but its travel")
    expect(toast).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(toast).to_contain_text("The area was created, but its travel wasn’t added.")
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)

    assert len(created) == 1, created
    area = created[0]
    assert (area["layer"], area["title"], area["recurrence"]) == (
        "area",
        "Studying",
        ["RRULE:FREQ=WEEKLY;BYDAY=SU"],
    )
    assert _same_instant(area["startAt"], zoned_iso(page, sunday, "08:00"))
    # Every occurrence, by bus both ways, to Braude: nothing typed, so no times are sent.
    assert marked == [
        {"mode": "transit", "direction": "both", "placeId": braude["id"], "every": True}
    ], marked
    assert list_rules(api_base_url, user, workspace["id"]) == []


@pytest.mark.xfail(strict=True, reason=DEFERRED)
def test_area_sheet_marks_travel_and_a_gym_block_inside_gets_its_own_legs(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace, _home, braude, gym = _seed(api_base_url, fresh_owner, page, base_url)
    tomorrow = _tomorrow(page)

    def at(time: str) -> str:
        return zoned_iso(page, tomorrow, time)

    # "Studying" tomorrow 08:00–16:00, with the gym at 12:00–13:00 inside it.
    area = create_time_block(
        api_base_url,
        user,
        workspace["id"],
        layer="area",
        title="Studying",
        startAt=at("08:00"),
        endAt=at("16:00"),
    )
    gym_block = create_time_block(
        api_base_url,
        user,
        workspace["id"],
        title="Gym",
        startAt=at("12:00"),
        endAt=at("13:00"),
    )

    page.goto(f"{base_url}/en/dashboard?item={area['id']}")
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text("Studying", timeout=NORMAL_TIMEOUT)
    travel = sheet.locator("[data-item-travel]")
    travel.get_by_role("button", name="Add travel").click()
    panel = travel.locator("[data-travel-panel]")
    expect(panel).to_be_visible()
    choose(panel.get_by_role("combobox", name="To"), "Braude")
    expect(panel.get_by_label("Arrive", exact=True)).to_have_value("08:00")
    # Not a repeating area: Save marks it at once.
    with page.expect_response(_is_mark, timeout=APP_REQUEST_TIMEOUT) as answered:
        travel.locator("[data-travel-save]").click()
    response = answered.value
    assert response.status == 200, response.text()[:300]
    assert response.request.post_data_json == {
        "mode": "transit",
        "direction": "both",
        "placeId": braude["id"],
    }
    legs = response.json()["data"]["legs"]
    assert [
        (leg["title"], leg["props"]["travel"]["direction"], leg["props"]["travel"]["anchorItemId"])
        for leg in legs
    ] == [
        ("Bus to Braude", "there", area["id"]),
        ("Bus home", "back", area["id"]),
    ], legs
    there, back = legs
    assert _same_instant(there["endAt"], at("08:00"))
    assert _same_instant(back["startAt"], at("16:00"))
    expect(travel.locator("[data-travel-note]")).to_have_text("Travel added: 2 trips.")

    # The gym inside the area, by car: there as it starts, back into the area as it ends.
    gym_legs = mark_item(
        api_base_url,
        user,
        workspace["id"],
        gym_block["id"],
        mode="drive",
        direction="both",
        place_id=gym["id"],
    )["legs"]
    assert [
        (leg["title"], leg["props"]["travel"]["direction"], leg["props"]["travel"]["conflict"])
        for leg in gym_legs
    ] == [
        ("Drive to Gym", "between", False),
        ("Drive to Braude", "back", False),
    ], gym_legs
    assert _same_instant(gym_legs[0]["endAt"], at("12:00"))
    assert _same_instant(gym_legs[1]["startAt"], at("13:00"))

    # The day: the area's legs around the gym's, and no other.
    [day] = get_days(api_base_url, user, workspace["id"], tomorrow, tomorrow)
    assert [
        (leg["title"], leg["props"]["travel"]["anchorItemId"], leg["props"]["travel"]["direction"])
        for leg in day["legs"]
    ] == [
        ("Bus to Braude", area["id"], "there"),
        ("Drive to Gym", gym_block["id"], "between"),
        ("Drive to Braude", gym_block["id"], "back"),
        ("Bus home", area["id"], "back"),
    ], day["legs"]
    assert day["removed"] == []
