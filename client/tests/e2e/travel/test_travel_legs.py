"""
Travel legs on screen (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Conflicts",
"Editing a leg", "Removal is visible", as the owner's decision of 2026-11-18 amends them): the leg's
sheet (times, length and source, flags, how long the trip takes every time and this trip's own
leave and arrive, "Set how long" for a trip with no length yet, Skip, Reset, Waze and Google Maps
links; never a status or a tick), the day's travel panel with why a trip was removed, and the
conflict, past and not-set-yet (dashed) marks in the week calendar, the clock, the agenda and the
timeline.

DEFERRED until the branch is merged to dev: the dev database's Items validator predates kind
`travel`, so no leg can be stored there (a mark answers `legs: []`; the server logs the refusal).
The three tests against the real server are marked `xfail(strict=True)`, each asserting exact
literal values; the first stored-leg step is where each fails today. Once dev stores legs they
pass, the strict xfail turns into a failure, and the marks must come off.

What runs now is `test_leg_views_render_from_stubbed_api`: it answers the reads that carry legs
(the blocks' query, `…/travel/days`, `…/items/:id`, the leg's links) and the leg's own changes with
fixture legs built from the server's types (tests/helpers/travel_legs.py), against the real app, in
English and Hebrew, and asserts what the UI renders and the bodies it sends.
"""
import re
from datetime import datetime, timedelta

import pytest
import requests
from playwright.sync_api import Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard
from tests.helpers.items import create_timed_todo, delete_item
from tests.helpers.scheduled import add_days, this_sunday, zoned_iso
from tests.helpers.travel import create_place, get_days, get_leg, mark_item
from tests.helpers.travel_legs import (
    NOW,
    TODAY,
    TOMORROW,
    Leg,
    StubbedLegs,
    at,
    iso,
    travel_props,
)
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

DEFERRED = (
    "DEFERRED until merge to dev: the dev Items validator rejects kind travel until sync-db runs"
)
# U+2066 / U+2069: a time isolated left to right inside a Hebrew line.
LTR, END = "⁦", "⁩"


# ─── Against the real server (DEFERRED: the dev stage can't store a leg yet) ─────────────────────


def _tomorrow(page: Page) -> str:
    today = page.evaluate(
        "() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())"
    )
    return add_days(today, 1)


def _same_instant(a: str, b: str) -> bool:
    return datetime.fromisoformat(a.replace("Z", "+00:00")) == datetime.fromisoformat(
        b.replace("Z", "+00:00")
    )


def _seed(api_base_url: str, fresh_owner, page: Page, base_url: str) -> tuple:
    """Home, Braude and TLVTech by name (nothing is looked up), the default dashboard, the page
    open on it. Returns (user, workspace, home, braude, tlvtech, tomorrow)."""
    user, workspace = fresh_owner
    home = create_place(api_base_url, user, workspace["id"], "Home", home=True)
    braude = create_place(api_base_url, user, workspace["id"], "Braude")
    tlvtech = create_place(api_base_url, user, workspace["id"], "TLVTech")
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    return user, workspace, home, braude, tlvtech, _tomorrow(page)


def _show_day_in_week(page: Page, day: str) -> None:
    """Moves the week calendar on when `day` is not in this week."""
    if day >= add_days(this_sunday(page), 7):
        page.locator("[data-calendar-view]").get_by_role("button", name="Next", exact=True).click()


@pytest.mark.xfail(strict=True, reason=DEFERRED)
def test_leg_sheet_edit_skip_reset(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace, _, braude, _, tomorrow = _seed(api_base_url, fresh_owner, page, base_url)
    wid = workspace["id"]
    lecture = create_timed_todo(
        api_base_url,
        user,
        wid,
        "Lecture at Braude",
        zoned_iso(page, tomorrow, "14:00"),
        zoned_iso(page, tomorrow, "15:00"),
    )
    marked = mark_item(
        api_base_url,
        user,
        wid,
        lecture["id"],
        mode="drive",
        direction="there",
        place_id=braude["id"],
        there={"minutes": 40},
    )

    # The first stored-leg step: exactly one leg, the drive there, 13:20-14:00: the 40 minutes
    # are the trip's (every time), so the leg follows the trip (not his by hand).
    legs = marked["legs"]
    assert [(leg["title"], leg["props"]["travel"]["direction"]) for leg in legs] == [
        ("Drive to Braude", "there")
    ], legs
    leg = legs[0]
    assert _same_instant(leg["startAt"], zoned_iso(page, tomorrow, "13:20"))
    assert _same_instant(leg["endAt"], zoned_iso(page, tomorrow, "14:00"))
    trip = leg["props"]["travel"]
    assert (trip["minutes"], trip["source"], trip["edited"], trip["fromName"], trip["toName"]) == (
        40,
        "set",
        False,
        "Home",
        "Braude",
    )

    # It opens from the week calendar: no status, no tick; Waze and Google Maps for a drive.
    page.reload()
    _show_day_in_week(page, tomorrow)
    event = page.locator("[data-calendar-view] .fc-event.tc-travel", has_text="Drive to Braude")
    expect(event).to_have_count(1, timeout=NORMAL_TIMEOUT)
    event.click()
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text("Drive to Braude")
    section = sheet.locator("[data-travel-leg]")
    expect(section.locator("[data-leg-route]")).to_have_text(re.compile(r"^Home\s*to\s*Braude$"))
    expect(section.locator("[data-leg-length]")).to_have_text("40 min · set by you")
    expect(sheet.get_by_role("checkbox")).to_have_count(0)
    expect(sheet.get_by_role("combobox")).to_have_count(0)
    expect(sheet.get_by_text(re.compile(r"Status|סטטוס"))).to_have_count(0)
    expect(section.locator("[data-leg-link='waze']")).to_have_count(1)
    expect(section.locator("[data-leg-link='google_maps']")).to_have_count(1)

    # This trip only: leave at 13:30 and arrive at 14:00 (30 min); the trip's length stays 40.
    section.get_by_label("Leave", exact=True).fill("13:30")
    section.get_by_label("Arrive", exact=True).fill("14:00")
    expect(section.get_by_label("How long this trip takes (every time)")).to_have_value("40")
    with page.expect_response(
        lambda r: r.request.method == "PATCH" and f"/travel/legs/{leg['id']}" in r.url,
        timeout=APP_REQUEST_TIMEOUT,
    ) as edited:
        section.locator("[data-leg-save]").click()
    assert edited.value.request.post_data_json == {
        "startAt": zoned_iso(page, tomorrow, "13:30"),
        "endAt": zoned_iso(page, tomorrow, "14:00"),
    }
    after = edited.value.json()["data"]["props"]["travel"]
    assert (after["minutes"], after["source"], after["edited"]) == (30, "set", True)
    expect(section.locator("[data-leg-length]")).to_have_text("30 min · set by you")

    # Reset: back to the trip's length (40), his times gone (nothing left to reset).
    with page.expect_response(
        lambda r: r.url.endswith(f"/travel/legs/{leg['id']}/reset") and r.request.method == "POST",
        timeout=APP_REQUEST_TIMEOUT,
    ) as reset:
        section.locator("[data-leg-reset]").click()
    assert reset.value.request.post_data_json == {}
    assert get_leg(api_base_url, user, wid, leg["id"])["props"]["travel"]["edited"] is False
    expect(section.locator("[data-leg-reset]")).to_be_disabled()
    expect(section.locator("[data-leg-length]")).to_have_text("40 min · set by you")

    # Skip: the trip is a tombstone with its reason, and the sheet closes.
    with page.expect_response(
        lambda r: r.url.endswith(f"/travel/legs/{leg['id']}/skip") and r.request.method == "POST",
        timeout=APP_REQUEST_TIMEOUT,
    ) as skipped:
        section.locator("[data-leg-skip]").click()
    assert skipped.value.status == 204
    assert skipped.value.request.post_data_json == {}
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)
    [day] = get_days(api_base_url, user, wid, tomorrow, tomorrow)
    assert day["legs"] == []
    assert [(row["title"], row["reason"]) for row in day["removed"]] == [
        ("Drive to Braude", "skipped")
    ]

    # The day's panel brings it back.
    page.goto(f"{base_url}/en/dashboard?travelDay={tomorrow}")
    panel = page.locator("[data-travel-day-sheet]")
    expect(panel.locator("[data-travel-removed-text]")).to_have_text(
        "Drive to Braude removed: you skipped it", timeout=NORMAL_TIMEOUT
    )
    panel.locator("[data-travel-bring-back]").click()
    expect(panel.locator("[data-travel-day-leg]")).to_have_count(1, timeout=NORMAL_TIMEOUT)
    [day] = get_days(api_base_url, user, wid, tomorrow, tomorrow)
    assert [leg["title"] for leg in day["legs"]] == ["Drive to Braude"]
    assert day["removed"] == []


@pytest.mark.xfail(strict=True, reason=DEFERRED)
def test_cancelled_anchor_shows_reason_in_day_panel(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace, _, braude, _, tomorrow = _seed(api_base_url, fresh_owner, page, base_url)
    wid = workspace["id"]
    lecture = create_timed_todo(
        api_base_url,
        user,
        wid,
        "Lecture at Braude",
        zoned_iso(page, tomorrow, "14:00"),
        zoned_iso(page, tomorrow, "15:00"),
    )
    marked = mark_item(
        api_base_url, user, wid, lecture["id"], direction="there", place_id=braude["id"]
    )
    # The first stored-leg step: the bus there (public transport is the default mode).
    assert [(leg["title"], leg["props"]["travel"]["anchorItemId"]) for leg in marked["legs"]] == [
        ("Bus to Braude", lecture["id"])
    ], marked["legs"]

    # The lecture is cancelled (deleted): its trip goes, and the day says why.
    delete_item(api_base_url, user, wid, lecture["id"])
    removed: list = []
    for _ in range(20):
        [day] = get_days(api_base_url, user, wid, tomorrow, tomorrow)
        removed = day["removed"]
        if removed:
            break
        page.wait_for_timeout(1000)
    assert [(row["title"], row["reason"]) for row in removed] == [("Bus to Braude", "cancelled")]

    page.goto(f"{base_url}/en/dashboard?travelDay={tomorrow}")
    panel = page.locator("[data-travel-day-sheet]")
    expect(panel.locator("[data-travel-day-leg]")).to_have_count(0, timeout=NORMAL_TIMEOUT)
    expect(panel.locator("[data-travel-removed-text]")).to_have_text(
        "Bus to Braude removed: the event was cancelled"
    )


@pytest.mark.xfail(strict=True, reason=DEFERRED)
def test_conflict_marked(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace, _, braude, tlvtech, tomorrow = _seed(api_base_url, fresh_owner, page, base_url)
    wid = workspace["id"]
    # Two anchors 15 minutes apart at different places: Braude until 15:00, TLVTech from 15:15.
    first = create_timed_todo(
        api_base_url,
        user,
        wid,
        "Lecture at Braude",
        zoned_iso(page, tomorrow, "14:00"),
        zoned_iso(page, tomorrow, "15:00"),
    )
    second = create_timed_todo(
        api_base_url,
        user,
        wid,
        "Meeting at TLVTech",
        zoned_iso(page, tomorrow, "15:15"),
        zoned_iso(page, tomorrow, "16:00"),
    )
    mark_item(
        api_base_url, user, wid, first["id"], mode="drive", direction="there", place_id=braude["id"]
    )
    mark_item(
        api_base_url,
        user,
        wid,
        second["id"],
        mode="drive",
        direction="there",
        place_id=tlvtech["id"],
    )

    # The first stored-leg step: the drive there, and the drive between that can't be made.
    [day] = get_days(api_base_url, user, wid, tomorrow, tomorrow)
    trips = [
        (
            leg["title"],
            leg["props"]["travel"]["direction"],
            leg["props"]["travel"]["conflict"],
            leg["props"]["travel"]["fromName"],
            leg["props"]["travel"]["toName"],
        )
        for leg in day["legs"]
    ]
    assert trips == [
        ("Drive to Braude", "there", False, "Home", "Braude"),
        ("Drive to TLVTech", "between", True, "Braude", "TLVTech"),
    ], trips
    # It leaves as the lecture ends (15:00): the plan never moves his events.
    assert _same_instant(day["legs"][1]["startAt"], zoned_iso(page, tomorrow, "15:00"))

    page.reload()
    _show_day_in_week(page, tomorrow)
    calendar = page.locator("[data-calendar-view]")
    marked = calendar.locator(".fc-event.tc-travel[data-conflict='true']")
    expect(marked).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(marked).to_contain_text("Drive to TLVTech")
    expect(marked).to_have_attribute("aria-label", re.compile(r"You can’t make it$"))
    expect(calendar.locator(".fc-event.tc-travel[data-conflict='false']")).to_have_count(1)
    marked.click()
    flag = page.locator("[data-item-sheet] [data-leg-flag='conflict']")
    expect(flag).to_contain_text("You can’t make it")


# ─── What the UI renders from stubbed reads (runs now) ───────────────────────────────────────────

TEXT = {
    "en": {
        "path": "/en/dashboard",
        "home": "Home",
        "braude": "Braude",
        "tlv": "TLVTech",
        "bus_braude": "Bus to Braude",
        "drive_tlv": "Drive to TLVTech",
        "walk_braude": "Walk to Braude",
        "bus_home": "Bus home",
        "conflict": "You can’t make it",
        "moved": "The event moved; check this trip",
        "moved_now": f"It now starts at {LTR}18:00{END}.",
        "cancelled": "Bus to Braude removed: the event was cancelled",
        "skipped": "Bus to Braude removed: you skipped it",
        "changed": "Travel changed",
        "mode_bus": "Public transport",
        "length_set": "40 min · set by you",
        "length_35": "35 min · set by you",
        "length_unset": "Set how long · 30 min for now",
        "length_field": "How long this trip takes (every time)",
        "length_placeholder": "Set how long",
        "length_unset_hint": "Not set yet: it’s shown as 30 min until you set it.",
        "length_saved": "Every Bus home now takes 35 min.",
        "set_length": "Set how long",
        "kind": "Travel",
        "to": "to",
    },
    "he": {
        "path": "/he/dashboard",
        "home": "בית",
        "braude": "בראודה",
        "tlv": "TLVTech",
        "bus_braude": "נסיעה באוטובוס לבראודה",
        "drive_tlv": "נסיעה ברכב ל-TLVTech",
        "walk_braude": "הליכה לבראודה",
        "bus_home": "נסיעה באוטובוס הביתה",
        "conflict": "אי אפשר להגיע",
        "moved": "האירוע זז; כדאי לבדוק את הנסיעה",
        "moved_now": f"עכשיו הוא מתחיל ב-{LTR}18:00{END}.",
        "cancelled": "נסיעה באוטובוס לבראודה הוסרה: האירוע בוטל",
        "skipped": "נסיעה באוטובוס לבראודה הוסרה: דילגתם עליה",
        "changed": "הנסיעות השתנו",
        "mode_bus": "תחבורה ציבורית",
        "length_set": "40 דק׳ · נקבע על ידכם",
        "length_35": "35 דק׳ · נקבע על ידכם",
        "length_unset": "קבעו כמה זמן · 30 דק׳ בינתיים",
        "length_field": "כמה זמן הנסיעה הזו לוקחת (בכל פעם)",
        "length_placeholder": "קבעו כמה זמן",
        "length_unset_hint": "עדיין לא נקבע: מוצג כ-30 דק׳ עד שתקבעו.",
        "length_saved": "כל נסיעה באוטובוס הביתה לוקחת עכשיו 35 דק׳.",
        "set_length": "קבעו כמה זמן",
        "kind": "נסיעה",
        "to": "אל",
    },
}


def fixture_legs(language: str) -> StubbedLegs:
    """The page's day: one leg each of walking (past), driving (in conflict, on now), the bus (next,
    its trip's length not set yet: the 30-minute placeholder) and the bus home (its event moved,
    edited by hand), and tomorrow's walk; a cancelled trip today. Built as the server stores them
    (tests/helpers/travel_legs.py)."""
    text = TEXT[language]
    home, braude, tlv = text["home"], text["braude"], text["tlv"]
    walk_past = Leg(
        "leg-walk-past",
        at(TODAY, "08:10"),
        at(TODAY, "08:40"),
        travel_props(
            "lecture-1", "there", "walk", home, braude, at(TODAY, "08:40"), 30, "set",
            from_home=True,
        ),
    )
    drive_conflict = Leg(
        "leg-drive-conflict",
        at(TODAY, "11:40"),
        at(TODAY, "12:20"),
        travel_props(
            "meeting-1", "between", "drive", braude, tlv, at(TODAY, "12:20"), 40, "set",
            conflict=True,
        ),
    )
    bus_next = Leg(
        "leg-bus-next",
        at(TODAY, "13:10"),
        at(TODAY, "13:40"),
        travel_props(
            "class-1", "there", "transit", home, braude, at(TODAY, "13:40"), 30, "unset", from_home=True
        ),
    )
    computed = {
        "start": at(TODAY, "18:00"),
        "end": at(TODAY, "18:40"),
        "travel": travel_props(
            "dinner-1", "back", "transit", braude, home, at(TODAY, "18:00"), 40, "set", to_home=True
        ),
    }
    bus_moved = Leg(
        "leg-bus-moved",
        at(TODAY, "17:00"),
        at(TODAY, "17:40"),
        travel_props(
            "dinner-1", "back", "transit", braude, home, at(TODAY, "17:00"), 40, "set",
            to_home=True, edited=True, anchor_moved=True, anchor_start_now=at(TODAY, "18:00"),
        ),
        computed,
    )
    walk_tomorrow = Leg(
        "leg-walk-tomorrow",
        at(TOMORROW, "09:00"),
        at(TOMORROW, "09:15"),
        travel_props(
            "lecture-2", "there", "walk", home, braude, at(TOMORROW, "09:15"), 15, "set",
            from_home=True,
        ),
    )
    gone = {
        "id": "leg-gone",
        "title": f"Bus to {braude}",
        "reason": "cancelled",
        "mode": "transit",
        "toHome": False,
        "toName": braude,
        "removedAt": iso(NOW - timedelta(hours=1)),
    }
    return StubbedLegs(
        "",
        [walk_past, drive_conflict, bus_next, bus_moved, walk_tomorrow],
        {TODAY: [gone]},
    )


def _blocks(api_base_url: str, user, workspace_id: str) -> dict:
    """The default dashboard with an agenda and a timeline added; the ids of its calendar, clock,
    agenda and timeline blocks by type."""
    dashboard = create_dashboard(api_base_url, user, workspace_id)
    query = {"source": "items", "dateRange": "next_7d", "dateField": "startAt"}
    apply_ops(
        api_base_url,
        user,
        workspace_id,
        dashboard["id"],
        dashboard["version"],
        [
            {
                "op": "add_block",
                "block": {"type": "agenda", "title": "Agenda", "query": query, "viz": {"kind": "agenda"}},
            },
            {
                "op": "add_block",
                "block": {
                    "type": "timeline",
                    "title": "Timeline",
                    "query": query,
                    "viz": {"kind": "timeline", "days": 2},
                },
            },
        ],
    )
    blocks = get_dashboard(api_base_url, user, workspace_id, dashboard["id"])["blocks"]
    return {kind: next(b["id"] for b in blocks if b["type"] == kind) for kind in ("calendar", "clock", "agenda", "timeline")}


def _open_stubbed(page: Page, base_url: str, api_base_url: str, fresh_owner, language: str):
    """A fresh workspace whose time blocks are answered with the fixture legs, the page's clock
    fixed at Wednesday 18 November 2026, 12:00 in Jerusalem. Returns (stub, user, workspace)."""
    user, workspace = fresh_owner
    ids = _blocks(api_base_url, user, workspace["id"])
    stub = fixture_legs(language)
    stub.workspace_id = workspace["id"]
    stub.install(page, list(ids.values()))
    page.clock.set_fixed_time(NOW)
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, TEXT[language]["path"])
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    return stub, user, workspace


def _check_calendar(page: Page, text: dict) -> None:
    calendar = page.locator("[data-calendar-view]")
    event = lambda leg_id: calendar.locator(f".fc-event[data-item-id='{leg_id}']")  # noqa: E731
    for leg_id, title, mode, conflict, past in (
        ("leg-walk-past", text["walk_braude"], "walk", "false", "true"),
        ("leg-drive-conflict", text["drive_tlv"], "drive", "true", "false"),
        ("leg-bus-next", text["bus_braude"], "transit", "false", "false"),
        ("leg-bus-moved", text["bus_home"], "transit", "false", "false"),
        ("leg-walk-tomorrow", text["walk_braude"], "walk", "false", "false"),
    ):
        leg = event(leg_id)
        expect(leg).to_have_count(1, timeout=NORMAL_TIMEOUT)
        expect(leg).to_contain_text(title)
        expect(leg).to_have_attribute("data-conflict", conflict)
        expect(leg).to_have_attribute("data-past", past)
        expect(leg).to_have_attribute("data-leg-mode", mode)
        # The mode's icon, drawn in the event (a footprint, a car or a bus), never the source's.
        expect(leg.locator(f"svg[data-leg-mode='{mode}']")).to_have_count(1)
    # In conflict: a red edge (the class) and the words, which are also its label.
    expect(event("leg-drive-conflict")).to_have_class(re.compile(r"\btc-conflict\b"))
    expect(event("leg-drive-conflict")).to_have_attribute(
        "aria-label", re.compile(re.escape(text["conflict"]) + r"$")
    )
    expect(event("leg-drive-conflict").locator("[data-leg-conflict-label]")).to_have_text(
        text["conflict"]
    )
    expect(calendar.locator(".tc-conflict")).to_have_count(1)
    # Past: dimmed. Only the walk this morning.
    expect(event("leg-walk-past")).to_have_class(re.compile(r"\btc-past\b"))
    expect(calendar.locator(".tc-past")).to_have_count(1)
    expect(event("leg-bus-moved")).to_have_attribute("data-anchor-moved", "true")
    # Its trip's length not set yet: drawn dashed (the class), and said in its attribute.
    expect(event("leg-bus-next")).to_have_class(re.compile(r"\btc-unset\b"))
    expect(event("leg-bus-next")).to_have_attribute("data-length-unset", "true")
    expect(calendar.locator(".tc-unset")).to_have_count(1)
    # And in its name, for anyone who can't see the dashes.
    expect(event("leg-bus-next")).to_have_attribute(
        "aria-label", re.compile(re.escape(text["set_length"]) + r"$")
    )
    expect(event("leg-bus-moved")).not_to_have_attribute(
        "aria-label", re.compile(re.escape(text["set_length"]))
    )


def _check_clock(page: Page, text: dict) -> None:
    ring = page.locator("svg[role='img']").filter(has=page.locator("path[data-leg-mode]"))
    expect(ring).to_have_count(1, timeout=NORMAL_TIMEOUT)
    arcs = ring.locator("path[data-leg-mode]")
    expect(arcs).to_have_count(4)
    expect(ring.locator("path[data-conflict='true']")).to_have_count(1)
    expect(ring.locator("path[data-conflict='true']")).to_have_attribute("data-leg-mode", "drive")
    # The red edge: a destructive stroke on the conflict arc, none on the others.
    expect(ring.locator("path[data-conflict='true']")).to_have_attribute(
        "style", re.compile(r"stroke: var\(--destructive\)")
    )
    expect(
        ring.locator("path[data-conflict='false'][data-length-unset='false'][style*='stroke']")
    ).to_have_count(0)
    # The bus whose trip has no length yet: a dashed edge.
    unset = ring.locator("path[data-length-unset='true']")
    expect(unset).to_have_count(1)
    expect(unset).to_have_attribute("style", re.compile(r"stroke-dasharray"))
    # Said in its words too: the arc's title (and the ring's list for screen readers).
    expect(unset.locator("title")).to_have_text(
        re.compile(re.escape(text["set_length"]) + r"$")
    )
    expect(
        ring.locator("path[data-length-unset='false'] title", has_text=text["set_length"])
    ).to_have_count(0)
    expect(ring.locator("path[data-past='true']")).to_have_count(1)
    expect(ring.locator("path[data-past='true']")).to_have_attribute("data-leg-mode", "walk")
    # The ring's own words name the trip in the UI language.
    expect(ring).to_have_attribute("aria-label", re.compile(re.escape(text["drive_tlv"])))
    # Now and Next, as the clock reads them: the drive on now, in conflict; the bus next.
    summary = page.locator("[aria-live='polite']").filter(has=page.locator("[data-clock-line]"))
    now_line = summary.locator("[data-clock-line][data-conflict='true']")
    expect(now_line).to_have_count(1)
    expect(now_line).to_contain_text(text["drive_tlv"])
    expect(now_line).to_contain_text(text["conflict"])
    expect(now_line.locator("svg[data-leg-mode='drive']")).to_have_count(1)
    next_line = summary.locator("[data-clock-line][data-conflict='false']")
    expect(next_line).to_have_count(1)
    expect(next_line).to_contain_text(text["bus_braude"])
    expect(next_line).to_contain_text("13:10")
    expect(next_line.locator("svg[data-leg-mode='transit']")).to_have_count(1)


def _check_agenda(page: Page, text: dict) -> None:
    agenda = page.locator("[data-agenda]")
    expect(agenda).to_be_visible(timeout=NORMAL_TIMEOUT)
    rows = agenda.locator("li[data-agenda-leg]")
    # Every leg still to come, in its part of the day; the walk this morning is over, which an
    # agenda never lists.
    expect(rows).to_have_count(4)
    expect(rows.locator("xpath=self::*[@data-past='true']")).to_have_count(0)
    drive = agenda.locator("li[data-agenda-leg='drive']")
    expect(drive).to_have_attribute("data-conflict", "true")
    expect(drive).to_have_class(re.compile(r"before:bg-destructive"))
    expect(agenda.locator("li[data-agenda-leg][data-conflict='false'][class*='before:bg-destructive']")).to_have_count(0)
    expect(drive).to_contain_text(text["drive_tlv"])
    expect(drive).to_contain_text(text["conflict"])
    expect(drive.locator("svg[data-leg-mode='drive']")).to_have_count(1)
    expect(drive.locator("xpath=ancestor::section")).to_have_attribute("data-agenda-part", "now")
    expect(agenda.locator("li[data-agenda-leg][data-conflict='true']")).to_have_count(1)
    expect(agenda.locator("li[data-agenda-leg='transit']")).to_have_count(2)
    expect(agenda.locator("li[data-agenda-leg='walk']")).to_have_count(1)
    # The bus whose trip has no length yet: a dashed outline, said in its attribute.
    unset = agenda.locator("li[data-agenda-leg][data-length-unset='true']")
    expect(unset).to_have_count(1)
    expect(unset).to_have_class(re.compile(r"outline-dashed"))
    expect(unset.get_by_role("button")).to_have_accessible_name(
        f"{text['bus_braude']}. {text['set_length']}"
    )
    expect(
        agenda.locator("section[data-agenda-part='tomorrow'] li[data-agenda-leg='walk']")
    ).to_contain_text(text["walk_braude"])
    # Days with removals say so: today's cancelled trip.
    chips = agenda.locator("[data-agenda-travel-changed] a")
    expect(chips).to_have_count(1)
    expect(chips).to_have_attribute("data-travel-changed", TODAY)
    expect(chips).to_contain_text(text["changed"])


def _check_timeline(page: Page, text: dict) -> None:
    timeline = page.locator("[data-timeline]")
    expect(timeline).to_be_visible(timeout=NORMAL_TIMEOUT)
    rows = timeline.locator("li[data-timeline-leg]")
    expect(rows).to_have_count(5)
    conflict = timeline.locator("li[data-timeline-leg][data-conflict='true']")
    expect(conflict).to_have_count(1)
    expect(conflict).to_have_attribute("data-timeline-leg", "drive")
    expect(conflict).to_have_class(re.compile(r"before:bg-destructive"))
    expect(timeline.locator("li[data-timeline-leg][data-conflict='false'][class*='before:bg-destructive']")).to_have_count(0)
    expect(conflict).to_contain_text(text["drive_tlv"])
    expect(conflict).to_contain_text(text["conflict"])
    expect(conflict.locator("svg[data-leg-mode='drive']")).to_have_count(1)
    past = timeline.locator("li[data-timeline-leg][data-past='true']")
    expect(past).to_have_count(1)
    expect(past).to_have_attribute("data-timeline-leg", "walk")
    expect(past).to_contain_text(text["walk_braude"])
    expect(
        timeline.locator("[data-timeline-day='" + TOMORROW + "'] li[data-timeline-leg='walk']")
    ).to_have_count(1)
    unset = timeline.locator("li[data-timeline-leg][data-length-unset='true']")
    expect(unset).to_have_count(1)
    expect(unset).to_have_class(re.compile(r"outline-dashed"))
    expect(unset.get_by_role("button")).to_have_accessible_name(
        f"{text['bus_braude']}. {text['set_length']}"
    )


def _open_leg(page: Page, leg_id: str):
    """The leg's sheet, opened from the week calendar."""
    page.locator(f"[data-calendar-view] .fc-event[data-item-id='{leg_id}']").click()
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-travel-leg]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    return sheet


def _check_leg_sheet(page: Page, stub: StubbedLegs, text: dict) -> None:
    # A leg in conflict: the flag, in words, with why.
    sheet = _open_leg(page, "leg-drive-conflict")
    flag = sheet.locator("[data-leg-flag='conflict']")
    expect(flag).to_contain_text(text["conflict"])
    expect(sheet.locator("[data-item-title]")).to_have_text(text["drive_tlv"])
    expect(sheet.locator("[data-travel-leg]")).to_have_attribute("data-conflict", "true")
    expect(sheet.locator("[data-leg-link='waze']")).to_have_count(1)
    expect(sheet.locator("[data-leg-link='google_maps']")).to_have_count(1)
    expect(sheet.locator("[data-leg-link]")).to_have_count(2)
    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()

    # A trip there whose length isn't set yet: it says so, and asks for it (the field is empty).
    sheet = _open_leg(page, "leg-bus-next")
    section = sheet.locator("[data-travel-leg]")
    expect(section).to_have_attribute("data-length-unset", "true")
    expect(section.locator("[data-leg-length]")).to_have_text(text["length_unset"])
    length = section.get_by_label(text["length_field"])
    expect(length).to_have_value("")
    expect(length).to_have_attribute("placeholder", text["length_placeholder"])
    expect(section.locator("[data-leg-length-hint]")).to_have_text(text["length_unset_hint"])
    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()
    # The day says "Set how long" on it too.
    page.locator("[data-agenda] [data-travel-changed]").click()
    panel = page.locator("[data-travel-day-sheet]")
    expect(panel.locator(f"[data-travel-day='{TODAY}']")).to_be_visible(timeout=NORMAL_TIMEOUT)
    unset = panel.locator("[data-travel-day-leg='leg-bus-next']")
    expect(unset).to_have_attribute("data-length-unset", "true")
    expect(unset.locator("[data-leg-set-length]")).to_have_text(text["set_length"])
    expect(panel.locator("[data-leg-set-length]")).to_have_count(1)
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()

    # The leg whose event moved, edited by hand: the sheet in full.
    sheet = _open_leg(page, "leg-bus-moved")
    section = sheet.locator("[data-travel-leg]")
    expect(sheet.locator("[data-item-title]")).to_have_text(text["bus_home"])
    expect(sheet.locator("p", has_text=text["kind"]).first).to_be_visible()
    expect(section.locator("[data-leg-when]")).to_contain_text(re.compile(r"17:00\W+17:40"))
    expect(section).to_contain_text(text["mode_bus"])
    expect(section.locator("[data-leg-route]")).to_have_text(
        re.compile(rf"^{text['braude']}\s*{text['to']}\s*{text['home']}$")
    )
    expect(section.locator("[data-leg-length]")).to_have_text(text["length_set"])
    expect(section.locator("[data-leg-flag='moved']")).to_contain_text(text["moved"])
    expect(section.locator("[data-leg-flag='moved']")).to_contain_text(text["moved_now"])
    expect(section.locator("[data-leg-flag='conflict']")).to_have_count(0)
    # A trip is not a to-do: no status, no tick, no "mark as done".
    expect(sheet.get_by_role("checkbox")).to_have_count(0)
    expect(sheet.get_by_role("combobox")).to_have_count(0)
    expect(sheet.get_by_text(re.compile(r"Status|סטטוס"))).to_have_count(0)
    expect(sheet.locator("[data-item-local-edit]")).to_have_count(0)
    expect(sheet.locator("[data-item-details], #item-details")).to_have_count(0)
    # App links: Google Maps for the bus, from the places' text (never shown as text: no address
    # on the page). No Moovit.
    expect(section.locator("[data-leg-link='google_maps']")).to_have_count(1)
    expect(section.locator("[data-leg-link]")).to_have_count(1)
    expect(section.locator("[data-leg-link='google_maps']")).to_have_attribute(
        "href", re.compile(r"destination=Snunit%20St%2051%2C%20Karmiel&travelmode=transit$")
    )
    expect(sheet.locator("[data-leg-links]")).not_to_contain_text("Snunit")

    # Two changes, each said for what it is. How long the trip takes, every time: 40 (the trip's,
    # read for a leg he timed by hand).
    length = section.get_by_label(text["length_field"])
    expect(length).to_have_value("40", timeout=NORMAL_TIMEOUT)
    this_trip = section.locator("[data-leg-this-trip]")
    # This trip only: he leaves later (17:50), after it would have arrived (17:40): later that
    # day, not the day before. It keeps its own length, the arrival follows (18:30), and only the
    # time he typed is sent.
    this_trip.locator("input[type='time']").first.fill("17:50")
    expect(this_trip.locator("input[type='time']").nth(1)).to_have_value("18:30")
    expect(length).to_have_value("40")
    expect(section.locator("[data-leg-save]")).to_be_enabled()
    with page.expect_response(
        lambda r: r.request.method == "PATCH" and r.url.endswith("/travel/legs/leg-bus-moved"),
        timeout=APP_REQUEST_TIMEOUT,
    ):
        section.locator("[data-leg-save]").click()
    assert stub.calls[-1] == ("edit", "leg-bus-moved", {"startAt": iso(at(TODAY, "17:50"))})
    expect(section.locator("[data-leg-when]")).to_contain_text(re.compile(r"17:50\W+18:30"))
    # His times, acknowledged: the "moved" flag is gone.
    expect(section.locator("[data-leg-length]")).to_have_text(text["length_set"])
    expect(section.locator("[data-leg-flag='moved']")).to_have_count(0)
    expect(page.locator("[data-calendar-view] .fc-event[data-item-id='leg-bus-moved']")).to_have_attribute(
        "data-anchor-moved", "false"
    )
    # How long the trip takes, every time: 35. A trip back keeps its departure (17:50); only the
    # length is sent, and it says every such trip takes it now.
    length = section.get_by_label(text["length_field"])
    length.fill("35")
    expect(section.locator("[data-leg-this-trip] input[type='time']").nth(1)).to_have_value("18:25")
    with page.expect_response(
        lambda r: r.request.method == "PATCH" and r.url.endswith("/travel/legs/leg-bus-moved"),
        timeout=APP_REQUEST_TIMEOUT,
    ):
        section.locator("[data-leg-save]").click()
    assert stub.calls[-1] == ("edit", "leg-bus-moved", {"minutes": 35})
    expect(page.locator("[data-sonner-toast]", has_text=text["length_saved"])).to_be_visible()
    expect(section.locator("[data-leg-length]")).to_have_text(text["length_35"])
    # The way there (Home → Braude by bus) had no length yet: it starts with the same 35, and is
    # no longer dashed (13:05-13:40, arriving as the class starts).
    bus_next = page.locator("[data-calendar-view] .fc-event[data-item-id='leg-bus-next']")
    expect(bus_next).to_have_attribute("data-length-unset", "false", timeout=NORMAL_TIMEOUT)
    expect(page.locator("[data-calendar-view] .tc-unset")).to_have_count(0)

    # Reset: computed again with the trip's length (18:00-18:35), nothing left to reset.
    with page.expect_response(
        lambda r: r.request.method == "POST" and r.url.endswith("/travel/legs/leg-bus-moved/reset"),
        timeout=APP_REQUEST_TIMEOUT,
    ):
        section.locator("[data-leg-reset]").click()
    assert stub.calls[-1] == ("reset", "leg-bus-moved", {})
    expect(section.locator("[data-leg-when]")).to_contain_text(re.compile(r"18:00\W+18:35"))
    expect(section.locator("[data-leg-length]")).to_have_text(text["length_35"])
    expect(section.locator("[data-leg-reset]")).to_be_disabled()
    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()

    # The trip there took the way home's 35, set by him: the field shows it.
    sheet = _open_leg(page, "leg-bus-next")
    section = sheet.locator("[data-travel-leg]")
    expect(section).to_have_attribute("data-length-unset", "false")
    expect(section.locator("[data-leg-length]")).to_have_text(text["length_35"])
    expect(section.locator("[data-leg-when]")).to_contain_text(re.compile(r"13:05\W+13:40"))
    expect(section.get_by_label(text["length_field"])).to_have_value("35", timeout=NORMAL_TIMEOUT)
    # Skip a trip that was in the way: the sheet closes, and the calendar loses it.
    with page.expect_response(
        lambda r: r.request.method == "POST" and r.url.endswith("/travel/legs/leg-bus-next/skip"),
        timeout=APP_REQUEST_TIMEOUT,
    ):
        sheet.locator("[data-leg-skip]").click()
    assert stub.calls[-1] == ("skip", "leg-bus-next", {})
    expect(sheet).to_be_hidden(timeout=NORMAL_TIMEOUT)
    expect(page.locator("[data-calendar-view] .fc-event[data-item-id='leg-bus-next']")).to_have_count(
        0, timeout=NORMAL_TIMEOUT
    )


def _check_day_panel(page: Page, stub: StubbedLegs, text: dict) -> None:
    # The agenda's chip opens the day.
    page.locator("[data-agenda] [data-travel-changed]").click()
    panel = page.locator("[data-travel-day-sheet]")
    expect(panel.locator(f"[data-travel-day='{TODAY}']")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert f"travelDay={TODAY}" in page.url
    trips = panel.locator("[data-travel-day-leg]")
    # Today's trips: the walk, the drive in conflict, the bus home (the bus next was skipped).
    expect(trips).to_have_count(3)
    expect(panel.locator("[data-travel-day-leg][data-conflict='true']")).to_have_count(1)
    expect(panel.locator("[data-travel-day-leg][data-past='true']")).to_have_count(1)
    expect(panel.locator("[data-travel-day-leg='leg-drive-conflict']")).to_contain_text(
        text["drive_tlv"]
    )
    # Why trips went: the cancelled one, and the one he skipped (which can be brought back).
    removed = panel.locator("[data-travel-removed-text]")
    expect(removed).to_have_count(2)
    expect(panel.locator("[data-travel-removed='leg-gone'] [data-travel-removed-text]")).to_have_text(
        text["cancelled"]
    )
    skipped = panel.locator("[data-travel-removed='leg-bus-next']")
    expect(skipped.locator("[data-travel-removed-text]")).to_have_text(text["skipped"])
    expect(panel.locator("[data-travel-bring-back]")).to_have_count(1)
    with page.expect_response(
        lambda r: r.request.method == "POST" and r.url.endswith("/travel/legs/leg-bus-next/reset"),
        timeout=APP_REQUEST_TIMEOUT,
    ):
        skipped.locator("[data-travel-bring-back]").click()
    assert stub.calls[-1] == ("reset", "leg-bus-next", {})
    expect(trips).to_have_count(4, timeout=NORMAL_TIMEOUT)
    expect(skipped).to_have_count(0)
    # The trip there is back with its trip's length (35, from the way home): nothing asks for one
    # now ("Set how long" was said on it before, see _check_leg_sheet).
    brought = panel.locator("[data-travel-day-leg='leg-bus-next']")
    expect(brought).to_have_attribute("data-length-unset", "false")
    expect(panel.locator("[data-leg-set-length]")).to_have_count(0)
    # A trip opens its own sheet, in place of the day's.
    panel.locator("[data-travel-day-leg='leg-bus-next'] button").click()
    expect(page.locator("[data-item-sheet] [data-travel-leg]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(panel).to_be_hidden()
    assert "travelDay" not in page.url


@pytest.mark.parametrize("language", ["en", "he"])
def test_leg_views_render_from_stubbed_api(
    page: Page, base_url: str, api_base_url: str, fresh_owner, language: str
):
    text = TEXT[language]
    # React says so in the console when two siblings share a key (the shell's sheets once did).
    problems: list = []
    page.on(
        "console",
        lambda message: problems.append(message.text)
        if message.type in ("error", "warning") and "same key" in message.text
        else None,
    )
    stub, _, _ = _open_stubbed(page, base_url, api_base_url, fresh_owner, language)
    _check_calendar(page, text)
    _check_clock(page, text)
    _check_agenda(page, text)
    _check_timeline(page, text)
    _check_leg_sheet(page, stub, text)
    _check_day_panel(page, stub, text)
    assert problems == [], problems
