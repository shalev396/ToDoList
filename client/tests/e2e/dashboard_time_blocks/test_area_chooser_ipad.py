"""
Tapping painted time in the week calendar (the owner's 13-inch iPad, tests/helpers/ipad_week.py,
landscape and portrait, dark, Hebrew): inside an area a small chooser appears next to the tap, with
"New to-do here" and one "Open area: ..." row per area under it. Outside an area the tap opens the
New sheet at once, as it always did.

- "Open area" opens the area's item sheet; "New to-do here" opens the New sheet at the tapped time.
- The rows are at least 44px tall, the menu never covers the tap, and it does not flicker (still
  there half a second after the tap, with the tap's synthesized click already past).
- Esc closes it and so does a tap outside it; the arrow keys move between rows.

Each test owns a fresh workspace (deleted after it) on Asia/Jerusalem. The seeded week is next
week: Thursday has the area from 08:30 to 15:00, and free time in it at 10:00 (between a lecture
that ends then and one that starts at 10:30). Tuesday has nothing at all.
"""
import pytest
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.ipad_week import (
    AREA,
    IPAD_LANDSCAPE,
    IPAD_PORTRAIT,
    box,
    ipad_context,
    seed_week,
    show_seeded_week,
    summary_dashboard,
)
from tests.helpers.scheduled import add_days, this_sunday
from tests.helpers.workspaces import open_as

#: Settling time before looking again: longer than the touch's synthesized click.
SETTLE_MS = 700


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
    # Tuesday of the seeded week: nothing is on it.
    days["tuesday"] = add_days(add_days(this_sunday(page), 7), 2)
    open_as(page, base_url, user, "/he/dashboard")
    calendar = page.locator("[data-calendar-view='week']")
    expect(calendar).to_be_visible(timeout=NORMAL_TIMEOUT)
    show_seeded_week(calendar)
    calendar.scroll_into_view_if_needed()
    expect(calendar.locator(".fc-bg-event.tc-area")).to_have_count(1, timeout=NORMAL_TIMEOUT)
    return calendar, days


def _tap_slot(page: Page, calendar, day: str, time: str) -> tuple:
    """Taps the middle of the slot starting at `time` ("10:00:00") in the day's column."""
    lane = calendar.locator(f".fc-timegrid-slot-lane[data-time='{time}']").first
    lane.evaluate("(el) => el.scrollIntoView({ block: 'center' })")
    column = box(calendar.locator(f".fc-timegrid-col[data-date='{day}']").first)
    row = box(lane)
    x, y = column["x"] + column["width"] / 2, row["y"] + row["height"] / 2
    page.touchscreen.tap(x, y)
    return x, y


def _chooser(page: Page):
    return page.locator("[data-area-chooser]")


def test_tap_inside_an_area_asks_what_to_do(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    x, y = _tap_slot(page, calendar, days["thursday"], "10:00:00")

    chooser = _chooser(page)
    expect(chooser).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator("[data-new-todo]")).to_have_count(0)
    new_row = chooser.locator("[data-chooser-new]")
    area_rows = chooser.locator("[data-chooser-area]")
    expect(new_row).to_have_count(1)
    expect(area_rows).to_have_count(1)
    expect(area_rows).to_contain_text(AREA)

    # Big enough for a finger, and not under it.
    for row in (new_row, area_rows.first):
        assert box(row)["height"] >= 44, f"a row is too small: {box(row)}"
    menu = box(chooser)
    assert not (
        menu["x"] <= x <= menu["x"] + menu["width"] and menu["y"] <= y <= menu["y"] + menu["height"]
    ), f"the menu is under the tap: {menu} at {x},{y}"
    assert menu["x"] >= 0 and menu["x"] + menu["width"] <= page.viewport_size["width"]
    assert menu["y"] >= 0 and menu["y"] + menu["height"] <= page.viewport_size["height"]

    # It does not flicker: still open once the touch's synthesized click is long past.
    page.wait_for_timeout(SETTLE_MS)
    expect(chooser).to_be_visible()
    expect(chooser).to_have_count(1)


def test_open_area_opens_its_sheet(ipad: Page, base_url: str, api_base_url: str, fresh_owner):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    _tap_slot(page, calendar, days["thursday"], "10:00:00")
    chooser = _chooser(page)
    expect(chooser).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.wait_for_timeout(SETTLE_MS)

    chooser.locator("[data-chooser-area]").first.tap()
    sheet = page.locator("[data-item-sheet]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.locator("[data-item-title]")).to_have_text(AREA)
    expect(_chooser(page)).to_have_count(0)


def test_new_todo_here_opens_create_at_that_time(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    _tap_slot(page, calendar, days["thursday"], "10:00:00")
    chooser = _chooser(page)
    expect(chooser).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.wait_for_timeout(SETTLE_MS)

    chooser.locator("[data-chooser-new]").tap()
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.get_by_label("שעת התחלה", exact=True)).to_have_value("10:00")
    expect(sheet.get_by_label("תאריך התחלה", exact=True)).to_have_value(days["thursday"])
    expect(_chooser(page)).to_have_count(0)


def test_tap_outside_an_area_opens_create_at_once(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)

    # Thursday after the area ends (15:00), and a day with no area at all.
    _tap_slot(page, calendar, days["thursday"], "16:00:00")
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.get_by_label("שעת התחלה", exact=True)).to_have_value("16:00")
    expect(_chooser(page)).to_have_count(0)


def test_tap_on_a_free_day_opens_create_at_once(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    _tap_slot(page, calendar, days["tuesday"], "11:00:00")
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.get_by_label("שעת התחלה", exact=True)).to_have_value("11:00")
    expect(_chooser(page)).to_have_count(0)


def test_escape_and_a_tap_outside_close_it_and_the_arrows_move(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    _tap_slot(page, calendar, days["thursday"], "10:00:00")
    chooser = _chooser(page)
    expect(chooser).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.wait_for_timeout(SETTLE_MS)

    # Focus is inside, on the first row; the arrows move between rows (and wrap).
    new_row = chooser.locator("[data-chooser-new]")
    area_row = chooser.locator("[data-chooser-area]").first
    expect(new_row).to_be_focused()
    page.keyboard.press("ArrowDown")
    expect(area_row).to_be_focused()
    page.keyboard.press("ArrowDown")
    expect(new_row).to_be_focused()
    page.keyboard.press("ArrowUp")
    expect(area_row).to_be_focused()

    page.keyboard.press("Escape")
    expect(_chooser(page)).to_have_count(0)

    # Again, and a tap outside it (the calendar's title) closes it.
    _tap_slot(page, calendar, days["thursday"], "10:00:00")
    expect(_chooser(page)).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.wait_for_timeout(SETTLE_MS)
    title = box(calendar.locator("[data-calendar-title]"))
    page.touchscreen.tap(title["x"] + title["width"] / 2, title["y"] + title["height"] / 2)
    expect(_chooser(page)).to_have_count(0)
    expect(page.locator("[data-new-todo]")).to_have_count(0)


def test_enter_on_a_row_does_what_the_row_says(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad
    calendar, days = _open_week(page, base_url, api_base_url, fresh_owner)
    _tap_slot(page, calendar, days["thursday"], "10:00:00")
    expect(_chooser(page)).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.wait_for_timeout(SETTLE_MS)

    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    sheet = page.locator("[data-item-sheet]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.locator("[data-item-title]")).to_have_text(AREA)
