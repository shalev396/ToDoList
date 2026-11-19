"""
A time block in the item sheet and the week view (time-blocks design, "One source of truth for
repeating blocks", "Creating and filling the week" and "Areas"):

- a click on one occurrence of a repeating block opens the sheet on it (`?occurrence=<epoch ms>`);
- a new time asks "This one" or "All", and "This one" moves only that occurrence;
- Skip this one hides that occurrence only, and Bring it back undoes it;
- dragging across free time in the week grid opens the New sheet on a time block at that time,
  and inside an area on the area's page.

Each test owns a fresh workspace on Asia/Jerusalem (weeks start on Sunday) with the default
dashboard, whose week calendar reads every timed item, blocks and areas included. Blocks are seeded
through the API; a weekly one starts the week before, so this week's is not its first.
"""
from datetime import datetime

from playwright.sync_api import Locator, Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.scheduled import (
    KINDS,
    add_days,
    create_time_block,
    drag_in_week,
    is_block_edit,
    is_block_skip,
    this_sunday,
    zoned_iso,
)
from tests.helpers.workspaces import open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT


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


def _epoch_ms(iso: str) -> int:
    return round(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _same_instant(a: str, b: str) -> bool:
    return _epoch_ms(a) == _epoch_ms(b)


def _seed_weekly_calculus(page: Page, api_base_url: str, fresh_owner) -> str:
    """Calculus, weekly on Sunday 13:00–17:00 from last week's Sunday. Returns this Sunday."""
    user, workspace = fresh_owner
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
    return sunday


def _open_this_weeks(page: Page, calendar: Locator, sunday: str) -> Locator:
    """Clicks this week's Calculus and returns the sheet, opened on that occurrence."""
    event = calendar.locator(".fc-event", has_text="Calculus")
    expect(event).to_have_count(1, timeout=NORMAL_TIMEOUT)
    event.click()
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-time-block-section=block]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert f"occurrence={_epoch_ms(zoned_iso(page, sunday, '13:00'))}" in page.url, page.url
    return sheet


def test_this_one_moves_only_that_occurrence(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    _open(page, base_url, api_base_url, fresh_owner)
    sunday = _seed_weekly_calculus(page, api_base_url, fresh_owner)
    calendar = _reload(page)
    sheet = _open_this_weeks(page, calendar, sunday)
    expect(sheet.locator("[data-block-when]")).to_contain_text("13:00–17:00")
    expect(sheet.locator("[data-block-repeat]")).to_have_text("Weekly on Sunday")

    sheet.get_by_role("button", name="Edit", exact=True).click()
    form = sheet.locator("[data-time-block-edit=block]")
    expect(form).to_be_visible()
    # A new start keeps the length: 14:00–18:00.
    form.get_by_label("Start time", exact=True).fill("14:00")
    expect(form.get_by_label("End time", exact=True)).to_have_value("18:00")
    form.locator("[data-time-block-save]").click()

    dialog = page.locator("[data-edit-scope]")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("heading", name="Change which ones?")).to_be_visible()
    with page.expect_response(is_block_edit, timeout=APP_REQUEST_TIMEOUT) as edited:
        dialog.locator("[data-edit-scope-choice=this]").click()
    assert edited.value.status == 200, edited.value.text()[:200]
    sent = edited.value.request.post_data_json
    assert sent["scope"] == "this"
    assert _same_instant(sent["originalStart"], zoned_iso(page, sunday, "13:00"))
    exceptions = edited.value.json()["data"]["props"]["exceptions"]
    assert len(exceptions) == 1
    assert _same_instant(exceptions[0]["startAt"], zoned_iso(page, sunday, "14:00"))
    expect(dialog).to_be_hidden()
    expect(sheet.locator("[data-block-moved]")).to_contain_text("Moved from")
    expect(sheet.locator("[data-block-when]")).to_contain_text("14:00–18:00")

    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()
    # This week's moved; next week's is where the series has it.
    expect(calendar.locator(".fc-event", has_text="Calculus")).to_contain_text(
        "14:00", timeout=NORMAL_TIMEOUT
    )
    calendar.get_by_role("button", name="Next", exact=True).click()
    next_week = calendar.locator(".fc-event", has_text="Calculus")
    expect(next_week).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(next_week).to_contain_text("13:00")
    assert errors == []


def test_skip_hides_one_occurrence(page: Page, base_url: str, api_base_url: str, fresh_owner):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    _open(page, base_url, api_base_url, fresh_owner)
    sunday = _seed_weekly_calculus(page, api_base_url, fresh_owner)
    calendar = _reload(page)
    sheet = _open_this_weeks(page, calendar, sunday)

    with page.expect_response(is_block_skip, timeout=APP_REQUEST_TIMEOUT) as skipped:
        sheet.locator("[data-block-skip]").click()
    assert skipped.value.status == 200, skipped.value.text()[:200]
    exceptions = skipped.value.json()["data"]["props"]["exceptions"]
    assert [entry.get("skipped") for entry in exceptions] == [True]
    expect(sheet.locator("[data-block-skipped]")).to_contain_text("This one is skipped.")

    # Bring it back: the occurrence is back at its own times, with no exception left.
    with page.expect_response(is_block_edit, timeout=APP_REQUEST_TIMEOUT) as restored:
        sheet.get_by_role("button", name="Bring it back", exact=True).click()
    assert restored.value.status == 200, restored.value.text()[:200]
    assert restored.value.json()["data"]["props"]["exceptions"] == []
    expect(sheet.locator("[data-block-skip]")).to_be_visible()

    with page.expect_response(is_block_skip, timeout=APP_REQUEST_TIMEOUT) as skipped_again:
        sheet.locator("[data-block-skip]").click()
    assert skipped_again.value.status == 200
    expect(sheet.locator("[data-block-skipped]")).to_be_visible()

    page.keyboard.press("Escape")
    expect(sheet).to_be_hidden()
    expect(calendar.locator(".fc-event", has_text="Calculus")).to_have_count(0, timeout=NORMAL_TIMEOUT)
    calendar.get_by_role("button", name="Next", exact=True).click()
    expect(calendar.locator(".fc-event", has_text="Calculus")).to_have_count(1, timeout=NORMAL_TIMEOUT)
    assert errors == []


def test_drag_in_week_opens_form_with_time(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    calendar = _open(page, base_url, api_base_url, fresh_owner)
    tuesday = add_days(this_sunday(page), 2)
    drag_in_week(page, calendar, tuesday, "13:00", "15:00")

    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sheet.get_by_role("radio", name=KINDS["en"]["block"], exact=True)).to_be_checked()
    form = sheet.locator("[data-time-block-form=block]")
    expect(form.get_by_label("Start date", exact=True)).to_have_value(tuesday)
    expect(form.get_by_label("Start time", exact=True)).to_have_value("13:00")
    expect(form.get_by_label("End date", exact=True)).to_have_value(tuesday)
    expect(form.get_by_label("End time", exact=True)).to_have_value("15:00")
    expect(form.get_by_label("Hours", exact=True)).to_have_value("2")
    # Not inside an area, and not on a topic page: no page is chosen.
    expect(form.get_by_label("Page", exact=True)).to_have_text("As last time with this subject")


def test_drag_inside_area_prefills_its_topic(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    _open(page, base_url, api_base_url, fresh_owner)
    tuesday = add_days(this_sunday(page), 2)
    create_time_block(
        api_base_url,
        user,
        workspace["id"],
        layer="area",
        title="Studying",
        topicId=topic_id(api_base_url, user, workspace["id"], "college"),
        startAt=zoned_iso(page, tuesday, "12:00"),
        endAt=zoned_iso(page, tuesday, "18:00"),
    )
    calendar = _reload(page)
    expect(calendar.locator(".tc-area", has_text="Studying").first).to_be_attached(timeout=NORMAL_TIMEOUT)

    drag_in_week(page, calendar, tuesday, "13:00", "15:00")
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    form = sheet.locator("[data-time-block-form=block]")
    expect(form.get_by_label("Start time", exact=True)).to_have_value("13:00")
    expect(form.get_by_label("End time", exact=True)).to_have_value("15:00")
    expect(form.get_by_label("Page", exact=True)).to_have_text("College")
