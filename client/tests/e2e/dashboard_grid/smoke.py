"""
The dashboard runtime: a dashboard made from a template, its grid, edit mode with keyboard moves
and autosave, right-to-left mirroring, viewers, and edits that race another writer (Review focus 5).

Every test owns a fresh workspace (deleted after it), so dashboards never leak between tests or
into the shared user's workspace.
"""
import re
from typing import Optional

from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import (
    apply_ops,
    block_id,
    create_dashboard,
    get_dashboard,
    layout_item,
    list_dashboards,
    overlaps,
    put_layout,
)
from tests.helpers.workspaces import (
    accept_invite,
    create_invite,
    invite_token,
    open_as,
    ensure_topics,
    topic_id,
)
from tests.helpers.users import pooled_user
from tests.viewports import DESKTOP_VIEWPORT

CONFLICT_TOAST = "This dashboard changed elsewhere. Your layout change wasn’t saved."
SAVE_FAILED_TOAST = "Your layout change wasn’t saved. Try again."
REFRESH_FAILED = "This dashboard couldn’t be refreshed. You’re seeing the last copy loaded."


def _is_layout_save(response) -> bool:
    return response.url.endswith("/layout") and response.request.method == "PUT"


def _open_dashboard(
    page: Page, base_url: str, user, path: str, blocks: int, workspace_id: Optional[str] = None
) -> None:
    """Signs in on a 1440px screen (the 12-column grid) and waits for every block frame."""
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, path, workspace_id=workspace_id)
    expect(page.get_by_role("article")).to_have_count(blocks, timeout=NORMAL_TIMEOUT)


def _box(page: Page, title: str) -> dict:
    box = page.get_by_role("article", name=title, exact=True).bounding_box()
    assert box is not None, f"{title} is not on screen"
    return box


def _join_as(api_base_url: str, owner, workspace: dict, role: str):
    """The worker's second account, after it accepted an invite to the owner's workspace."""
    member = pooled_user(api_base_url, "member")
    invite = create_invite(api_base_url, owner, workspace["id"], member.email, role=role)
    accept_invite(api_base_url, member, invite_token(invite["inviteUrl"]))
    return member


def test_main_dashboard_from_the_template(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """The title and one frame per block, one /query per data block, no edit chrome."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    queries = []
    page.on(
        "request",
        lambda request: queries.append(request.post_data_json)
        if request.method == "POST" and request.url.endswith("/query")
        else None,
    )

    _open_dashboard(page, base_url, user, "/en/dashboard", len(dashboard["blocks"]))
    expect(page.get_by_role("heading", level=1)).to_have_text("Dashboard")
    for block in dashboard["blocks"]:
        expect(page.get_by_role("article", name=block["title"], exact=True)).to_be_visible()
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("button", name="Edit", exact=True)).to_be_visible()
    expect(page.locator(".block-drag-handle")).to_have_count(0)

    data_blocks = {block["id"] for block in dashboard["blocks"] if "query" in block}
    assert sorted(query["blockId"] for query in queries) == sorted(data_blocks)
    for query in queries:
        assert query["dashboardId"] == dashboard["id"]
        assert all(name.startswith("$page.") for name in query["vars"])


def test_owner_creates_the_main_dashboard_from_the_template(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    # A workspace with one topic sends /dashboard to that topic (D1), so the main page needs two.
    ensure_topics(api_base_url, user, workspace["id"], ["work", "personal"])
    open_as(page, base_url, user, "/en/dashboard", h1="Dashboard")
    expect(page.get_by_text("Start your dashboard from a template")).to_be_visible()
    chips = page.get_by_role("list", name="Blocks in this template")
    expect(chips.get_by_role("listitem")).to_have_count(5, timeout=NORMAL_TIMEOUT)
    page.get_by_role("button", name="Create from template", exact=True).click()
    expect(page.get_by_role("article")).to_have_count(5, timeout=LONG_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_text("Dashboard")


def test_owner_creates_a_topic_page_scoped_to_the_topic(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    ensure_topics(api_base_url, user, workspace["id"], ["work", "personal"])
    open_as(page, base_url, user, "/en/t/work", h1="Work")
    page.get_by_role("button", name="Create from template", exact=True).click()
    expect(page.get_by_role("article")).to_have_count(5, timeout=LONG_TIMEOUT)
    listed = list_dashboards(api_base_url, user, workspace["id"], "work", "topic")
    assert len(listed) == 1
    assert listed[0]["scope"]["topicId"] == topic_id(api_base_url, user, workspace["id"], "work")


def test_keyboard_move_persists(page: Page, base_url: str, api_base_url: str, fresh_owner):
    """Edit mode: an arrow key moves the focused block one column; it is saved and stays."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    clock = block_id(dashboard, "Today")
    _open_dashboard(page, base_url, user, "/en/dashboard?edit=1", len(dashboard["blocks"]))

    page.get_by_role("group", name="Today").focus()
    with page.expect_response(_is_layout_save, timeout=LONG_TIMEOUT) as saved:
        page.keyboard.press("ArrowRight")
    assert saved.value.ok

    stored = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert stored["version"] == dashboard["version"] + 1
    assert layout_item(stored, "lg", clock)["x"] == 1
    assert overlaps(stored["layouts"]["lg"]) == []

    page.reload(wait_until="load")
    expect(page.get_by_role("article")).to_have_count(len(dashboard["blocks"]))
    area, today = _box(page, "Topic"), _box(page, "Today")
    assert today["x"] - area["x"] > 40, "Today starts one column in after the reload"


def test_leaving_right_after_a_move_still_saves_it(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """The autosave waits 800ms; opening another dashboard before then still saves the move
    (the next dashboard's editor opens before the save would read the draft)."""
    user, workspace = fresh_owner
    ensure_topics(api_base_url, user, workspace["id"], ["work", "personal"])
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    work = create_dashboard(
        api_base_url,
        user,
        workspace["id"],
        template="work",
        scope={"topicId": topic_id(api_base_url, user, workspace["id"], "work")},
    )
    clock = block_id(dashboard, "Today")
    # Work first, so its page shows at once later (cached), in the same render that leaves this one.
    _open_dashboard(page, base_url, user, "/en/t/work", len(work["blocks"]))
    nav = page.get_by_role("navigation", name="Main")
    nav.get_by_role("link", name="Dashboard", exact=True).click()
    expect(page.get_by_role("heading", level=1)).to_have_text("Dashboard", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("article", name="Today")).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.get_by_role("button", name="Edit", exact=True).click()

    page.get_by_role("group", name="Today").focus()
    with page.expect_response(_is_layout_save, timeout=LONG_TIMEOUT) as saved:
        page.keyboard.press("ArrowRight")
        nav.get_by_role("link", name="Work", exact=True).click()
    assert saved.value.ok
    expect(page.get_by_role("heading", level=1)).to_have_text("Work", timeout=NORMAL_TIMEOUT)
    stored = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert layout_item(stored, "lg", clock)["x"] == 1


def test_block_menu_moves_with_the_keyboard_and_returns_focus(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    _open_dashboard(page, base_url, user, "/en/dashboard?edit=1", len(dashboard["blocks"]))

    block = page.get_by_role("group", name="Today")
    block.focus()
    page.keyboard.press("Enter")
    menu = page.get_by_role("menu", name="Options for Today")
    expect(menu).to_be_visible()
    # Edit opens the block editor (T4.9).
    expect(menu.get_by_role("menuitem", name=re.compile(r"^Edit block"))).to_be_enabled()
    # Keyboard only: a mouse click on Move, then a pointer travelling to "Right", can leave the
    # submenu's grace area and close it (re-mounting its items) before the click lands.
    move_item = menu.get_by_role("menuitem", name="Move", exact=True)
    # Radix focuses the menu once it has opened, and sometimes its first item ("Move") as well, so
    # an ArrowDown could land on Move or on the item after it. Home always lands on the first item.
    expect(menu).to_be_focused()
    page.keyboard.press("Home")
    expect(move_item).to_be_focused()
    page.keyboard.press("ArrowRight")
    move = page.get_by_role("menu", name="Move", exact=True)
    expect(move).to_be_visible()
    expect(move.get_by_role("menuitem").first).to_be_focused()
    expect(move.get_by_role("menuitem", name="Left", exact=True)).to_be_disabled()
    right = move.get_by_role("menuitem", name="Right", exact=True)
    # Up, Down, Left (disabled, skipped), Right: one key at a time, each waits for its focus.
    page.keyboard.press("ArrowDown")
    expect(move.get_by_role("menuitem", name="Down", exact=True)).to_be_focused()
    page.keyboard.press("ArrowDown")
    expect(right).to_be_focused()
    with page.expect_response(_is_layout_save, timeout=LONG_TIMEOUT):
        page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    expect(menu).to_have_count(0)
    expect(block).to_be_focused()


def test_remove_block_asks_first(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    _open_dashboard(page, base_url, user, "/en/dashboard?edit=1", len(dashboard["blocks"]))

    page.get_by_role("button", name="Options for Deadlines").click()
    page.get_by_role("menuitem", name="Remove", exact=True).click()
    dialog = page.get_by_role("alertdialog", name="Remove “Deadlines”?")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Cancel", exact=True).click()
    expect(page.get_by_role("article")).to_have_count(len(dashboard["blocks"]))

    page.get_by_role("button", name="Options for Deadlines").click()
    page.get_by_role("menuitem", name="Remove", exact=True).click()
    # The removal is not optimistic: the block leaves when the server's answer lands, so wait for
    # that answer (a slow API under load took longer than an assertion's default 5s).
    with page.expect_response(
        lambda r: r.url.endswith("/ops") and r.request.method == "POST", timeout=LONG_TIMEOUT
    ) as removed:
        page.get_by_role("alertdialog").get_by_role(
            "button", name="Remove block", exact=True
        ).click()
    assert removed.value.ok
    expect(page.get_by_role("article")).to_have_count(len(dashboard["blocks"]) - 1)
    expect(page.get_by_role("article", name="Deadlines")).to_have_count(0)

    stored = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert "Deadlines" not in [block["title"] for block in stored["blocks"]]
    # Undo brings it back (the server's undo, then the fresh draft).
    page.get_by_role("button", name="Undo", exact=True).click()
    expect(page.get_by_role("article", name="Deadlines")).to_be_visible(timeout=LONG_TIMEOUT)


def test_viewer_gets_no_edit_mode(page: Page, base_url: str, api_base_url: str, fresh_owner):
    """A viewer never sees the Edit toggle, handles or menus; ?edit=1 just shows the dashboard."""
    owner, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, owner, workspace["id"])
    viewer = _join_as(api_base_url, owner, workspace, "viewer")

    _open_dashboard(
        page, base_url, viewer, "/en/dashboard", len(dashboard["blocks"]), workspace["id"]
    )
    expect(page.get_by_role("button", name="Edit", exact=True)).to_have_count(0)

    page.goto(f"{base_url}/en/dashboard?edit=1", wait_until="load")
    expect(page.get_by_role("article")).to_have_count(len(dashboard["blocks"]), timeout=NORMAL_TIMEOUT)
    expect(page.locator(".block-drag-handle")).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile(r"^Options for "))).to_have_count(0)
    expect(page.get_by_role("group", name="Today")).to_have_count(0)
    for name in ("Done", "Undo", "Redo", "Edit"):
        expect(page.get_by_role("button", name=name, exact=True)).to_have_count(0)


def test_viewer_without_a_dashboard_sees_a_quiet_state(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    owner, workspace = fresh_owner
    ensure_topics(api_base_url, owner, workspace["id"], ["work", "personal"])
    viewer = _join_as(api_base_url, owner, workspace, "viewer")
    open_as(page, base_url, viewer, "/en/dashboard", h1="Dashboard", workspace_id=workspace["id"])
    expect(page.get_by_text("Nothing here yet")).to_be_visible()
    expect(page.get_by_role("button", name="Create from template", exact=True)).to_have_count(0)


def test_editor_sees_that_changes_wait_for_an_owner(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    owner, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, owner, workspace["id"])
    editor = _join_as(api_base_url, owner, workspace, "editor")
    _open_dashboard(
        page, base_url, editor, "/en/dashboard?edit=1", len(dashboard["blocks"]), workspace["id"]
    )
    note = page.get_by_text("Draft, waiting for an owner to publish")
    expect(note).to_have_count(0)

    page.get_by_role("group", name="Today").focus()
    with page.expect_response(_is_layout_save, timeout=LONG_TIMEOUT):
        page.keyboard.press("ArrowRight")
    expect(note).to_be_visible()
    stored = get_dashboard(api_base_url, owner, workspace["id"], dashboard["id"])
    assert stored["publishedVersion"] == dashboard["version"], "an editor's change waits"


def test_rtl_mirrors_the_layout(page: Page, base_url: str, api_base_url: str, fresh_owner):
    """Stored left-to-right, shown mirrored in Hebrew: x' = cols − x − w."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    blocks = len(dashboard["blocks"])

    _open_dashboard(page, base_url, user, "/en/dashboard", blocks)
    area, today, deadlines = _box(page, "Topic"), _box(page, "Today"), _box(page, "Deadlines")
    assert abs(today["x"] - area["x"]) < 2, "the clock leads the row on the left"
    assert abs(deadlines["x"] + deadlines["width"] - area["x"] - area["width"]) < 2

    page.goto(f"{base_url}/he/dashboard", wait_until="load")
    expect(page.locator("html")).to_have_attribute("dir", "rtl")
    expect(page.get_by_role("article")).to_have_count(blocks, timeout=NORMAL_TIMEOUT)
    area, today, deadlines = _box(page, "Topic"), _box(page, "Today"), _box(page, "Deadlines")
    assert abs(today["x"] + today["width"] - area["x"] - area["width"]) < 2, (
        "the clock leads the row on the right"
    )
    assert abs(deadlines["x"] - area["x"]) < 2


def test_concurrent_layout_change_is_reapplied(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """Another writer changed the layout meanwhile: 409, refetch, my move re-applied, no toast."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    area_id, clock = block_id(dashboard, "Topic"), block_id(dashboard, "Today")
    _open_dashboard(page, base_url, user, "/en/dashboard?edit=1", len(dashboard["blocks"]))

    # Behind the page: the Area block grows a row (version 2).
    area = layout_item(dashboard, "lg", area_id)
    put_layout(
        api_base_url,
        user,
        workspace["id"],
        dashboard["id"],
        dashboard["version"],
        {"lg": [{**area, "h": area["h"] + 1}]},
    )

    statuses = []
    page.on("response", lambda response: statuses.append(response.status) if _is_layout_save(response) else None)
    page.get_by_role("group", name="Today").focus()
    with page.expect_response(
        lambda response: _is_layout_save(response) and response.ok, timeout=LONG_TIMEOUT
    ):
        page.keyboard.press("ArrowRight")

    assert statuses[:1] == [409], statuses
    stored = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert stored["version"] == dashboard["version"] + 2
    assert layout_item(stored, "lg", area_id)["h"] == area["h"] + 1, "their change stays"
    assert layout_item(stored, "lg", clock)["x"] == 1, "mine is re-applied"
    assert overlaps(stored["layouts"]["lg"]) == []
    expect(page.get_by_text(CONFLICT_TOAST)).to_have_count(0)
    expect(page.get_by_role("article")).to_have_count(len(dashboard["blocks"]))


def test_concurrent_removal_drops_my_change_with_a_toast(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """The block I move was removed meanwhile: my change is dropped, a toast says so, and the
    grid shows the fresh copy, whole."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    clock = block_id(dashboard, "Today")
    _open_dashboard(page, base_url, user, "/en/dashboard?edit=1", len(dashboard["blocks"]))

    apply_ops(
        api_base_url,
        user,
        workspace["id"],
        dashboard["id"],
        dashboard["version"],
        [{"op": "remove_block", "blockId": clock}],
    )

    page.get_by_role("group", name="Today").focus()
    page.keyboard.press("ArrowRight")
    expect(page.get_by_text(CONFLICT_TOAST)).to_be_visible(timeout=LONG_TIMEOUT)
    expect(page.get_by_role("article")).to_have_count(len(dashboard["blocks"]) - 1)
    expect(page.get_by_role("article", name="Today")).to_have_count(0)

    stored = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert stored["version"] == dashboard["version"] + 1, "nothing of mine was written"
    assert overlaps(stored["layouts"]["lg"]) == []


def test_a_failed_save_and_refresh_keep_the_grid(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """The save fails and so does the reload after it: the move is taken back with a toast, the
    grid stays (no error page) with a quiet note, and Try again reloads it."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    blocks = len(dashboard["blocks"])
    _open_dashboard(page, base_url, user, "/en/dashboard?edit=1", blocks)
    start = _box(page, "Today")["x"]

    def refuse_saves(route):
        if route.request.method == "PUT":
            route.fulfill(status=500, json={"message": "down"})
        else:
            route.continue_()

    draft = re.compile(r".*/dashboards/[^/?]+\?as=draft$")
    page.route(re.compile(r".*/layout$"), refuse_saves)
    page.route(draft, lambda route: route.fulfill(status=500, json={"message": "down"}))

    page.get_by_role("group", name="Today").focus()
    page.keyboard.press("ArrowRight")
    expect(page.get_by_text(SAVE_FAILED_TOAST)).to_be_visible(timeout=LONG_TIMEOUT)
    note = page.get_by_role("status").filter(has_text=REFRESH_FAILED)
    expect(note).to_be_visible(timeout=LONG_TIMEOUT)
    expect(page.get_by_role("article")).to_have_count(blocks)
    expect(page.get_by_text("This dashboard couldn’t be loaded.")).to_have_count(0)
    assert abs(_box(page, "Today")["x"] - start) < 2, "the move was taken back"

    page.unroute(draft)
    note.get_by_role("button", name="Try again", exact=True).click()
    expect(note).to_have_count(0, timeout=LONG_TIMEOUT)
    stored = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert stored["version"] == dashboard["version"], "nothing was saved"
