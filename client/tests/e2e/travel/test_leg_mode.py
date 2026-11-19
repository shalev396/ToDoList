"""
How he goes on a trip, from the trip's sheet (plan 2026-11-19, Task 3), on the owner's 13-inch iPad
(1376x1032 landscape, 1032x1376 portrait), dark, in Hebrew:

- The sheet's "How you go" is a Walk / Drive / Public transport choice. Picking another asks
  "Only this day" or "Every repeat"; the first marks that day's event, the second the whole series.
  The sheet and the stored legs change, the same trip next week is unchanged after "Only this
  day", and a later week changed after "Every repeat".
- The sheet has no horizontal overflow at either size (the "only this trip" leave and arrive
  inputs fit; the owner's iPad showed 15:20 cut off and a horizontal scrollbar).

The lecture is a weekly time block (a series) starting tomorrow, travelled to by bus from Home.
Trips exist only through today+13 (TRAVEL_HORIZON_DAYS = 14), so the two occurrences used are
tomorrow and tomorrow+7. This is the series path only: "Only this day" marks that occurrence,
"Every repeat" the series. The other "every repeat" path (an event that does not repeat itself, a
rule by calendar, title, weekday and time) and the "already made by that rule: nothing stored"
answer (marked: 0) are covered by the server tests in TravelSetup.legMode.test.ts: the e2e helpers
cannot seed an imported event. UNRUN when written: the e2e login needs AWS (SSO was expired), so this has not been executed;
the first run may need its waits tuned. The legs are read from the server (`…/travel/days`), the
sheet from its own attributes.
"""
from datetime import date

import pytest
from playwright.sync_api import Locator, Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard
from tests.helpers.ipad_week import IPAD_LANDSCAPE, IPAD_PORTRAIT, ipad_context
from tests.helpers.scheduled import add_days, create_time_block, this_sunday, zoned_iso
from tests.helpers.travel import create_place, get_days, mark_item
from tests.helpers.workspaces import open_as

LECTURE = "Lecture at Braude"


@pytest.fixture(params=[IPAD_LANDSCAPE, IPAD_PORTRAIT], ids=["landscape", "portrait"])
def ipad(request, browser, browser_context_args):
    context = ipad_context(browser, browser_context_args, request.param)
    page = context.new_page()
    yield page
    context.close()


@pytest.fixture
def ipad_landscape(browser, browser_context_args):
    context = ipad_context(browser, browser_context_args, IPAD_LANDSCAPE)
    page = context.new_page()
    yield page
    context.close()


def _seed(page: Page, api_base_url: str, fresh_owner) -> tuple:
    """Home, Braude and a weekly lecture from tomorrow, travelled to by bus ("there" only, 40
    minutes). Returns (user, workspace id, [tomorrow, tomorrow + 7], this Sunday)."""
    user, workspace = fresh_owner
    wid = workspace["id"]
    create_dashboard(api_base_url, user, wid, language="he")
    page.goto("about:blank")
    today = page.evaluate(
        "() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())"
    )
    first = add_days(today, 1)
    days = [first, add_days(first, 7)]
    weekday = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][date.fromisoformat(first).weekday()]
    create_place(api_base_url, user, wid, "Home", home=True)
    braude = create_place(api_base_url, user, wid, "Braude")
    lecture = create_time_block(
        api_base_url,
        user,
        wid,
        subject=LECTURE,
        startAt=zoned_iso(page, first, "10:30"),
        endAt=zoned_iso(page, first, "12:00"),
        recurrence=[f"RRULE:FREQ=WEEKLY;BYDAY={weekday}"],
    )
    mark_item(
        api_base_url,
        user,
        wid,
        lecture["id"],
        mode="transit",
        direction="there",
        every=True,
        place_id=braude["id"],
        there={"minutes": 40},
    )
    return user, wid, days, this_sunday(page)


def _leg(api_base_url: str, user, wid: str, day: str) -> dict:
    """The one trip of `day` (the lecture's: one trip there), as the server has it now."""
    [row] = get_days(api_base_url, user, wid, day, day)
    assert len(row["legs"]) == 1, row
    return row["legs"][0]


def _open_leg(page: Page, base_url: str, user, leg: dict) -> Locator:
    open_as(page, base_url, user, f"/he/dashboard?item={leg['id']}")
    sheet = page.locator("[data-item-sheet]")
    section = sheet.locator("[data-travel-leg]")
    expect(section).to_be_visible(timeout=NORMAL_TIMEOUT)
    return section


def _no_horizontal_overflow(page: Page) -> None:
    """The sheet and what scrolls inside it do not scroll sideways, and the leave and arrive
    inputs lie inside the sheet."""
    result = page.evaluate(
        """() => {
          const sheet = document.querySelector('[data-item-sheet]');
          const box = sheet.getBoundingClientRect();
          const scrollers = [sheet, ...sheet.querySelectorAll('[data-slot="scroll-area-viewport"]')];
          const wide = scrollers
            .filter((el) => el.scrollWidth > el.clientWidth)
            .map((el) => `${el.tagName} ${el.scrollWidth} > ${el.clientWidth}`);
          const outside = [...sheet.querySelectorAll('[data-leg-times-row] input')]
            .map((input) => input.getBoundingClientRect())
            .filter((r) => r.left < box.left - 1 || r.right > box.right + 1)
            .map((r) => `${r.left}..${r.right} not in ${box.left}..${box.right}`);
          return { wide, outside, inputs: sheet.querySelectorAll('[data-leg-times-row] input').length };
        }"""
    )
    assert result["inputs"] == 2, result
    assert result["wide"] == [], result
    assert result["outside"] == [], result


def test_sheet_has_no_horizontal_overflow(
    ipad: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, wid, days, _ = _seed(ipad, api_base_url, fresh_owner)
    leg = _leg(api_base_url, user, wid, days[0])
    section = _open_leg(ipad, base_url, user, leg)
    expect(section.locator("[data-leg-times-row]")).to_be_visible()
    _no_horizontal_overflow(ipad)
    # The dialog that asks the scope is not a sideways scroll either.
    section.locator("[data-leg-mode-choice='walk']").click()
    expect(ipad.locator("[data-every-occurrence]")).to_be_visible()
    ipad.keyboard.press("Escape")
    expect(ipad.locator("[data-every-occurrence]")).to_have_count(0)
    _no_horizontal_overflow(ipad)


def test_walk_this_day_then_every_repeat(
    ipad_landscape: Page, base_url: str, api_base_url: str, fresh_owner
):
    page = ipad_landscape
    user, wid, [day1, day2], sunday = _seed(page, api_base_url, fresh_owner)
    first, second = (_leg(api_base_url, user, wid, day) for day in (day1, day2))
    for leg in (first, second):
        assert leg["props"]["travel"]["mode"] == "transit", leg

    # Only this day: tomorrow's trip walks, the next week's is still the bus.
    section = _open_leg(page, base_url, user, first)
    expect(section).to_have_attribute("data-leg-mode", "transit")
    section.locator("[data-leg-mode-choice='walk']").click()
    dialog = page.locator("[data-every-occurrence]")
    expect(dialog).to_be_visible()
    with page.expect_response(
        lambda r: r.request.method == "PUT" and r.url.endswith(f"/travel/legs/{first['id']}/mode"),
        timeout=APP_REQUEST_TIMEOUT,
    ) as changed:
        dialog.locator("[data-every-choice='one']").click()
    assert changed.value.request.post_data_json == {"mode": "walk", "scope": "this"}
    assert changed.value.status == 200
    expect(section).to_have_attribute("data-leg-mode", "walk", timeout=NORMAL_TIMEOUT)
    expect(section.locator("[data-leg-mode-choice='walk']")).to_have_attribute("aria-pressed", "true")
    # The trip's title in the sheet follows the mode ("נסיעה באוטובוס לבראודה" becomes the walk).
    expect(section.locator("#leg-title")).to_contain_text("הליכה")
    assert _leg(api_base_url, user, wid, day1)["props"]["travel"]["mode"] == "walk"
    assert _leg(api_base_url, user, wid, day1)["title"].startswith("Walk")
    assert _leg(api_base_url, user, wid, day2)["props"]["travel"]["mode"] == "transit"

    # Every repeat, from the next week's: it is the series that walks now, so that week changes
    # (tomorrow's, already walking, stays).
    second = _leg(api_base_url, user, wid, day2)
    section = _open_leg(page, base_url, user, second)
    expect(section).to_have_attribute("data-leg-mode", "transit")
    section.locator("[data-leg-mode-choice='walk']").click()
    dialog = page.locator("[data-every-occurrence]")
    expect(dialog).to_be_visible()
    with page.expect_response(
        lambda r: r.request.method == "PUT" and r.url.endswith(f"/travel/legs/{second['id']}/mode"),
        timeout=APP_REQUEST_TIMEOUT,
    ) as repeated:
        dialog.locator("[data-every-choice='every']").click()
    assert repeated.value.request.post_data_json == {"mode": "walk", "scope": "repeats"}
    assert repeated.value.json()["data"]["marked"] == 1
    expect(section).to_have_attribute("data-leg-mode", "walk", timeout=NORMAL_TIMEOUT)
    for day in (day1, day2):
        assert _leg(api_base_url, user, wid, day)["props"]["travel"]["mode"] == "walk", day

    # The way he goes is the same in the week calendar (the week of the second trip) (the chip's icon is the mode's).
    page.goto(f"{base_url}/he/dashboard")
    calendar = page.locator("[data-calendar-view='week']")
    expect(calendar).to_be_visible(timeout=NORMAL_TIMEOUT)
    for _ in range((date.fromisoformat(day2) - date.fromisoformat(sunday)).days // 7):
        calendar.get_by_role("button", name="הבא", exact=True).click()
    chips = calendar.locator(".fc-event.tc-travel")
    expect(chips.first).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(chips.locator("[data-leg-mode='walk']")).to_have_count(1)
    expect(chips.locator("[data-leg-mode='transit']")).to_have_count(0)
