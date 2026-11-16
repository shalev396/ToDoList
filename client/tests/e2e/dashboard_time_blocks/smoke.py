"""
The time blocks: the calendar (Week by default, Month saved per block, an event opens the item
Sheet through ?item=) and the 24-hour clock (a role="img" ring with a text summary), with axe.

Every test owns a fresh workspace (deleted after it) on Asia/Jerusalem, with one local
to-do due in an hour: a due-only item, so the calendar shows it with a marker.
"""
import re
from datetime import datetime, timedelta, timezone

import requests
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.dashboards import create_dashboard
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

TODO_TITLE = "Submit the lab report"


def _seed_todo(api_base_url: str, user, workspace_id: str) -> None:
    due = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/items",
        json={"title": TODO_TITLE, "dueAt": due},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code < 300, response.text[:200]


def _open(page: Page, base_url: str, api_base_url: str, fresh_owner) -> None:
    user, workspace = fresh_owner
    create_dashboard(api_base_url, user, workspace["id"])
    _seed_todo(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)


def _view_toggle(page: Page, name: str):
    return page.get_by_role("group", name="Calendar view").get_by_role("radio", name=name)


def test_week_is_the_default_and_month_persists(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    _open(page, base_url, api_base_url, fresh_owner)
    expect(page.locator("[data-calendar-view]")).to_have_attribute("data-calendar-view", "week")
    expect(_view_toggle(page, "Week")).to_be_checked()
    expect(page.locator(".fc-timeGridWeek-view")).to_be_visible()

    with page.expect_response(
        lambda r: r.url.endswith("/ops") and r.request.method == "POST"
    ) as saved:
        _view_toggle(page, "Month").click()
    assert saved.value.status == 200
    expect(page.locator(".fc-dayGridMonth-view")).to_be_visible()

    page.reload()
    expect(page.locator("[data-calendar-view]")).to_have_attribute(
        "data-calendar-view", "month", timeout=NORMAL_TIMEOUT
    )
    expect(_view_toggle(page, "Month")).to_be_checked()


def test_due_only_item_has_a_marker_and_opens_the_sheet(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    _open(page, base_url, api_base_url, fresh_owner)
    event = page.locator(".fc-event", has_text=TODO_TITLE).first
    expect(event).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(event.locator("[data-due-marker]")).to_have_count(1)
    expect(event).to_have_attribute("aria-label", re.compile(r"^Due: Submit the lab report"))
    event.click()
    expect(page).to_have_url(re.compile(r"[?&]item="))


def test_clock_ring_has_a_text_summary(page: Page, base_url: str, api_base_url: str, fresh_owner):
    _open(page, base_url, api_base_url, fresh_owner)
    ring = page.get_by_role("img", name=re.compile(r"^Today, .*no events"))
    expect(ring).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_text("No events today")).to_be_visible()


def test_time_blocks_axe_clean(page: Page, base_url: str, api_base_url: str, fresh_owner):
    _open(page, base_url, api_base_url, fresh_owner)
    expect(page.locator(".fc-event", has_text=TODO_TITLE).first).to_be_visible(timeout=NORMAL_TIMEOUT)
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"
