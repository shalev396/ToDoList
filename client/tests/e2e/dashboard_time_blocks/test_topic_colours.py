"""
Topic colours on the clock and the calendar: every item is painted by its topic's family and its
role (a local to-do is Work), never by its source, which shows as a small icon. The clock gets a
legend of the topics on it; the ring never mirrors in Hebrew while the legend flows right to left.

Each test owns a fresh workspace on Asia/Jerusalem with the default dashboard (a clock, "Today",
and a calendar) and two local to-dos today: one in Work (on now, so the Now line always shows it)
and one in College at 13:00-14:00. The default clock reads events only, so its query's filter is
taken off first: local to-dos (the Work role) are what a test can create. A new workspace's
families come from the server (Personal blue, then Work and College take the next two of the
cycle), so they are read from its topics.
"""
import re
from datetime import datetime, time, timedelta, timezone

import requests
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard
from tests.helpers.items import create_local_item
from tests.helpers.workspaces import list_topics, open_as
from tests.viewports import DESKTOP_VIEWPORT

WORK_TITLE = "Write the release notes"
COLLEGE_TITLE = "Calculus homework"


def _set_times(api_base_url: str, user, workspace_id: str, item_id: str, start, end) -> None:
    response = requests.patch(
        f"{api_base_url}/private/workspaces/{workspace_id}/items/{item_id}",
        json={"startAt": start.isoformat(), "endAt": end.isoformat()},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code < 300, response.text[:200]


def _workspace_zone(page: Page) -> timezone:
    """Asia/Jerusalem's offset now, from the browser's zone data (the test runner may have none)."""
    minutes = page.evaluate(
        """() => {
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: 'numeric',
                day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
            }).formatToParts(now);
            const part = (type) => Number(parts.find((p) => p.type === type).value);
            const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'),
                part('minute'), part('second'));
            return Math.round((wall - Math.floor(now.getTime() / 1000) * 1000) / 60000);
        }"""
    )
    return timezone(timedelta(minutes=minutes))


def _seed(page: Page, api_base_url: str, fresh_owner) -> dict:
    """The dashboard and the two to-dos; returns each topic's family by name."""
    user, workspace = fresh_owner
    wid = workspace["id"]
    dashboard = create_dashboard(api_base_url, user, wid)
    clock = next(block for block in dashboard["blocks"] if block["type"] == "clock")
    query = {key: value for key, value in clock["query"].items() if key != "where"}
    apply_ops(
        api_base_url,
        user,
        wid,
        dashboard["id"],
        dashboard["version"],
        [{"op": "update_block", "blockId": clock["id"], "patch": {"query": query}}],
    )
    work = create_local_item(api_base_url, user, wid, WORK_TITLE, topic="work")
    college = create_local_item(api_base_url, user, wid, COLLEGE_TITLE, topic="college")

    zone = _workspace_zone(page)
    now = datetime.now(zone)
    day_start = datetime.combine(now.date(), time(0, 0), zone)
    day_end = datetime.combine(now.date(), time(23, 59), zone)
    _set_times(
        api_base_url,
        user,
        wid,
        work["id"],
        max(day_start, now - timedelta(minutes=15)),
        min(day_end, now + timedelta(minutes=45)),
    )
    _set_times(
        api_base_url,
        user,
        wid,
        college["id"],
        datetime.combine(now.date(), time(13, 0), zone),
        datetime.combine(now.date(), time(14, 0), zone),
    )
    families = {topic["name"]: topic["colour"] for topic in list_topics(api_base_url, user, wid)}
    assert families["Work"] != families["College"], families
    return families


def _open(page: Page, base_url: str, fresh_owner, lang: str = "en") -> None:
    user, _ = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, f"/{lang}/dashboard")
    expect(page.locator("[data-calendar-view]")).to_be_visible(timeout=NORMAL_TIMEOUT)


def _clock(page: Page, summary: str = r"^Today, "):
    """The clock block: the one holding the ring (its title stays the dashboard's language's)."""
    return page.get_by_role("article").filter(
        has=page.get_by_role("img", name=re.compile(summary))
    )


def _token(page: Page, token: str) -> str:
    """A colour token as the page resolves it (rgb), in the current theme."""
    return page.evaluate(
        """(token) => {
            const probe = document.createElement('div');
            probe.style.backgroundColor = `var(${token})`;
            document.body.append(probe);
            const colour = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return colour;
        }""",
        token,
    )


def _event(page: Page, title: str):
    return page.locator(".fc-event", has_text=title).first


def _background(locator) -> str:
    return locator.evaluate("(el) => getComputedStyle(el).backgroundColor")


def test_clock_arcs_follow_topics(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)
    clock = _clock(page)
    expect(clock).to_have_count(1, timeout=NORMAL_TIMEOUT)
    ring = clock.get_by_role("img", name=re.compile(r"^Today, "))
    expect(ring).to_be_visible(timeout=NORMAL_TIMEOUT)

    for topic in ("Work", "College"):
        arc = ring.locator(f'path[data-family="{families[topic]}"][data-role="work"]')
        expect(arc).to_have_count(1, timeout=NORMAL_TIMEOUT)
    # The source no longer colours the ring.
    expect(ring.locator("path[class*='fill-source-']")).to_have_count(0)

    # In the order the ring shows them (which depends on the time of day): each name once.
    legend = clock.get_by_role("list", name="Color key")
    expect(legend).to_be_visible()
    expect(legend.get_by_role("listitem")).to_have_count(2)
    for topic in ("Work", "College"):
        dot = legend.get_by_role("listitem").filter(has_text=topic).locator("[data-family]")
        expect(dot).to_have_attribute("data-family", families[topic])

    # Now: the Work to-do, with its colour dot and its source as an icon.
    summary = clock.locator("[aria-live='polite']")
    expect(summary).to_contain_text(WORK_TITLE)
    expect(summary.locator("[data-source-icon='local']").first).to_be_attached()
    expect(summary.locator(f"[data-family='{families['Work']}']").first).to_be_visible()


def test_calendar_events_follow_topics(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)

    for title, topic in ((WORK_TITLE, "Work"), (COLLEGE_TITLE, "College")):
        event = _event(page, title)
        expect(event).to_be_attached(timeout=NORMAL_TIMEOUT)
        expect(event).to_have_attribute("data-family", families[topic])
        expect(event).to_have_attribute("data-role", "work")
        assert _background(event) == _token(page, f"--tc-{families[topic]}-work")
        expect(event.locator("[data-source-icon='local']")).to_have_count(1)
        assert "fc-src-" not in (event.get_attribute("class") or "")


def test_dark_and_hebrew(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)
    event = _event(page, COLLEGE_TITLE)
    expect(event).to_be_attached(timeout=NORMAL_TIMEOUT)
    light = _background(event)

    page.emulate_media(color_scheme="dark")
    page.evaluate("() => localStorage.setItem('todolist-ui-theme', 'dark')")
    _open(page, base_url, fresh_owner, lang="he")
    assert page.evaluate("() => document.documentElement.classList.contains('dark')")
    event = _event(page, COLLEGE_TITLE)
    expect(event).to_be_attached(timeout=NORMAL_TIMEOUT)
    dark = _background(event)
    assert dark != light
    assert dark == _token(page, f"--tc-{families['College']}-work")

    clock = _clock(page, r"^היום, ")
    expect(clock).to_have_count(1, timeout=NORMAL_TIMEOUT)
    legend = clock.get_by_role("list", name="מקרא צבעים")
    expect(legend).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert legend.evaluate("(el) => getComputedStyle(el).direction") == "rtl"
    ring = clock.get_by_role("img", name=re.compile(r"^היום, "))
    assert ring.evaluate("(el) => getComputedStyle(el).direction") == "ltr"
