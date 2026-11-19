"""
The week calendar on the owner's 13-inch iPad (2026-11-19, tests/helpers/ipad_week.py), landscape
and portrait, dark, in Hebrew:

- A chip shows no time of day. Its icon is at the start (the right) and, when the chip is tall
  enough, on a line of its own above the title, which wraps instead of being cut to one letter. A
  15-minute chip has the icon and the title on one line. The time is in its name.
- Events that only touch are not overlapping: both keep the day's full width, a 10-minute one
  included (drawn at its true height). Overlapping events sit side by side, none drawn over
  another; so do two events at the same times.
- A chip too short for a line (the 10 minutes) shows its icon only, its title and time in its
  name, with a hit area of at least 24px reaching only into free time.
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
    BREAK,
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
    show_seeded_week,
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
    show_seeded_week(calendar)
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
    # Wider than the chip on one line (measured, as the column's width varies): it wraps.
    natural = title.evaluate(
        """(el) => {
            const probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
            probe.style.font = getComputedStyle(el).font;
            probe.textContent = el.textContent;
            document.body.append(probe);
            const width = probe.getBoundingClientRect().width;
            probe.remove();
            return { width, room: el.clientWidth };
        }"""
    )
    lines = 2 if natural["width"] > natural["room"] + 1 else 1
    assert title_box["height"] >= lines * 13 - 1, f"the title is not on {lines} line(s): {natural}"
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

    # Ten minutes that end when the lecture starts: drawn at their true height, both full width.
    short = _chip(calendar, days["thursday"], BREAK)
    expect(short.locator("[data-chip-layout='tiny']")).to_have_count(1)
    short_box = box(short)
    intro = box(_chip(calendar, days["thursday"], INTRO))
    assert short_box["width"] >= 0.9 * column["width"], f"the 10 minutes are squeezed: {short_box}"
    assert intro["width"] >= 0.9 * column["width"], f"the lecture after them is squeezed: {intro}"
    assert short_box["y"] + short_box["height"] <= intro["y"] + 1, "the 10 minutes run into the lecture"

    # The bus there arrives when the first lecture starts: it only touches it.
    leg = box(calendar.locator(f".fc-timegrid-col[data-date='{days['thursday']}'] .fc-event.tc-travel"))
    discrete = box(_chip(calendar, days["thursday"], DISCRETE))
    assert leg["y"] + leg["height"] <= discrete["y"] + 1
    assert discrete["width"] >= 0.9 * column["width"], "the lecture after the bus is squeezed"


def test_narrow_inline_chip_drops_its_icon_for_the_title(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    """The quarter hour in a half-width lane (Thursday's meeting beside the lecture) is under 64px:
    its icon goes and the title gets the room (at least three characters wide, not "A...")."""
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    narrow = _chip(calendar, days["thursday"], MEETING)
    expect(narrow.locator("[data-chip-layout='inline']")).to_have_count(1)
    assert box(narrow)["width"] < 64, f"the lane is not narrow: {box(narrow)}"
    expect(narrow.locator("[data-source-icon] svg").first).not_to_be_visible()
    title = narrow.locator("[data-chip-title]")
    room = title.evaluate(
        """(el) => {
            const probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
            probe.style.font = getComputedStyle(el).font;
            probe.textContent = el.textContent.slice(0, 3);
            document.body.append(probe);
            const three = probe.getBoundingClientRect().width;
            probe.remove();
            return { three, width: el.clientWidth };
        }"""
    )
    assert room["width"] >= room["three"] - 1, f"the title has no room for 3 characters: {room}"
    expect(narrow).to_have_attribute("aria-label", re.compile(rf"^{MEETING}"))
    expect(narrow).to_have_attribute("title", re.compile(rf"^{MEETING}"))
    # A full-width quarter hour keeps its icon.
    wide = _chip(calendar, days["monday"], MEETING)
    expect(wide.locator("[data-source-icon] svg").first).to_be_visible()


def test_tiny_chip_is_its_icon_with_a_hit_area_in_free_time(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    """Ten minutes before a lecture: too short for a line, so the icon only (the title and time in
    its name); its hit area reaches up into the free time before it, never into the lecture."""
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    short = _chip(calendar, days["thursday"], BREAK)
    expect(short.locator("[data-chip-layout='tiny']")).to_have_count(1)
    expect(short.locator("[data-source-icon] svg").first).to_be_visible()
    expect(short.locator("[data-chip-title]")).to_have_class(re.compile(r"\bsr-only\b"))
    expect(short).to_have_attribute("aria-label", re.compile(rf"^{BREAK}, .*12:40.*12:50"))
    expect(short).to_have_attribute("title", re.compile(rf"^{BREAK}, "))

    short.scroll_into_view_if_needed()
    chip, target = box(short), box(short.locator("[data-chip-tap]"))
    intro = box(_chip(calendar, days["thursday"], INTRO))
    assert round(target["height"], 2) >= 24, f"the hit area is under 24px: {target}"
    assert target["y"] < chip["y"] - 5, "the hit area does not reach into the free time above"
    assert target["y"] + target["height"] <= intro["y"] + 1, "the hit area covers the lecture"

    # A tap in the free time just above the chip opens it.
    page.mouse.click(target["x"] + target["width"] / 2, target["y"] + 3)
    sheet = page.locator("[data-item-sheet]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.locator("[data-item-title]")).to_have_text(BREAK)


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
