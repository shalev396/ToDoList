"""
The week calendar on the owner's 13-inch iPad (2026-11-19, tests/helpers/ipad_week.py), landscape
and portrait, dark, in Hebrew:

- A chip shows no time of day. Its icon is at the start (the right) and, when the chip is tall
  enough, on a line of its own above the title, which wraps instead of being cut to one letter. A
  15-minute chip has the icon and the title on one line. The time is in its name.
- Events that only touch are not overlapping: both keep the day's full width. Overlapping events
  sit side by side, none drawn over another; so do two events at the same times.
- An area takes no width from the events in it; its name is a tag in the day's header, which opens
  it.

Each test owns a fresh workspace (deleted after it) on Asia/Jerusalem.
"""
import re

import pytest
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.ipad_week import (
    AREA,
    CALCULUS,
    DISCRETE,
    INTRO,
    IPAD_LANDSCAPE,
    IPAD_PORTRAIT,
    MEETING,
    SAME_A,
    SAME_B,
    box,
    ipad_context,
    seed_week,
    summary_dashboard,
)
from tests.helpers.workspaces import open_as

TIME_OF_DAY = re.compile(r"\d{1,2}:\d{2}")


@pytest.fixture(params=[IPAD_LANDSCAPE, IPAD_PORTRAIT], ids=["landscape", "portrait"])
def ipad(request, browser, browser_context_args):
    context = ipad_context(browser, browser_context_args, request.param)
    page = context.new_page()
    yield page
    context.close()


def _open_week(page: Page, base_url: str, api_base_url: str, fresh_owner) -> tuple:
    user, workspace = fresh_owner
    summary_dashboard(api_base_url, user, workspace["id"])
    page.goto("about:blank")
    days = seed_week(page, api_base_url, user, workspace["id"])
    open_as(page, base_url, user, "/he/dashboard")
    calendar = page.locator("[data-calendar-view='week']")
    expect(calendar).to_be_visible(timeout=NORMAL_TIMEOUT)
    calendar.scroll_into_view_if_needed()
    expect(calendar.locator(".fc-timegrid-event", has_text=INTRO)).to_have_count(
        2, timeout=NORMAL_TIMEOUT
    )
    return calendar, days


def _chip(calendar, day: str, title: str):
    return calendar.locator(f".fc-timegrid-col[data-date='{day}'] .fc-timegrid-event", has_text=title)


def _column(calendar, day: str) -> dict:
    return box(calendar.locator(f".fc-timegrid-col[data-date='{day}'] .fc-timegrid-col-events").first)


def _apart(a: dict, b: dict) -> bool:
    """Two boxes that share no area (a pixel's rounding allowed)."""
    return (
        a["x"] + a["width"] <= b["x"] + 1
        or b["x"] + b["width"] <= a["x"] + 1
        or a["y"] + a["height"] <= b["y"] + 1
        or b["y"] + b["height"] <= a["y"] + 1
    )


def test_chip_is_icon_then_title_without_a_time(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)

    for chip in calendar.locator(".fc-timegrid-event").all():
        assert not TIME_OF_DAY.search(chip.inner_text()), f"a chip shows a time: {chip.inner_text()!r}"

    # A lecture: the icon on the first line, at the start (the right); the title below it, whole.
    lecture = _chip(calendar, days["thursday"], INTRO)
    expect(lecture.locator("[data-chip-layout='stacked']")).to_have_count(1)
    title = lecture.locator("[data-chip-title]")
    expect(title).to_have_text(INTRO)
    icon = lecture.locator("[data-source-icon] svg").first
    chip_box, icon_box, title_box = box(lecture), box(icon), box(title)
    assert icon_box["y"] + icon_box["height"] <= title_box["y"] + 1, "the title is not below the icon"
    assert icon_box["x"] + icon_box["width"] >= chip_box["x"] + chip_box["width"] - 8, (
        "the icon is not at the start (right) of the chip"
    )
    shown = title.evaluate(
        "(el) => ({ h: el.scrollHeight - el.clientHeight, w: el.scrollWidth - el.clientWidth })"
    )
    assert shown["h"] <= 1 and shown["w"] <= 1, f"the title is cut: {shown}"
    assert title_box["height"] >= 2 * 13 - 1, "a long title wraps onto a second line"
    # The time is in its name (and tooltip), kept in order inside Hebrew.
    expect(lecture).to_have_attribute("aria-label", re.compile(r"12:50.*14:30"))
    expect(lecture).to_have_attribute("title", re.compile(r"12:50.*14:30"))

    # A quarter hour: the icon and the title on one line.
    meeting = _chip(calendar, days["monday"], MEETING)
    expect(meeting.locator("[data-chip-layout='inline']")).to_have_count(1)
    icon_box = box(meeting.locator("[data-source-icon] svg").first)
    title_box = box(meeting.locator("[data-chip-title]"))
    assert abs(
        (icon_box["y"] + icon_box["height"] / 2) - (title_box["y"] + title_box["height"] / 2)
    ) <= 3, "the icon and the title are not on one line"
    assert title_box["x"] < icon_box["x"], "in Hebrew the icon comes first, on the right"

    # The trip: its mode's icon, never a source's.
    leg = calendar.locator(f".fc-timegrid-col[data-date='{days['thursday']}'] .fc-event.tc-travel")
    expect(leg).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(leg.locator("svg[data-leg-mode='transit']")).to_have_count(1)
    assert not TIME_OF_DAY.search(leg.inner_text())


def test_touching_events_keep_full_width_and_overlapping_sit_side_by_side(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)

    # Monday: the meeting ends when the lecture starts. Both take the whole day; one above the other.
    column = _column(calendar, days["monday"])
    meeting = box(_chip(calendar, days["monday"], MEETING))
    lecture = box(_chip(calendar, days["monday"], INTRO))
    for name, event in (("meeting", meeting), ("lecture", lecture)):
        assert event["width"] >= 0.9 * column["width"], f"the {name} is squeezed: {event}, {column}"
    assert meeting["y"] + meeting["height"] <= lecture["y"] + 1, "the meeting runs into the lecture"

    # Thursday: the meeting inside the 10:30 lecture sits beside it, not over it.
    column = _column(calendar, days["thursday"])
    inside = box(_chip(calendar, days["thursday"], MEETING))
    calculus = box(_chip(calendar, days["thursday"], CALCULUS))
    assert _apart(inside, calculus), f"the meeting is drawn over the lecture: {inside}, {calculus}"
    assert inside["width"] <= 0.6 * column["width"] and calculus["width"] <= 0.6 * column["width"]

    # Wednesday: two events at the same times, both seen, side by side.
    same_a = box(_chip(calendar, days["wednesday"], SAME_A))
    same_b = box(_chip(calendar, days["wednesday"], SAME_B))
    assert _apart(same_a, same_b), f"one event at the same time covers the other: {same_a}, {same_b}"
    assert same_a["width"] > 20 and same_b["width"] > 20

    # The bus there arrives when the first lecture starts: it only touches it.
    leg = box(calendar.locator(f".fc-timegrid-col[data-date='{days['thursday']}'] .fc-event.tc-travel"))
    discrete = box(_chip(calendar, days["thursday"], DISCRETE))
    assert leg["y"] + leg["height"] <= discrete["y"] + 1
    assert discrete["width"] >= 0.9 * column["width"], "the lecture after the bus is squeezed"


def test_area_takes_no_width_and_its_header_tag_opens_it(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)

    # The band is there, behind; a lecture in it is as wide as one on a day with no area.
    expect(
        calendar.locator(f".fc-timegrid-col[data-date='{days['thursday']}'] .fc-bg-event.tc-area")
    ).to_have_count(1)
    in_area = box(_chip(calendar, days["thursday"], INTRO))
    no_area = box(_chip(calendar, days["monday"], INTRO))
    assert abs(in_area["width"] - no_area["width"]) <= 2, f"the area squeezes: {in_area}, {no_area}"

    tag = calendar.locator(f".fc-col-header-cell[data-date='{days['thursday']}'] [data-area-tag]")
    expect(tag).to_have_count(1)
    expect(tag).to_be_visible()
    expect(tag).to_have_text(AREA)
    expect(tag).to_have_attribute("aria-label", re.compile(rf"^אזור: {AREA}, .*08:30.*15:00"))
    tag.click()
    sheet = page.locator("[data-item-sheet]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.locator("[data-item-title]")).to_have_text(AREA)
