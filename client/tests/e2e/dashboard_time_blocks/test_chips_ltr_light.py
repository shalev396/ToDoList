"""
Calendar chips in English (left to right), in the light theme, on a desktop: the week grid (a
lecture, a quarter-hour meeting, an all-day event in the all-day row) and the month grid. Every
chip shows its icon and its title, the icon first (on the left), the title not cut to a letter,
and no time of day (the time is in its name). The iPad, Hebrew and dark theme are
test_week_chips_ipad.py's.

Each test owns a fresh workspace (deleted after it) on Asia/Jerusalem with the default dashboard.
"""
import re

import pytest
import requests
from playwright.sync_api import Locator, Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.ipad_week import box
from tests.helpers.items import create_timed_todo
from tests.helpers.scheduled import add_days, this_sunday, zoned_iso
from tests.helpers.workspaces import open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT

LECTURE = "Introduction to Computer Science"
STANDUP = "Standup"
ALL_DAY = "Hackathon"
TIME_OF_DAY = re.compile(r"\d{1,2}:\d{2}")


def _seed(page: Page, api_base_url: str, fresh_owner) -> dict:
    user, workspace = fresh_owner
    wid = workspace["id"]
    create_dashboard(api_base_url, user, wid)
    page.goto("about:blank")
    monday = add_days(this_sunday(page), 1)
    tuesday = add_days(monday, 1)
    create_timed_todo(
        api_base_url, user, wid, LECTURE, zoned_iso(page, monday, "10:30"), zoned_iso(page, monday, "12:00")
    )
    create_timed_todo(
        api_base_url, user, wid, STANDUP, zoned_iso(page, monday, "09:00"), zoned_iso(page, monday, "09:15")
    )
    response = requests.post(
        f"{api_base_url}/private/workspaces/{wid}/items",
        json={
            "title": ALL_DAY,
            "topicId": topic_id(api_base_url, user, wid, "work"),
            "startAt": zoned_iso(page, tuesday, "00:00"),
            "endAt": zoned_iso(page, add_days(tuesday, 1), "00:00"),
            "allDay": True,
        },
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code < 300, response.text[:200]
    return {"monday": monday, "tuesday": tuesday}


def _check_chip(chip: Locator, title: str, layout: str) -> None:
    """Icon and title shown, the icon first (left), the title whole, no time of day."""
    expect(chip.locator(f"[data-chip-layout='{layout}']")).to_have_count(1)
    name = chip.locator("[data-chip-title]")
    expect(name).to_have_text(title)
    expect(name).to_be_visible()
    icon = chip.locator("[data-source-icon] svg").first
    expect(icon).to_be_visible()
    assert not TIME_OF_DAY.search(chip.inner_text()), f"a chip shows a time: {chip.inner_text()!r}"
    cut = name.evaluate(
        "(el) => ({ h: el.scrollHeight - el.clientHeight, w: el.scrollWidth - el.clientWidth })"
    )
    assert cut["h"] <= 1 and cut["w"] <= 1, f"{title!r} is cut: {cut}"
    icon_box, name_box = box(icon), box(name)
    if layout == "stacked":
        assert icon_box["y"] + icon_box["height"] <= name_box["y"] + 1, "the title is not below the icon"
        assert icon_box["x"] <= name_box["x"] + 2, "the icon is not at the start (left)"
    else:
        assert icon_box["x"] + icon_box["width"] <= name_box["x"] + 1, "the icon is not before the title"


@pytest.mark.parametrize("view", ["week", "month"])
def test_chips_in_english_and_light(page: Page, base_url: str, api_base_url: str, fresh_owner, view: str):
    user, _ = fresh_owner
    page.emulate_media(color_scheme="light")
    page.set_viewport_size(DESKTOP_VIEWPORT)
    _seed(page, api_base_url, fresh_owner)
    open_as(page, base_url, user, "/en/dashboard")
    calendar = page.locator("[data-calendar-view]")
    expect(calendar).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert not page.evaluate("() => document.documentElement.classList.contains('dark')")
    assert calendar.locator("[role=region]").get_attribute("dir") == "ltr"

    if view == "week":
        lecture = calendar.locator(".fc-timegrid-event", has_text=LECTURE)
        expect(lecture).to_have_count(1, timeout=NORMAL_TIMEOUT)
        _check_chip(lecture, LECTURE, "stacked")
        expect(lecture).to_have_attribute("aria-label", re.compile(r"10:30.*12:00"))
        _check_chip(calendar.locator(".fc-timegrid-event", has_text=STANDUP), STANDUP, "inline")
        # The all-day row: a one-line chip.
        all_day = calendar.locator(".fc-daygrid-event", has_text=ALL_DAY)
        expect(all_day).to_have_count(1, timeout=NORMAL_TIMEOUT)
        _check_chip(all_day, ALL_DAY, "inline")
        return

    with page.expect_response(lambda r: r.url.endswith("/ops") and r.request.method == "POST"):
        page.get_by_role("group", name="Calendar view").get_by_role("radio", name="Month").click()
    expect(calendar.locator(".fc-dayGridMonth-view")).to_be_visible(timeout=NORMAL_TIMEOUT)
    for title in (LECTURE, STANDUP, ALL_DAY):
        chip = calendar.locator(".fc-daygrid-event", has_text=title)
        expect(chip).to_have_count(1, timeout=NORMAL_TIMEOUT)
        if title == LECTURE:
            # A month cell is narrow: a long title may end in an ellipsis, but more than a letter shows.
            expect(chip.locator("[data-chip-layout='inline']")).to_have_count(1)
            assert not TIME_OF_DAY.search(chip.inner_text())
            assert box(chip.locator("[data-chip-title]"))["width"] >= 30, "the title is cut to a letter"
            continue
        _check_chip(chip, title, "inline")
