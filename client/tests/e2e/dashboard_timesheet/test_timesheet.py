"""
The Timesheet view (overnight PR-C): a topic's painted time on a week grid, with its open to-dos
beside it ("To schedule"), dragged onto the week to plan them.

Each test owns a fresh workspace on Asia/Jerusalem (deleted after it) with a Work page from the
template, a Timesheet view added to it through the API (`add_view`, type `timesheet`), a Work area
today from 09:00 to 13:00 and two Work to-dos. It then:

1. drags the first to-do into the area, onto 10:00 today: a chip at that time (inside the area's
   band) and the stored plan `<today>T10:00`, the workspace's wall time (`overlay.plannedAt`,
   read back through the API);
2. unschedules it from the panel: the chip goes, the plan is cleared, the to-do is unplanned again.

Once at desktop size with the mouse, in English; once on the owner's 13-inch iPad (landscape and
portrait, dark, Hebrew, touch: press and hold, then drag), where the panel sits beside the week in
landscape and above it in portrait.
"""
import pytest
import requests
from playwright.sync_api import Locator, Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard, list_dashboards
from tests.helpers.ipad_week import IPAD_LANDSCAPE, IPAD_PORTRAIT, box, ipad_context
from tests.helpers.items import create_local_item
from tests.helpers.scheduled import create_time_block, zoned_iso
from tests.helpers.workspaces import open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT

ZONE = "Asia/Jerusalem"
AREA = "TLVTech"
FIRST = "Write the release notes"
SECOND = "Review the pull request"
#: Where the first to-do is dropped: inside the area (09:00-13:00), on a quarter hour.
DROP_TIME = "10:00"


def _today(page: Page) -> str:
    """Today in the workspace's zone (`YYYY-MM-DD`), from the browser's zone data."""
    return page.evaluate(
        """(zone) => new Intl.DateTimeFormat('en-CA', {
            timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())""",
        ZONE,
    )


def _seed(page: Page, api_base_url: str, fresh_owner) -> dict:
    """The Work page with its Timesheet view, today's area and the two to-dos."""
    user, workspace = fresh_owner
    wid = workspace["id"]
    work = topic_id(api_base_url, user, wid, "work")
    create_dashboard(api_base_url, user, wid, template="work", scope={"topicId": work})
    summary = list_dashboards(api_base_url, user, wid, "work", "topic")[0]
    dashboard = get_dashboard(api_base_url, user, wid, summary["id"])
    apply_ops(
        api_base_url,
        user,
        wid,
        dashboard["id"],
        dashboard["version"],
        [{"op": "add_view", "type": "timesheet"}],
    )
    dashboard = get_dashboard(api_base_url, user, wid, summary["id"])
    view = next(view for view in dashboard["views"] if view["type"] == "timesheet")
    block = next(block for block in dashboard["blocks"] if block["id"] == view["blockIds"][0])
    assert block["type"] == "timesheet"
    # On a topic page the view reads that topic.
    assert block["query"]["where"]["rules"][0] == {
        "field": "topic",
        "operator": "=",
        "value": "$page.topic",
    }

    page.goto("about:blank")
    today = _today(page)
    create_time_block(
        api_base_url,
        user,
        wid,
        title=AREA,
        layer="area",
        topicId=work,
        startAt=zoned_iso(page, today, "09:00", ZONE),
        endAt=zoned_iso(page, today, "13:00", ZONE),
    )
    first = create_local_item(api_base_url, user, wid, FIRST, topic="work")
    second = create_local_item(api_base_url, user, wid, SECOND, topic="work")
    return {
        "user": user,
        "wid": wid,
        "view": view["id"],
        "today": today,
        "first": first["id"],
        "second": second["id"],
    }


def _planned_at(api_base_url: str, seeded: dict, item_id: str):
    """The item's stored plan, read through the API."""
    response = requests.get(
        f"{api_base_url}/private/workspaces/{seeded['wid']}/items/{item_id}",
        headers={"Authorization": f"Bearer {seeded['user'].id_token}"},
        timeout=15,
    )
    assert response.status_code == 200, response.text[:200]
    return response.json()["data"]["overlay"].get("plannedAt")


def _is_overlay_write(response) -> bool:
    return response.url.endswith("/overlay") and response.request.method == "PATCH"


def _open(page: Page, base_url: str, seeded: dict, lang: str) -> Locator:
    """The Work page on its Timesheet view; returns the week grid once the area and to-dos show."""
    open_as(page, base_url, seeded["user"], f"/{lang}/t/work?view={seeded['view']}")
    expect(page.locator("[data-rigid-view='timesheet']")).to_be_visible(timeout=LONG_TIMEOUT)
    expect(page.locator("[data-timesheet-todo]")).to_have_count(2, timeout=LONG_TIMEOUT)
    grid = page.locator("[data-timesheet-grid]")
    expect(grid.locator("[data-area-tag]", has_text=AREA).first).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(grid.locator(".fc-bg-event[data-role='area']").first).to_be_attached()
    return grid


def _drop_point(grid: Locator, day: str) -> tuple:
    """The middle of `day`'s column, in the first quarter of DROP_TIME's half-hour row."""
    lane = grid.locator(f".fc-timegrid-slot-lane[data-time='{DROP_TIME}:00']")
    lane.scroll_into_view_if_needed()
    column = box(grid.locator(f".fc-timegrid-col[data-date='{day}']"))
    row = box(lane)
    return column["x"] + column["width"] / 2, row["y"] + row["height"] / 4


def _todo(page: Page, item_id: str) -> Locator:
    return page.locator(f"[data-timesheet-todo][data-todo-id='{item_id}']")


def _chip(grid: Locator, item_id: str) -> Locator:
    return grid.locator(f".fc-event[data-role='planned'][data-item-id='{item_id}']")


def _mouse_drag(page: Page, source: Locator, x: float, y: float) -> None:
    start = box(source)
    sx, sy = start["x"] + start["width"] / 2, start["y"] + start["height"] / 2
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx + 12, sy + 12, steps=3)
    page.mouse.move(x, y, steps=15)
    page.mouse.up()


def _touch_drag(page: Page, source: Locator, x: float, y: float) -> None:
    """Press and hold (past the 300 ms long press), then drag with one finger (Chromium's CDP)."""
    start = box(source)
    sx, sy = start["x"] + start["width"] / 2, start["y"] + start["height"] / 2
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": sx, "y": sy}]})
    page.wait_for_timeout(600)
    steps = 15
    for step in range(1, steps + 1):
        point = {"x": sx + (x - sx) * step / steps, "y": sy + (y - sy) * step / steps}
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point]})
        page.wait_for_timeout(20)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()


def _plan_and_unschedule(page: Page, api_base_url: str, seeded: dict, grid: Locator, touch: bool):
    today = seeded["today"]
    first = seeded["first"]
    expect(_todo(page, first)).to_have_attribute("data-planned", "false")
    x, y = _drop_point(grid, today)
    with page.expect_response(_is_overlay_write, timeout=NORMAL_TIMEOUT) as written:
        (_touch_drag if touch else _mouse_drag)(page, _todo(page, first), x, y)
    assert written.value.status == 200, written.value.text()[:200]

    # The chip at 10:00 today, inside the area's band; the plan stored as the wall time.
    plan = f"{today}T{DROP_TIME}"
    chip = _chip(grid, first)
    expect(chip).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(chip).to_have_attribute("data-planned-at", plan)
    column = f".fc-timegrid-col[data-date='{today}']"
    expect(grid.locator(f"{column} .fc-event[data-role='planned'][data-item-id='{first}']")).to_have_count(1)
    band = box(grid.locator(f"{column} .fc-bg-event[data-role='area']"))
    drawn = box(chip)
    assert band["y"] - 1 <= drawn["y"] and drawn["y"] + drawn["height"] <= band["y"] + band["height"] + 1
    assert _planned_at(api_base_url, seeded, first) == plan
    # The panel lists it with the planned to-dos now; the other stays unplanned.
    expect(_todo(page, first)).to_have_attribute("data-planned", "true")
    expect(page.locator(f"[data-timesheet-group='planned'] [data-todo-id='{first}']")).to_have_count(1)
    expect(_todo(page, seeded["second"])).to_have_attribute("data-planned", "false")

    # Unschedule from the panel: the chip goes and the plan is cleared.
    unschedule = page.locator(f"[data-timesheet-unschedule='{first}']")
    with page.expect_response(_is_overlay_write, timeout=NORMAL_TIMEOUT) as cleared:
        if touch:
            unschedule.tap()
        else:
            unschedule.click()
    assert cleared.value.status == 200, cleared.value.text()[:200]
    expect(_chip(grid, first)).to_have_count(0, timeout=NORMAL_TIMEOUT)
    expect(_todo(page, first)).to_have_attribute("data-planned", "false")
    assert _planned_at(api_base_url, seeded, first) is None


def test_desktop_drag_a_todo_into_the_area_then_unschedule(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    page.set_viewport_size(DESKTOP_VIEWPORT)
    seeded = _seed(page, api_base_url, fresh_owner)
    grid = _open(page, base_url, seeded, "en")
    # Wide: the panel sits beside the week.
    panel = box(page.locator("[data-timesheet-panel]"))
    week = box(grid)
    assert panel["x"] + panel["width"] <= week["x"] + 1 or week["x"] + week["width"] <= panel["x"] + 1
    expect(page.get_by_role("heading", name="To schedule")).to_be_visible()
    _plan_and_unschedule(page, api_base_url, seeded, grid, touch=False)


@pytest.fixture(params=[IPAD_LANDSCAPE, IPAD_PORTRAIT], ids=["landscape", "portrait"])
def ipad(request, browser, browser_context_args):
    context = ipad_context(browser, browser_context_args, request.param)
    page = context.new_page()
    yield page, request.param
    context.close()


def test_ipad_press_hold_and_drag_then_unschedule(ipad, base_url: str, api_base_url: str, fresh_owner):
    page, viewport = ipad
    seeded = _seed(page, api_base_url, fresh_owner)
    grid = _open(page, base_url, seeded, "he")
    assert page.evaluate("() => document.documentElement.classList.contains('dark')")
    panel = box(page.locator("[data-timesheet-panel]"))
    week = box(grid)
    if viewport == IPAD_PORTRAIT:
        # Upright: the panel is a strip above the week, folding away under its heading.
        assert panel["y"] + panel["height"] <= week["y"] + 1
        expect(page.locator("[data-timesheet-panel-toggle]")).to_have_attribute("aria-expanded", "true")
    else:
        # Landscape: beside it (on the right, the start side in Hebrew).
        assert week["x"] + week["width"] <= panel["x"] + 1
    _plan_and_unschedule(page, api_base_url, seeded, grid, touch=True)
    # No horizontal overflow at the iPad's width.
    assert page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
