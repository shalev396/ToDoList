"""
The calendar's "Starts at" hour: the week view opens with that hour's row at the top of the
scroll region (7 by default, midnight included), the choice is saved in the block, kept across
weeks, reloads and a Month round trip, and the region still scrolls freely.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

REGION = "[data-calendar-view] [role='region']"


def _open(page: Page, base_url: str, api_base_url: str, fresh_owner) -> None:
    user, workspace = fresh_owner
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.locator(REGION)).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator(".fc-timeGridWeek-view")).to_be_visible(timeout=NORMAL_TIMEOUT)


def _offset(page: Page, time: str) -> float:
    """How far the hour's row sits below the scroll region's top, minus the sticky header."""
    return page.evaluate(
        """(time) => {
            const box = document.querySelector("[data-calendar-view] [role='region']");
            const slot = box.querySelector(`.fc-timegrid-slot-lane[data-time="${time}"]`);
            const head = box.querySelector('.fc-scrollgrid-section-header');
            return slot.getBoundingClientRect().top - box.getBoundingClientRect().top
                - (head ? head.getBoundingClientRect().height : 0);
        }""",
        time,
    )


def _scroll_top(page: Page) -> float:
    return page.locator(REGION).evaluate("(el) => el.scrollTop")


def _choose(page: Page, label: str) -> None:
    page.get_by_role("combobox", name="Starts at").click()
    page.get_by_role("option", name=label).click()


def _expect_offset(page: Page, time: str) -> None:
    page.wait_for_function(
        """(time) => {
            const box = document.querySelector("[data-calendar-view] [role='region']");
            const slot = box && box.querySelector(`.fc-timegrid-slot-lane[data-time="${time}"]`);
            if (!slot) return false;
            const head = box.querySelector('.fc-scrollgrid-section-header');
            const off = slot.getBoundingClientRect().top - box.getBoundingClientRect().top
                - (head ? head.getBoundingClientRect().height : 0);
            return Math.abs(off) <= 2;
        }""",
        arg=time,
        timeout=NORMAL_TIMEOUT,
    )


def test_week_opens_at_seven_by_default(page: Page, base_url: str, api_base_url: str, fresh_owner):
    _open(page, base_url, api_base_url, fresh_owner)
    _expect_offset(page, "07:00:00")
    assert abs(_offset(page, "07:00:00")) <= 2


def test_start_hour_is_saved_and_kept_across_weeks(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    _open(page, base_url, api_base_url, fresh_owner)

    with page.expect_response(
        lambda r: r.url.endswith("/ops") and r.request.method == "POST"
    ) as saved:
        _choose(page, "12:00")
    assert saved.value.status == 200
    _expect_offset(page, "12:00:00")

    page.get_by_role("button", name="Next").click()
    _expect_offset(page, "12:00:00")

    before = _scroll_top(page)
    page.locator(REGION).hover()
    page.mouse.wheel(0, -200)
    page.wait_for_function(
        "(b) => document.querySelector(\"[data-calendar-view] [role='region']\").scrollTop < b",
        arg=before,
        timeout=NORMAL_TIMEOUT,
    )

    page.reload()
    expect(page.locator(".fc-timeGridWeek-view")).to_be_visible(timeout=NORMAL_TIMEOUT)
    _expect_offset(page, "12:00:00")

    group = page.get_by_role("group", name="Calendar view")
    group.get_by_role("radio", name="Month").click()
    expect(page.locator(".fc-dayGridMonth-view")).to_be_visible()
    expect(page.get_by_role("combobox", name="Starts at")).to_have_count(0)
    group.get_by_role("radio", name="Week").click()
    expect(page.locator(".fc-timeGridWeek-view")).to_be_visible()
    _expect_offset(page, "12:00:00")
    assert errors == []


def test_midnight(page: Page, base_url: str, api_base_url: str, fresh_owner):
    _open(page, base_url, api_base_url, fresh_owner)
    with page.expect_response(
        lambda r: r.url.endswith("/ops") and r.request.method == "POST"
    ) as saved:
        _choose(page, "00:00")
    assert saved.value.status == 200
    page.reload()
    expect(page.locator(REGION)).to_have_attribute("data-start-hour", "0", timeout=NORMAL_TIMEOUT)
    _expect_offset(page, "00:00:00")
    assert _scroll_top(page) == 0
