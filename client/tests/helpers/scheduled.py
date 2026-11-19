"""
Time blocks and areas in E2E tests: the New sheet's kinds and the block form, driven through the UI,
and blocks seeded through the API (requests).

The form: client/src/features/items/create/TimeBlockForm.tsx (start, end and length: any two set
the third). The item sheet's block section: client/src/features/items/scheduled/. Routes:
server/src/routes/private/timeBlocks.ts.
"""
from datetime import date, timedelta
from typing import Any

import requests
from playwright.sync_api import Locator, Page, expect

from tests.config import NORMAL_TIMEOUT

# The kind labels, as the time-blocks design words them (scheduled.kinds).
KINDS = {
    "en": {
        "todo": "To-do (I’ll tick it off)",
        "block": "Time block (reserve the time)",
        "area": "Area (paint time for a part of life)",
    },
    "he": {
        "todo": "משימה (אסמן כשתסתיים)",
        "block": "בלוק זמן (שמירת הזמן)",
        "area": "אזור (צביעת זמן לתחום בחיים)",
    },
}


def open_new_sheet(page: Page) -> Locator:
    """Opens the New sheet from the sidebar's "New to-do" (desktop) and returns it."""
    page.locator("[data-new-todo-open]").first.click()
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    return sheet


def choose_kind(sheet: Locator, kind: str, language: str = "en") -> Locator:
    """Picks a kind at the top of the sheet; for a block or an area, returns its form."""
    sheet.get_by_role("radio", name=KINDS[language][kind], exact=True).click()
    form = sheet.locator(f"[data-time-block-form={kind}]") if kind != "todo" else sheet.locator("form")
    expect(form).to_be_visible()
    return form


def this_sunday(page: Page, time_zone: str = "Asia/Jerusalem") -> str:
    """The Sunday that starts this week in the zone (`YYYY-MM-DD`), from the browser's zone data
    (the test runner may have none). A new workspace's week starts on Sunday."""
    return page.evaluate(
        """(zone) => {
            const today = new Intl.DateTimeFormat('en-CA', {
                timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date());
            const [y, m, d] = today.split('-').map(Number);
            const day = new Date(Date.UTC(y, m - 1, d));
            day.setUTCDate(day.getUTCDate() - day.getUTCDay());
            return day.toISOString().slice(0, 10);
        }""",
        time_zone,
    )


def is_block_create(response) -> bool:
    """`POST …/time-blocks`, for page.expect_response."""
    return response.url.endswith("/time-blocks") and response.request.method == "POST"


def add_days(day: str, days: int) -> str:
    """`YYYY-MM-DD` moved `days` calendar days."""
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


def zoned_iso(page: Page, day: str, time: str, time_zone: str = "Asia/Jerusalem") -> str:
    """`HH:MM` on `day` on the zone's wall clock, as a UTC ISO instant (from the browser's zone
    data: the runner may have none)."""
    return page.evaluate(
        """([day, time, zone]) => {
            const [y, m, d] = day.split('-').map(Number);
            const [h, mi] = time.split(':').map(Number);
            const wall = Date.UTC(y, m - 1, d, h, mi);
            const offsetAt = (ms) => {
                const parts = Object.fromEntries(
                    new Intl.DateTimeFormat('en-US', {
                        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
                        day: '2-digit', hour: '2-digit', minute: '2-digit',
                    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
                );
                return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - ms;
            };
            const first = wall - offsetAt(wall);
            return new Date(wall - offsetAt(first)).toISOString();
        }""",
        [day, time, time_zone],
    )


def create_time_block(api_base_url: str, user, workspace_id: str, **fields: Any) -> dict:
    """POST …/time-blocks with `fields` as the body (`startAt`, `endAt`, `subject`, `title`,
    `layer`, `topicId`, `recurrence`). Returns the block (an ItemDetail)."""
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/time-blocks",
        json=fields,
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Creating a time block failed: {response.status_code} {response.text[:200]}")
    return response.json()["data"]


def is_block_edit(response) -> bool:
    """`PATCH …/time-blocks/:id`, for page.expect_response."""
    return "/time-blocks/" in response.url and response.request.method == "PATCH"


def is_block_skip(response) -> bool:
    """`POST …/time-blocks/:id/skip`, for page.expect_response."""
    return response.url.endswith("/skip") and response.request.method == "POST"


def drag_in_week(page: Page, calendar: Locator, day: str, start: str, end: str) -> None:
    """Drags down the week grid's `day` column from `start` to `end` (`HH:MM`, on the half hour;
    the end is exclusive, so the drag stops in the half hour before it), with the mouse."""
    hour, minute = map(int, end.split(":"))
    last = (hour * 60 + minute - 30) // 60, (hour * 60 + minute - 30) % 60
    first_lane = calendar.locator(f".fc-timegrid-slot-lane[data-time='{start}:00']")
    last_lane = calendar.locator(f".fc-timegrid-slot-lane[data-time='{last[0]:02d}:{last[1]:02d}:00']")
    last_lane.scroll_into_view_if_needed()
    first_lane.scroll_into_view_if_needed()
    column = calendar.locator(f".fc-timegrid-col[data-date='{day}']").bounding_box()
    top = first_lane.bounding_box()
    bottom = last_lane.bounding_box()
    assert column is not None and top is not None and bottom is not None, "the week grid is not shown"
    x = column["x"] + column["width"] / 2
    page.mouse.move(x, top["y"] + top["height"] / 2)
    page.mouse.down()
    page.mouse.move(x, (top["y"] + bottom["y"]) / 2 + top["height"] / 2, steps=5)
    page.mouse.move(x, bottom["y"] + bottom["height"] / 2, steps=5)
    page.mouse.up()
