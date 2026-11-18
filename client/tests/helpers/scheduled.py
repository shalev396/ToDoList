"""
Time blocks and areas in E2E tests: the New sheet's kinds and the block form, driven through the UI.

The form: client/src/features/items/create/TimeBlockForm.tsx (start, end and length: any two set
the third). Routes: server/src/routes/private/timeBlocks.ts.
"""
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
