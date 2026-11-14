"""
The block editor: a four-step Sheet with a live preview, saved as one op.

Each test owns a fresh workspace on a pooled account. Items and dashboards are set up
through the API; the editor is driven through the UI.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT, SHORT_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard
from tests.helpers.items import create_local_item
from tests.helpers.select import choose
from tests.helpers.workspaces import accept_invite, create_invite, invite_token, open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT


def _editor(page: Page):
    return page.locator("[data-block-editor]")


def _setup(api_base_url, user, workspace, titles=()):
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    if titles:
        ops = [
            {
                "op": "add_block",
                "block": {
                    "type": "list",
                    "title": title,
                    "query": {"source": "items", "limit": 10},
                    "viz": {"kind": "list", "visibleRows": 5},
                },
            }
            for title in titles
        ]
        apply_ops(api_base_url, user, workspace["id"], dashboard["id"], dashboard["version"], ops)
    return get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])


def test_add_list_block_filter_preview_and_save(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    for title, topic in (("Write report", "work"), ("Review PR", "work"), ("Buy milk", "personal")):
        create_local_item(api_base_url, user, workspace["id"], title, topic)
    _setup(api_base_url, user, workspace)
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard?edit=1")

    page.locator("[data-add-block]").click()
    editor = _editor(page)
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()

    # The preview shows every item, then only the work ones once a rule is added.
    rows = editor.locator("[data-preview-row]")
    expect(rows).to_have_count(3, timeout=NORMAL_TIMEOUT)
    editor.locator("[data-editor-step=filter]").click()
    # The sentence is the default Filter step; the rule tree is behind Advanced.
    editor.get_by_role("button", name="Advanced").click()
    editor.get_by_role("button", name="Add a rule").click()
    choose(editor.get_by_role("combobox", name="Field", exact=True).first, "Topic")
    # The topic field offers the workspace's topics, by name.
    choose(editor.get_by_role("combobox", name="Value", exact=True).first, "Work")
    expect(rows).to_have_count(2, timeout=NORMAL_TIMEOUT)

    editor.locator("[data-editor-step=viz]").click()
    editor.get_by_label("Title", exact=True).fill("Work to-dos")
    editor.locator("[data-editor-save]").click()
    expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", name="Work to-dos")).to_be_visible(timeout=NORMAL_TIMEOUT)
    dashboard = get_dashboard(api_base_url, user, workspace["id"], _setup_id(page, api_base_url, user, workspace))
    added = [b for b in dashboard["blocks"] if b["title"] == "Work to-dos"]
    assert len(added) == 1
    work = topic_id(api_base_url, user, workspace["id"], "work")
    assert added[0]["query"]["where"]["rules"][0] == {"field": "topic", "operator": "=", "value": work}


def _setup_id(page, api_base_url, user, workspace):
    from tests.helpers.dashboards import list_dashboards

    return list_dashboards(api_base_url, user, workspace["id"], "main")[0]["id"]


def test_filter_stops_at_ten_rules(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _setup(api_base_url, user, workspace)
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard?edit=1")
    page.locator("[data-add-block]").click()
    editor = _editor(page)
    editor.locator("[data-block-type=list]").click()
    editor.locator("[data-editor-step=filter]").click()
    editor.get_by_role("button", name="Advanced").click()
    add = editor.get_by_role("button", name="Add a rule")
    for _ in range(10):
        add.click()
    expect(editor.get_by_text("10 of 10 rules used")).to_be_visible()
    expect(add).to_be_disabled()


def test_edit_title_of_a_block(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    dashboard = _setup(api_base_url, user, workspace, titles=("Plain list",))
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard?edit=1")
    page.get_by_role("button", name="Options for Plain list").click()
    page.get_by_role("menuitem", name="Edit block").click()
    editor = _editor(page)
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-editor-step=viz]").click()
    editor.get_by_label("Title", exact=True).fill("Renamed list")
    editor.locator("[data-editor-save]").click()
    expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", name="Renamed list")).to_be_visible(timeout=NORMAL_TIMEOUT)
    saved = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert any(b["title"] == "Renamed list" for b in saved["blocks"])


def test_a_stale_save_keeps_the_draft_and_reapplies(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    dashboard = _setup(api_base_url, user, workspace, titles=("Plain list",))
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard?edit=1")
    page.get_by_role("button", name="Options for Plain list").click()
    page.get_by_role("menuitem", name="Edit block").click()
    editor = _editor(page)
    editor.locator("[data-editor-step=viz]").click()
    editor.get_by_label("Title", exact=True).fill("My edit")

    # Someone else changes the dashboard first.
    current = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    apply_ops(
        api_base_url, user, workspace["id"], dashboard["id"], current["version"],
        [{"op": "set_title", "title": "Changed elsewhere"}],
    )
    editor.locator("[data-editor-save]").click()
    expect(editor.locator("[data-editor-conflict]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(editor.get_by_label("Title", exact=True)).to_have_value("My edit")

    editor.get_by_role("button", name="Re-apply my changes").click()
    expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    saved = get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])
    assert saved["title"] == "Changed elsewhere"
    assert any(b["title"] == "My edit" for b in saved["blocks"])


def test_a_viewer_cannot_open_the_editor(
    page: Page, base_url: str, api_base_url: str, fresh_owner, second_user
):
    user, workspace = fresh_owner
    _setup(api_base_url, user, workspace, titles=("Plain list",))
    viewer = second_user
    invite = create_invite(api_base_url, user, workspace["id"], viewer.email, "viewer")
    accept_invite(api_base_url, viewer, invite_token(invite["inviteUrl"]))
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, viewer, "/en/dashboard?edit=1", workspace_id=workspace["id"])
    expect(page.get_by_role("heading", name="Plain list")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator("[data-add-block]")).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile("^Edit$"))).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile("Options for"))).to_have_count(0)
    expect(_editor(page)).to_have_count(0, timeout=SHORT_TIMEOUT)
