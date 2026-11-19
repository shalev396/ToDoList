"""
Blocks and areas in the time views (time-blocks design, "Areas"): an area is painted behind the
week's events with its title; a block is an arc and a Now line on the clock; the agenda lists the
blocks that start inside an area under it; a task view (a list) never lists blocks.

Each test owns a fresh workspace on Asia/Jerusalem (weeks start on Sunday) with the default
dashboard. A test that needs another block adds it by a dashboard op.
"""
import re
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard
from tests.helpers.scheduled import create_time_block, this_sunday, zoned_iso
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

AGENDA = "Agenda of blocks"
TASKS = "Tasks only"
TIME_QUERY = {"source": "items", "dateRange": "next_7d", "dateField": "startAt"}


def _open(page: Page, base_url: str, fresh_owner, ready: str) -> None:
    user, _ = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.locator(ready)).to_be_visible(timeout=NORMAL_TIMEOUT)


def _add_blocks(api_base_url: str, fresh_owner, blocks: list) -> dict:
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    apply_ops(
        api_base_url,
        user,
        workspace["id"],
        dashboard["id"],
        dashboard["version"],
        [{"op": "add_block", "block": block} for block in blocks],
    )
    return dashboard


def test_area_draws_behind_events_in_calendar(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    sunday = this_sunday(page)
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        title="Studying",
        layer="area",
        startAt=zoned_iso(page, sunday, "13:00"),
        endAt=zoned_iso(page, sunday, "17:00"),
    )
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        subject="Calculus",
        startAt=zoned_iso(page, sunday, "14:00"),
        endAt=zoned_iso(page, sunday, "15:00"),
    )
    page.reload()
    calendar = page.locator("[data-calendar-view]")
    area = calendar.locator(".fc-bg-event", has_text="Studying")
    expect(area).to_be_attached(timeout=NORMAL_TIMEOUT)
    # The block is an event on top; the area is not one (no click, behind).
    expect(calendar.locator(".fc-event:not(.fc-bg-event)", has_text="Calculus")).to_have_count(1)
    expect(calendar.locator(".fc-event:not(.fc-bg-event)", has_text="Studying")).to_have_count(0)


def test_clock_summary_names_the_block(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    clock = next(block for block in dashboard["blocks"] if block["type"] == "clock")
    # The default clock reads events only: take its filter off so blocks reach it.
    query = {key: value for key, value in clock["query"].items() if key != "where"}
    apply_ops(
        api_base_url,
        user,
        workspace["id"],
        dashboard["id"],
        dashboard["version"],
        [{"op": "update_block", "blockId": clock["id"], "patch": {"query": query}}],
    )
    now = datetime.now(timezone.utc)
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        title="Deep work",
        startAt=(now - timedelta(minutes=15)).isoformat(),
        endAt=(now + timedelta(minutes=45)).isoformat(),
    )
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    ring = page.get_by_role("img", name=re.compile(r"^Today, "))
    expect(ring).to_have_count(1, timeout=NORMAL_TIMEOUT)
    summary = page.get_by_role("article").filter(has=ring).locator("[aria-live='polite']")
    expect(summary).to_contain_text("Deep work")


def test_agenda_groups_blocks_under_area(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _add_blocks(
        api_base_url,
        fresh_owner,
        [{"type": "agenda", "title": AGENDA, "query": TIME_QUERY, "viz": {"kind": "agenda"}}],
    )
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    # Tomorrow, so the order against "now" never matters.
    tomorrow = page.evaluate(
        """() => {
            const day = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date(Date.now() + 24 * 3600_000));
            return day;
        }"""
    )
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        title="Studying",
        layer="area",
        startAt=zoned_iso(page, tomorrow, "13:00"),
        endAt=zoned_iso(page, tomorrow, "17:00"),
    )
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        title="Problem set",
        startAt=zoned_iso(page, tomorrow, "14:00"),
        endAt=zoned_iso(page, tomorrow, "15:00"),
    )
    page.reload()
    agenda = page.get_by_role("article", name=AGENDA, exact=True)
    area = agenda.locator("[data-agenda-area]", has_text="Studying")
    expect(area).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(area.get_by_text("Problem set")).to_be_visible()
    # The header opens the area's sheet.
    area.get_by_role("button", name=re.compile("Studying")).click()
    expect(page.locator("[data-item-sheet]")).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_blocks_hidden_from_list_block(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _add_blocks(
        api_base_url,
        fresh_owner,
        [
            {
                "type": "list",
                "title": TASKS,
                "query": {"source": "items", "limit": 20},
                "viz": {"kind": "list"},
            }
        ],
    )
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    sunday = this_sunday(page)
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        title="Reserved hour",
        startAt=zoned_iso(page, sunday, "14:00"),
        endAt=zoned_iso(page, sunday, "15:00"),
    )
    page.reload()
    # The week calendar shows the block; a task view does not.
    expect(page.locator(".fc-event", has_text="Reserved hour")).to_have_count(
        1, timeout=NORMAL_TIMEOUT
    )
    tasks = page.get_by_role("article", name=TASKS, exact=True)
    expect(tasks).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(tasks.get_by_text("Reserved hour")).to_have_count(0)
