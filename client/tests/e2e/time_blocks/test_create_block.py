"""
The New sheet's three kinds (time-blocks design, "Creating and filling the week" and "Areas"): a
to-do, a time block or an area. The block form takes any two of start, end and length and works the
third out; Repeat is none, weekly on chosen days, or custom. A weekly block is one record that shows
in every week of the calendar.

Each test owns a fresh workspace on Asia/Jerusalem (weeks start on Sunday) with the default
dashboard, whose week calendar reads every timed item, blocks and areas included.
"""
from playwright.sync_api import Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.scheduled import KINDS, choose_kind, is_block_create, open_new_sheet, this_sunday
from tests.helpers.select import choose
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT


def _open(page: Page, base_url: str, api_base_url: str, fresh_owner, language: str = "en") -> None:
    user, workspace = fresh_owner
    create_dashboard(api_base_url, user, workspace["id"], language=language)
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, f"/{language}/dashboard")
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_block_form_computes_the_third_field(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    _open(page, base_url, api_base_url, fresh_owner)
    sheet = open_new_sheet(page)
    form = choose_kind(sheet, "block")
    expect(sheet.get_by_role("heading", name="New time block")).to_be_visible()
    start_date = form.get_by_label("Start date", exact=True)
    start_time = form.get_by_label("Start time", exact=True)
    end_date = form.get_by_label("End date", exact=True)
    end_time = form.get_by_label("End time", exact=True)
    hours = form.get_by_label("Hours", exact=True)
    minutes = form.get_by_label("Minutes", exact=True)

    # Start and the length (an hour to begin with): the end follows.
    start_date.fill("2026-12-06")
    start_time.fill("13:00")
    expect(end_date).to_have_value("2026-12-06")
    expect(end_time).to_have_value("14:00")
    expect(hours).to_have_value("1")

    # Start and end: the length follows.
    end_time.fill("17:00")
    expect(hours).to_have_value("4")
    expect(minutes).to_have_value("0")

    # End and length: the start, now the oldest edit, follows.
    hours.fill("2")
    expect(start_time).to_have_value("15:00")
    expect(end_time).to_have_value("17:00")

    # The start again: the end is the oldest now, and it crosses midnight.
    start_time.fill("23:00")
    expect(end_date).to_have_value("2026-12-07")
    expect(end_time).to_have_value("01:00")

    # An end before the start says so, the length empties, and nothing can be saved.
    end_date.fill("2026-12-06")
    problem = form.locator("[data-span-problem]")
    expect(problem).to_have_attribute("data-span-problem", "order")
    expect(problem).to_have_text("The end is before the start.")
    expect(hours).to_have_value("")
    expect(form.locator("[data-time-block-save]")).to_be_disabled()


def test_weekly_block_shows_this_week_and_next(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    _open(page, base_url, api_base_url, fresh_owner)
    sunday = this_sunday(page)
    sheet = open_new_sheet(page)
    form = choose_kind(sheet, "block")

    # No title: the subject names it.
    form.get_by_label("Subject", exact=True).fill("Calculus")
    form.get_by_label("Start date", exact=True).fill(sunday)
    form.get_by_label("Start time", exact=True).fill("13:00")
    form.get_by_label("End time", exact=True).fill("17:00")
    expect(form.get_by_label("Hours", exact=True)).to_have_value("4")
    choose(form.get_by_label("Repeat", exact=True), "Weekly on Sunday")
    expect(form.locator("[data-weekday=SU]")).to_have_attribute("aria-pressed", "true")

    with page.expect_response(is_block_create, timeout=APP_REQUEST_TIMEOUT) as created:
        form.locator("[data-time-block-save]").click()
    assert created.value.status == 201, created.value.text()[:200]
    block = created.value.json()["data"]
    assert block["kind"] == "block"
    assert block["title"] == "Calculus"
    assert block["overlay"]["attrs"]["subject"] == "Calculus"
    assert block["props"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=SU"]
    expect(sheet).to_be_hidden()

    calendar = page.locator("[data-calendar-view]")
    expect(calendar.locator(".fc-event", has_text="Calculus")).to_have_count(1, timeout=NORMAL_TIMEOUT)
    # One record, every week: next week's Sunday has it too.
    calendar.get_by_role("button", name="Next", exact=True).click()
    expect(calendar.locator(".fc-event", has_text="Calculus")).to_have_count(1, timeout=NORMAL_TIMEOUT)
    assert errors == []


def test_area_is_the_third_kind(page: Page, base_url: str, api_base_url: str, fresh_owner):
    _open(page, base_url, api_base_url, fresh_owner)
    sunday = this_sunday(page)
    sheet = open_new_sheet(page)
    expect(sheet.get_by_role("radio")).to_have_count(3)
    expect(sheet.get_by_role("radio", name=KINDS["en"]["todo"], exact=True)).to_be_checked()
    form = choose_kind(sheet, "area")
    expect(sheet.get_by_role("heading", name="New area")).to_be_visible()
    form.get_by_label("Start date", exact=True).fill(sunday)
    form.get_by_label("Start time", exact=True).fill("13:00")
    form.get_by_label("Hours", exact=True).fill("4")
    expect(form.get_by_label("End time", exact=True)).to_have_value("17:00")

    # An area needs a title (a subject alone doesn't name it).
    form.get_by_label("Subject", exact=True).fill("Calculus")
    form.locator("[data-time-block-save]").click()
    expect(form.locator("[data-time-block-error]")).to_have_text("An area needs a title.")
    expect(form.get_by_label("Title", exact=True)).to_have_attribute("aria-invalid", "true")

    form.get_by_label("Title", exact=True).fill("Studying")
    with page.expect_response(is_block_create, timeout=APP_REQUEST_TIMEOUT) as created:
        form.locator("[data-time-block-save]").click()
    assert created.value.status == 201, created.value.text()[:200]
    area = created.value.json()["data"]
    assert area["kind"] == "block"
    assert area["title"] == "Studying"
    assert area["props"]["layer"] == "area"
    assert "recurrence" not in area["props"]
    expect(sheet).to_be_hidden()

    # The calendar paints it as an area band, not an event.
    calendar = page.locator("[data-calendar-view]")
    expect(calendar.locator(".tc-area", has_text="Studying").first).to_be_attached(timeout=NORMAL_TIMEOUT)


def test_form_in_hebrew_is_rtl(page: Page, base_url: str, api_base_url: str, fresh_owner):
    _open(page, base_url, api_base_url, fresh_owner, language="he")
    assert page.evaluate("() => document.documentElement.dir") == "rtl"
    sheet = open_new_sheet(page)
    for kind in ("todo", "block", "area"):
        expect(sheet.get_by_role("radio", name=KINDS["he"][kind], exact=True)).to_be_visible()
    form = choose_kind(sheet, "block", language="he")
    expect(sheet.get_by_role("heading", name="בלוק זמן חדש")).to_be_visible()
    assert form.evaluate("(el) => getComputedStyle(el).direction") == "rtl"
    assert sheet.locator("[data-kind-choice]").evaluate("(el) => getComputedStyle(el).direction") == "rtl"
    # The labels are Hebrew too, and the start comes before the end on the reading side.
    expect(form.get_by_label("שעת התחלה", exact=True)).to_be_visible()
    start = form.get_by_label("תאריך התחלה", exact=True).bounding_box()
    start_time = form.get_by_label("שעת התחלה", exact=True).bounding_box()
    assert start is not None and start_time is not None
    # Right to left: the date sits to the right of its time.
    assert start["x"] > start_time["x"]
