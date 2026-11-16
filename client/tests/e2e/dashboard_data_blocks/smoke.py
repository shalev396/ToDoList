"""
The data blocks (list, table, deadlines, counter, chart, kanban) on a dashboard over the
demo workspace's data: each renders, source links point at the rows' URLs, the chart's legend
chip sets the page variable in the URL, a local card moves between board columns, a mirrored one
cannot, titles that are long, Hebrew or emoji never overflow a phone, and axe is clean.

One workspace with demo data (`loadDemoData`, dev and qa) per module, deleted at its end.
"""
import re

import pytest
import requests
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.dashboards import apply_ops, get_dashboard, list_dashboards
from tests.helpers.users import pooled_user
from tests.helpers.workspaces import create_workspace, delete_workspace, forget_left_behind, open_as
from tests.viewports import DESKTOP_VIEWPORT

PHONE = {"width": 320, "height": 800}
ITEMS = {"kind": "any"}

LIST, TABLE, DEADLINES, COUNTER, BOARD = (
    "My list",
    "My table",
    "My deadlines",
    "My counter",
    "My board",
)
CHART = "Open"
MESSY = "שלום עולם 🎉 " + "very long mixed שורה ארוכה " * 12


def _eq(field: str, value) -> dict:
    return {"field": field, "operator": "=", "value": value}


def _blocks() -> list:
    local = {"combinator": "and", "rules": [_eq("source.provider", "local")]}
    return [
        {
            "type": "list",
            "title": LIST,
            "query": {"source": "items", "where": local, "limit": 50},
            "viz": {"kind": "list", "visibleRows": 7},
        },
        {
            "type": "table",
            "title": TABLE,
            "query": {"source": "items", "limit": 50, "sort": [{"field": "title", "dir": "asc"}]},
            "viz": {"kind": "table"},
        },
        {"type": "deadlines", "title": DEADLINES, "query": {
            "source": "items",
            "where": {"combinator": "and", "rules": [{"field": "dueAt", "operator": "notNull"}]},
            "dateRange": "upcoming_14d",
            "dateField": "dueAt",
            "sort": [{"field": "dueAt", "dir": "asc"}],
        }, "viz": {"kind": "deadlines", "overdueOnTop": True}},
        {
            "type": "counter",
            "title": COUNTER,
            "query": {"source": "items", "aggregate": {"op": "count"}},
            "viz": {"kind": "counter"},
        },
        {
            "type": "kanban",
            "title": BOARD,
            "query": {
                "source": "items",
                "where": {
                    "combinator": "and",
                    "rules": [{"field": "source.provider", "operator": "in", "value": ["local", "jira"]}],
                },
                "groupBy": ["status"],
                "limit": 50,
            },
            "viz": {"kind": "kanban"},
        },
    ]


@pytest.fixture(scope="module")
def demo(api_base_url):
    """(user, workspace id): a new workspace with demo data and a dashboard of the data blocks."""
    user = pooled_user(api_base_url, "demo")
    forget_left_behind(api_base_url, user)
    workspace = create_workspace(
        api_base_url, user, "Data blocks", loadDemoData=True, timezone="Asia/Jerusalem"
    )
    headers = {"Authorization": f"Bearer {user.id_token}"}
    # Local to-dos with messy titles: Hebrew, emoji, 300 characters, mixed direction.
    for title in (MESSY[:300], "תשלום ארנונה 💸", "x" * 300):
        response = requests.post(
            f"{api_base_url}/private/workspaces/{workspace['id']}/items",
            json={"title": title},
            headers=headers,
            timeout=15,
        )
        assert response.status_code < 400, response.text
    main = list_dashboards(api_base_url, user, workspace["id"], "main")[0]
    draft = get_dashboard(api_base_url, user, workspace["id"], main["id"])
    apply_ops(
        api_base_url,
        user,
        workspace["id"],
        main["id"],
        draft["version"],
        [{"op": "add_block", "block": block} for block in _blocks()],
    )
    try:
        yield user, workspace["id"]
    finally:
        delete_workspace(api_base_url, user, workspace["id"])


def _open(page: Page, base_url: str, user, path: str = "/en/dashboard") -> None:
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, path)
    expect(page.get_by_role("article", name=LIST, exact=True)).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)


def _block(page: Page, title: str):
    return page.get_by_role("article", name=title, exact=True)


def _count(api_base_url: str, user, workspace_id: str) -> int:
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/query",
        json={"draft": {"source": "items", "aggregate": {"op": "count"}}},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    data = response.json()["data"]
    return data["groups"][0]["value"] if data.get("groups") else data["total"]


def test_every_block_renders_with_source_links(page: Page, base_url: str, demo):
    user, _ = demo
    _open(page, base_url, user)

    rows = _block(page, LIST).locator("li")
    assert 1 <= rows.count() <= 7
    # Every row links back to its source: a local to-do opens in the app.
    expect(_block(page, LIST).locator("[data-source-link]")).to_have_count(rows.count())
    expect(_block(page, LIST).get_by_role("checkbox")).to_have_count(rows.count())

    table = _block(page, TABLE)
    expect(table.get_by_role("columnheader", name=re.compile("Title"))).to_be_visible()
    table.get_by_role("button", name="Sort by Title").click()
    expect(table.get_by_role("columnheader", name=re.compile("Title"))).to_have_attribute(
        "aria-sort", "ascending"
    )
    expect(table.locator("tbody tr").first.locator("[data-source-link]")).to_have_count(1)

    expect(_block(page, DEADLINES).get_by_role("heading", level=3).first).to_be_visible()
    expect(_block(page, BOARD).get_by_role("heading", level=3)).to_have_count(4)


def test_counter_and_donut_agree_with_the_data(
    page: Page, base_url: str, api_base_url: str, demo
):
    user, workspace_id = demo
    _open(page, base_url, user)
    total = _count(api_base_url, user, workspace_id)
    expect(_block(page, COUNTER)).to_contain_text(f"{total:,}")

    chart = _block(page, CHART)
    cells = chart.locator("table.sr-only tbody td")
    values = [int(text) for text in cells.all_inner_texts()]
    assert values and sum(values) > 0
    # The donut's centre is the sum of its segments.
    expect(chart.locator("p.pointer-events-none")).to_contain_text(f"{sum(values):,}")


def test_legend_chip_sets_the_url_variable_and_opens_the_drill_sheet(
    page: Page, base_url: str, demo
):
    user, _ = demo
    _open(page, base_url, user)
    chart = _block(page, CHART)
    chip = chart.get_by_role("list", name="Filter by segment").get_by_role("button").first
    chip.click()
    expect(page).to_have_url(re.compile(r"[?&]provider=[a-z_]+"))
    sheet = page.get_by_role("dialog")
    expect(sheet).to_be_visible()
    expect(sheet.locator("[data-source-link]").first).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.keyboard.press("Escape")
    expect(sheet).to_have_count(0)
    expect(chip).to_have_attribute("aria-pressed", "true")
    chip.click()
    expect(page).not_to_have_url(re.compile(r"[?&]provider="))


def test_checking_a_local_todo_completes_it(page: Page, base_url: str, demo):
    user, _ = demo
    _open(page, base_url, user)
    box = _block(page, LIST).get_by_role("checkbox").first
    with page.expect_response(
        lambda r: r.url.endswith("/complete") and r.request.method == "POST"
    ) as sent:
        box.click(force=True)
    assert sent.value.request.post_data_json == {"done": True}
    expect(box).to_be_checked()


def test_only_local_cards_can_be_moved(page: Page, base_url: str, demo):
    user, _ = demo
    _open(page, base_url, user)
    board = _block(page, BOARD)
    handles = board.get_by_role("button", name=re.compile("^Move "))
    local_cards = handles.count()
    assert local_cards >= 3
    # Mirrored cards carry "Open in Jira" instead of a handle.
    expect(board.locator("[data-source-link]").first).to_be_visible()
    assert board.locator("[data-source-link]").count() > local_cards

    target = board.locator('[data-column="done"]')
    handle = handles.first
    board.scroll_into_view_if_needed()
    handle.scroll_into_view_if_needed()
    start = handle.bounding_box()
    end = target.bounding_box()
    assert start is not None and end is not None
    with page.expect_response(
        lambda r: r.request.method == "PATCH" and "/items/" in r.url
    ) as sent:
        page.mouse.move(start["x"] + start["width"] / 2, start["y"] + start["height"] / 2)
        page.mouse.down()
        page.mouse.move(end["x"] + end["width"] / 2, end["y"] + 60, steps=12)
        page.mouse.up()
    assert sent.value.request.post_data_json == {"status": "done"}
    assert sent.value.status < 400


def test_messy_titles_never_overflow_a_phone(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace_id = demo
    # Its own messy to-do, made now: the shared ones change under the tests that complete or move
    # the first card, so which rows the list shows depends on which test ran before on this worker.
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/items",
        json={"title": MESSY[:300]},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code < 400, response.text
    page.set_viewport_size(PHONE)
    open_as(page, base_url, user, "/en/dashboard")
    expect(_block(page, LIST)).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)
    expect(_block(page, LIST).get_by_text(re.compile("^שלום עולם")).first).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    scroll_width = page.evaluate("() => document.documentElement.scrollWidth")
    assert scroll_width <= PHONE["width"], f"the page scrolls sideways ({scroll_width}px)"
    # The table scrolls inside its block, not the page.
    assert page.evaluate(
        """(title) => {
          const article = [...document.querySelectorAll('article')]
            .find((a) => a.querySelector('h2')?.textContent === title);
          const scroller = article.querySelector('table').closest('div');
          return scroller.scrollWidth >= scroller.clientWidth;
        }""",
        TABLE,
    )


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def test_axe_light_english(page: Page, base_url: str, demo):
    user, _ = demo
    _open(page, base_url, user)
    _assert_clean(page)


def test_axe_dark_hebrew(page: Page, base_url: str, demo):
    user, _ = demo
    page.emulate_media(color_scheme="dark")
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/he/dashboard")
    page.evaluate("() => localStorage.setItem('todolist-ui-theme', 'dark')")
    page.reload(wait_until="load")
    expect(page.locator("article").first).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
