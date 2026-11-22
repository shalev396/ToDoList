"""
The disabled state (server classes/item/Disabled.ts; the owner's "a disabled state in case a to-do
is cancelled, so it shows differently and I know I can set things over it"):

- one occurrence of a repeating time block is disabled from the item sheet ("Only this one"): it
  stays on the week calendar with no fill, faded and struck through, named "Disabled"; the next
  week's occurrence is untouched; Enable brings it back;
- a cancelled to-do with a time shows the same way, named "Cancelled".

Each test owns a fresh workspace on Asia/Jerusalem (weeks start on Sunday) with the default
dashboard, whose week calendar reads every timed item. Items are seeded through the API.
"""
import re
from datetime import datetime

from playwright.sync_api import Locator, Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.items import create_timed_todo, is_overlay_write, set_item_status
from tests.helpers.scheduled import add_days, create_time_block, this_sunday, zoned_iso
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT


def _epoch_ms(iso: str) -> int:
    return round(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _open(page: Page, base_url: str, api_base_url: str, fresh_owner) -> Locator:
    user, workspace = fresh_owner
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    calendar = page.locator("[data-calendar-view]")
    expect(calendar).to_be_visible(timeout=NORMAL_TIMEOUT)
    return calendar


def _reload(page: Page) -> Locator:
    page.reload(wait_until="load")
    calendar = page.locator("[data-calendar-view]")
    expect(calendar).to_be_visible(timeout=NORMAL_TIMEOUT)
    return calendar


def _looks_off(event: Locator) -> None:
    """No fill, faded, its title struck through: free time at a glance."""
    expect(event).to_have_class(re.compile(r"\btc-off\b"))
    style = event.evaluate(
        """(el) => {
          const s = getComputedStyle(el);
          const title = el.querySelector('[data-chip-title]');
          return {
            background: s.backgroundColor,
            opacity: Number(s.opacity),
            decoration: title ? getComputedStyle(title).textDecorationLine : '',
          };
        }"""
    )
    assert style["background"] in ("rgba(0, 0, 0, 0)", "transparent"), style
    assert style["opacity"] < 1, style
    assert "line-through" in style["decoration"], style


def test_disable_one_occurrence_then_enable(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    user, workspace = fresh_owner
    _open(page, base_url, api_base_url, fresh_owner)
    sunday = this_sunday(page)
    first = add_days(sunday, -7)
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        subject="Calculus",
        startAt=zoned_iso(page, first, "13:00"),
        endAt=zoned_iso(page, first, "17:00"),
        recurrence=["RRULE:FREQ=WEEKLY;BYDAY=SU"],
    )
    calendar = _reload(page)
    event = calendar.locator(".fc-event", has_text="Calculus")
    expect(event).to_have_count(1, timeout=NORMAL_TIMEOUT)
    event.click()
    sheet = page.locator("[data-item-sheet]")
    section = sheet.locator("[data-item-disable]")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    slot = zoned_iso(page, sunday, "13:00")
    assert f"occurrence={_epoch_ms(slot)}" in page.url, page.url

    section.locator("[data-item-disable-button]").click()
    dialog = page.locator("[data-disable-scope]")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("heading", name="Disable which occurrences?")).to_be_visible()
    with page.expect_response(is_overlay_write, timeout=APP_REQUEST_TIMEOUT) as disabled:
        dialog.locator("[data-disable-scope-choice=occurrence]").click()
    assert disabled.value.status == 200, disabled.value.text()[:200]
    sent = disabled.value.request.post_data_json
    assert sent["disabled"] is True and sent["scope"] == "occurrence", sent
    assert _epoch_ms(sent["occurrenceStart"]) == _epoch_ms(slot), sent
    stored = disabled.value.json()["data"]["overlay"]
    assert stored["disabled"] is None
    assert [_epoch_ms(at) for at in stored["disabledOccurrences"]] == [_epoch_ms(slot)]
    expect(dialog).to_be_hidden()
    expect(section.locator("[data-disabled-state=occurrence]")).to_contain_text(
        "This occurrence is disabled"
    )

    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()
    off = calendar.locator(".fc-event", has_text="Calculus")
    expect(off).to_have_attribute("data-inactive", "disabled", timeout=NORMAL_TIMEOUT)
    expect(off).to_have_attribute("aria-label", re.compile(r"Disabled"))
    _looks_off(off)
    # Next week's occurrence is untouched.
    calendar.get_by_role("button", name="Next", exact=True).click()
    next_week = calendar.locator(".fc-event", has_text="Calculus")
    expect(next_week).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(next_week).not_to_have_class(re.compile(r"\btc-off\b"))
    calendar.get_by_role("button", name="Previous", exact=True).click()

    # Enable: back as it was.
    calendar.locator(".fc-event", has_text="Calculus").click()
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    with page.expect_response(is_overlay_write, timeout=APP_REQUEST_TIMEOUT) as enabled:
        section.locator("[data-item-enable=occurrence]").click()
    assert enabled.value.status == 200, enabled.value.text()[:200]
    assert enabled.value.json()["data"]["overlay"]["disabledOccurrences"] == []
    expect(section.locator("[data-item-disable-button]")).to_be_visible()
    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()
    back = calendar.locator(".fc-event", has_text="Calculus")
    expect(back).not_to_have_class(re.compile(r"\btc-off\b"), timeout=NORMAL_TIMEOUT)
    expect(back).not_to_have_attribute("data-inactive", re.compile(r".+"))
    assert errors == []


def test_cancelled_todo_shows_faded(page: Page, base_url: str, api_base_url: str, fresh_owner):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    user, workspace = fresh_owner
    _open(page, base_url, api_base_url, fresh_owner)
    tuesday = add_days(this_sunday(page), 2)
    todo = create_timed_todo(
        api_base_url,
        user,
        workspace["id"],
        "Dentist",
        zoned_iso(page, tuesday, "10:00"),
        zoned_iso(page, tuesday, "11:00"),
    )
    set_item_status(api_base_url, user, workspace["id"], todo["id"], "cancelled")
    calendar = _reload(page)
    event = calendar.locator(".fc-event", has_text="Dentist")
    expect(event).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(event).to_have_attribute("data-inactive", "cancelled")
    expect(event).to_have_attribute("aria-label", re.compile(r"Cancelled"))
    _looks_off(event)
    assert errors == []
