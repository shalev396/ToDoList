"""
Topic colours on the list, kanban, timeline, agenda, deadlines and chart blocks: every item is
painted by its topic's family and its role (a local to-do is Work), never by its source, which
shows as a small icon. Chart segments grouped by topic take the family's Scheduled shade.

Each test owns a fresh workspace on Asia/Jerusalem with the default dashboard plus a list, a kanban
board, a timeline and an agenda over the local to-dos. Two to-dos, one in Work and one in College,
are due and scheduled today. The default chart is regrouped by topic and its page-topic filter
taken off, so it counts both. A new workspace's families come from the server (Personal blue, then
Work and College take the next two of the cycle), so they are read from its topics.
"""
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
LIST, BOARD, TIMELINE, AGENDA = "List colours", "Board colours", "Timeline colours", "Agenda colours"
CHART, DEADLINES = "Chart colours", "Deadlines colours"

LOCAL = {
    "combinator": "and",
    "rules": [{"field": "source.provider", "operator": "=", "value": "local"}],
}


def _patch(api_base_url: str, user, workspace_id: str, item_id: str, body: dict) -> None:
    response = requests.patch(
        f"{api_base_url}/private/workspaces/{workspace_id}/items/{item_id}",
        json=body,
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
    """The dashboard, its blocks and the two to-dos; returns each topic's family by name."""
    user, workspace = fresh_owner
    wid = workspace["id"]
    dashboard = create_dashboard(api_base_url, user, wid)
    chart = next(block for block in dashboard["blocks"] if block["type"] == "chart")
    deadlines = next(block for block in dashboard["blocks"] if block["type"] == "deadlines")
    chart_query = {
        **chart["query"],
        "where": {
            **chart["query"]["where"],
            "rules": [r for r in chart["query"]["where"]["rules"] if r.get("field") != "topic"],
        },
        "groupBy": ["topic"],
    }
    deadlines_query = {
        **deadlines["query"],
        "where": {
            **deadlines["query"]["where"],
            "rules": [r for r in deadlines["query"]["where"]["rules"] if r.get("field") != "topic"],
        },
    }
    time_query = {"source": "items", "where": LOCAL, "dateRange": "next7d", "dateField": "startAt"}
    apply_ops(
        api_base_url,
        user,
        wid,
        dashboard["id"],
        dashboard["version"],
        [
            {
                "op": "update_block",
                "blockId": chart["id"],
                "patch": {"title": CHART, "query": chart_query},
            },
            {
                "op": "update_block",
                "blockId": deadlines["id"],
                "patch": {"title": DEADLINES, "query": deadlines_query},
            },
            {
                "op": "add_block",
                "block": {
                    "type": "list",
                    "title": LIST,
                    "query": {"source": "items", "where": LOCAL, "limit": 20},
                    "viz": {"kind": "list"},
                },
            },
            {
                "op": "add_block",
                "block": {
                    "type": "kanban",
                    "title": BOARD,
                    "query": {"source": "items", "where": LOCAL, "groupBy": ["status"], "limit": 20},
                    "viz": {"kind": "kanban"},
                },
            },
            {
                "op": "add_block",
                "block": {
                    "type": "timeline",
                    "title": TIMELINE,
                    "query": time_query,
                    "viz": {"kind": "timeline", "days": 2},
                },
            },
            {
                "op": "add_block",
                "block": {"type": "agenda", "title": AGENDA, "query": time_query, "viz": {"kind": "agenda"}},
            },
        ],
    )
    work = create_local_item(api_base_url, user, wid, WORK_TITLE, topic="work")
    college = create_local_item(api_base_url, user, wid, COLLEGE_TITLE, topic="college")
    zone = _workspace_zone(page)
    now = datetime.now(zone)
    day_end = datetime.combine(now.date(), time(23, 59), zone)
    # Both later today (the timeline and the agenda list them under today), due before midnight.
    for item, start in ((work, now + timedelta(minutes=30)), (college, now + timedelta(minutes=90))):
        start = min(start, day_end - timedelta(minutes=30))
        _patch(
            api_base_url,
            user,
            wid,
            item["id"],
            {
                "startAt": start.isoformat(),
                "endAt": (start + timedelta(minutes=20)).isoformat(),
                "dueAt": day_end.isoformat(),
            },
        )
    families = {topic["name"]: topic["colour"] for topic in list_topics(api_base_url, user, wid)}
    assert families["Work"] != families["College"], families
    return families


def _open(page: Page, base_url: str, fresh_owner, lang: str = "en") -> None:
    user, _ = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, f"/{lang}/dashboard")
    for title in (LIST, BOARD, TIMELINE, AGENDA, CHART, DEADLINES):
        expect(page.get_by_role("article", name=title, exact=True)).to_be_visible(
            timeout=NORMAL_TIMEOUT
        )


def _block(page: Page, title: str):
    return page.get_by_role("article", name=title, exact=True)


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


def _dot(row, family: str):
    return row.locator(f'[data-family="{family}"][data-role="work"]').first


def test_list_rows_follow_topics(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)
    block = _block(page, LIST)
    for title, topic in ((WORK_TITLE, "Work"), (COLLEGE_TITLE, "College")):
        row = block.locator("li", has_text=title).first
        expect(_dot(row, families[topic])).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(row.locator("[data-source-icon='local']")).to_have_count(1)


def test_kanban_card_edge_follows_topic(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)
    board = _block(page, BOARD)
    for title, topic in ((WORK_TITLE, "Work"), (COLLEGE_TITLE, "College")):
        card = board.locator("[data-family]", has_text=title).first
        expect(card).to_have_attribute("data-family", families[topic], timeout=NORMAL_TIMEOUT)
        assert card.evaluate("(el) => getComputedStyle(el).borderLeftWidth") == "4px"
        edge = card.evaluate("(el) => getComputedStyle(el).borderInlineStartColor")
        assert edge == _token(page, f"--tc-{families[topic]}-work")
        expect(card.locator("[data-source-icon='local']")).to_have_count(1)


def test_chart_segments_use_scheduled_tokens(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)
    chart = _block(page, CHART)
    legend = chart.get_by_role("list", name="Legend")
    expect(legend).to_be_visible(timeout=NORMAL_TIMEOUT)
    for topic in ("Work", "College"):
        dot = legend.get_by_role("listitem").filter(has_text=topic).locator("span[aria-hidden]").first
        expect(dot).to_be_visible()
        assert dot.evaluate("(el) => getComputedStyle(el).backgroundColor") == _token(
            page, f"--tc-{families[topic]}-scheduled"
        )
    # The donut's slices carry the same fills.
    fills = chart.locator("path.recharts-sector").evaluate_all("(els) => els.map((e) => e.getAttribute('fill'))")
    assert f"var(--tc-{families['Work']}-scheduled)" in fills, fills
    assert f"var(--tc-{families['College']}-scheduled)" in fills, fills


def test_timeline_agenda_and_deadlines_rows(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    _open(page, base_url, fresh_owner)
    for block_title in (TIMELINE, AGENDA):
        block = _block(page, block_title)
        for title, topic in ((WORK_TITLE, "Work"), (COLLEGE_TITLE, "College")):
            row = block.locator("li", has_text=title).first
            expect(_dot(row, families[topic])).to_be_visible(timeout=NORMAL_TIMEOUT)
            expect(row.locator("[data-source-icon='local']")).to_have_count(1)
    deadlines = _block(page, DEADLINES)
    expect(deadlines.locator('[data-role="work"]').first).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_hebrew_kanban_edge_is_on_the_right(page: Page, base_url: str, api_base_url: str, fresh_owner):
    families = _seed(page, api_base_url, fresh_owner)
    page.emulate_media(color_scheme="dark")
    user, _ = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/he/dashboard")
    card = _block(page, BOARD).locator("[data-family]", has_text=WORK_TITLE).first
    expect(card).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert page.evaluate("() => document.documentElement.classList.contains('dark')")
    assert card.evaluate("(el) => getComputedStyle(el).borderRightWidth") == "4px"
    assert card.evaluate("(el) => getComputedStyle(el).borderLeftWidth") == "1px"
    assert card.evaluate("(el) => getComputedStyle(el).borderRightColor") == _token(
        page, f"--tc-{families['Work']}-work"
    )
