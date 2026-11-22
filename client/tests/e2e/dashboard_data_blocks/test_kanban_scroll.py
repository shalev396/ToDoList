"""
The board (kanban) block: each column scrolls on its own. A long Done column scrolls without moving
the other columns, the block or the page; a card dropped on a scrolled column still lands in it; on
a phone every column is capped and the page scrolls on to the next one.

One workspace per module (30 local to-dos, 24 of them done) with a board, deleted at its end.
"""
import pytest
import requests
from playwright.sync_api import Page, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard
from tests.helpers.items import create_local_item, list_items
from tests.helpers.workspaces import create_workspace, delete_workspace, forget_left_behind, open_as
from tests.viewports import DESKTOP_VIEWPORT

IPHONE = {"width": 393, "height": 852}
BOARD = "Scroll board"
TOTAL, DONE = 30, 24


@pytest.fixture(scope="module")
def board(api_base_url, pooled_kanban_scroll):
    """(user, workspace id): 30 local to-dos, 24 completed, and a board over them."""
    user = pooled_kanban_scroll
    forget_left_behind(api_base_url, user)
    workspace = create_workspace(api_base_url, user, "Kanban scroll", timezone="Asia/Jerusalem")
    headers = {"Authorization": f"Bearer {user.id_token}"}
    for number in range(TOTAL):
        item = create_local_item(api_base_url, user, workspace["id"], f"Card {number:02d}")
        if number < DONE:
            response = requests.post(
                f"{api_base_url}/private/workspaces/{workspace['id']}/items/{item['id']}/complete",
                json={"done": True},
                headers=headers,
                timeout=15,
            )
            assert response.status_code < 400, response.text
    main = create_dashboard(api_base_url, user, workspace["id"])
    draft = get_dashboard(api_base_url, user, workspace["id"], main["id"])
    apply_ops(
        api_base_url,
        user,
        workspace["id"],
        main["id"],
        draft["version"],
        [
            {
                "op": "add_block",
                "block": {
                    "type": "kanban",
                    "title": BOARD,
                    "query": {
                        "source": "items",
                        "where": {
                            "combinator": "and",
                            "rules": [{"field": "source.provider", "operator": "=", "value": "local"}],
                        },
                        "groupBy": ["status"],
                        "limit": 100,
                    },
                    "viz": {"kind": "kanban"},
                },
            }
        ],
    )
    try:
        yield user, workspace["id"]
    finally:
        delete_workspace(api_base_url, user, workspace["id"])


def _open(page: Page, base_url: str, user, viewport: dict):
    page.set_viewport_size(viewport)
    open_as(page, base_url, user, "/en/dashboard")
    block = page.get_by_role("article", name=BOARD, exact=True)
    expect(block).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=APP_REQUEST_TIMEOUT)
    return block


def _viewport(block, column: str):
    return block.locator(f'[data-column-viewport="{column}"]')


def test_done_scrolls_alone(page: Page, base_url: str, board):
    user, _ = board
    block = _open(page, base_url, user, DESKTOP_VIEWPORT)
    done, opened = _viewport(block, "done"), _viewport(block, "open")
    expect(done.locator("li").first).to_be_visible()
    metrics = done.evaluate("el => ({ scroll: el.scrollHeight, client: el.clientHeight })")
    assert metrics["scroll"] > metrics["client"]

    block.scroll_into_view_if_needed()
    page_scroll = page.evaluate("window.scrollY")
    done.evaluate("el => { el.scrollTop = 400; }")
    assert done.evaluate("el => el.scrollTop") > 0
    assert opened.evaluate("el => el.scrollTop") == 0
    assert page.evaluate("window.scrollY") == page_scroll
    # The block never scrolls: the Done header is still inside it.
    header = block.get_by_role("heading", level=3).filter(has_text="Done")
    head_box, block_box = header.bounding_box(), block.bounding_box()
    assert head_box is not None and block_box is not None
    assert head_box["y"] >= block_box["y"]
    assert head_box["y"] + head_box["height"] <= block_box["y"] + block_box["height"]


def test_drop_on_a_scrolled_column(page: Page, base_url: str, api_base_url: str, board):
    user, workspace_id = board
    block = _open(page, base_url, user, DESKTOP_VIEWPORT)
    done = _viewport(block, "done")
    done.evaluate("el => { el.scrollTop = el.scrollHeight; }")
    handle = _viewport(block, "open").get_by_role("button", name="Move ", exact=False).first
    block.scroll_into_view_if_needed()
    start, target = handle.bounding_box(), done.bounding_box()
    assert start is not None and target is not None
    with page.expect_response(
        lambda r: r.request.method == "PATCH" and "/items/" in r.url
    ) as sent:
        page.mouse.move(start["x"] + start["width"] / 2, start["y"] + start["height"] / 2)
        page.mouse.down()
        page.mouse.move(
            target["x"] + target["width"] / 2, target["y"] + target["height"] / 2, steps=12
        )
        page.mouse.up()
    assert sent.value.status == 200
    moved = sent.value.url.rsplit("/", 1)[-1]
    status = next(i["status"] for i in list_items(api_base_url, user, workspace_id) if i["id"] == moved)
    assert status == "done"


def test_phone_columns_are_capped(page: Page, base_url: str, board):
    user, _ = board
    block = _open(page, base_url, user, IPHONE)
    columns = block.locator("[data-column-viewport]")
    assert columns.count() == 4
    for index in range(columns.count()):
        box = columns.nth(index).bounding_box()
        assert box is not None and box["height"] <= 0.6 * IPHONE["height"] + 1
    done = _viewport(block, "done")
    metrics = done.evaluate("el => ({ scroll: el.scrollHeight, client: el.clientHeight })")
    assert metrics["scroll"] > metrics["client"]
    done.evaluate("el => { el.scrollTop = 300; }")
    assert done.evaluate("el => el.scrollTop") > 0
    # The page scrolls on to the column after Done.
    after = _viewport(block, "cancelled")
    after.scroll_into_view_if_needed()
    expect(after).to_be_in_viewport()
