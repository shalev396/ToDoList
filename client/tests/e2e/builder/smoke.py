"""
The dashboard builder end to end, on a workspace with the demo data (`loadDemoData`, loaded once
per module through the API on dev and qa).

Connectors, ordering and logic are driven through the editor UI; the expected numbers come from the
API (`POST …/query`) and never from the page. Each test removes the blocks it adds.
"""
import re

import pytest
import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.select import choose
from tests.helpers.dashboards import apply_ops, get_dashboard, list_dashboards
from tests.helpers.workspaces import demo_workspace, open_as
from tests.viewports import DESKTOP_VIEWPORT

NEW_TITLE = "E2E tasks"
PROVIDER_LABELS = {
    "jira": "Jira",
    "clickup": "ClickUp",
    "linear": "Linear",
    "moodle": "Moodle",
    "google_drive": "Google Drive",
    "google_calendar": "Google Calendar",
    "github": "GitHub",
}


@pytest.fixture(scope="module")
def demo(api_base_url):
    """The worker's demo workspace and its owner (each worker has its own, so saves never meet)."""
    yield from demo_workspace(api_base_url)


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _integrations(api_base_url, user, workspace_id) -> list:
    response = requests.get(
        f"{api_base_url}/private/workspaces/{workspace_id}/integrations", headers=_headers(user), timeout=15
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _query(api_base_url, user, workspace_id, draft: dict, connectors=None) -> dict:
    """POST …/query with a draft; `connectors`: the block's sources (PERMISSIONS-V2)."""
    body = {"draft": draft} if not connectors else {"draft": draft, "connectors": connectors}
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/query",
        json=body,
        headers=_headers(user),
        timeout=15,
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _work(api_base_url, user, workspace_id) -> dict:
    page = list_dashboards(api_base_url, user, workspace_id, "work", "topic")[0]
    return get_dashboard(api_base_url, user, workspace_id, page["id"])


def _remove_blocks_titled(api_base_url, user, workspace_id, title: str) -> dict:
    dashboard = _work(api_base_url, user, workspace_id)
    ops = [{"op": "remove_block", "blockId": b["id"]} for b in dashboard["blocks"] if b["title"] == title]
    if ops:
        apply_ops(api_base_url, user, workspace_id, dashboard["id"], dashboard["version"], ops)
    return _work(api_base_url, user, workspace_id)


def _rank(status: str) -> int:
    return ["open", "in_progress", "done", "cancelled"].index(status)


def _open_work_editing(page, base_url, user):
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/work")
    page.get_by_role("button", name="Edit", exact=True).click()


def _block(page: Page, block_id: str):
    return page.locator(f'[data-block-id="{block_id}"]')


def test_build_a_connector_list_block(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    wid = workspace["id"]
    _remove_blocks_titled(api_base_url, user, wid, NEW_TITLE)
    integrations = _integrations(api_base_url, user, wid)
    labels = {i["provider"]: i["accountLabel"] for i in integrations}
    ids = {i["provider"]: i["id"] for i in integrations}

    _open_work_editing(page, base_url, user)
    add_block = page.locator("[data-add-block]")
    expect(add_block).to_be_enabled(timeout=NORMAL_TIMEOUT)
    add_block.click()
    # The editor is a Radix dialog: wait for its open state, not just for the node to exist.
    editor = page.locator('[role="dialog"][data-state="open"][data-block-editor]')
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()

    # Source: every connected account, with its label; the preview narrows live as they are picked.
    total_all = editor.locator("[data-preview-total]")
    expect(total_all).to_be_visible(timeout=NORMAL_TIMEOUT)
    everything = int(total_all.get_attribute("data-preview-total"))
    connectors = editor.locator("[data-connectors]")
    expect(connectors.locator("[data-connector-label]")).to_have_count(len(integrations))
    connectors.get_by_label(labels["clickup"], exact=True).check()
    connectors.get_by_label(labels["jira"], exact=True).check()
    both = _query(api_base_url, user, wid, {"source": "items"}, [ids["clickup"], ids["jira"]])["total"]
    assert 0 < both < everything
    expect(total_all).to_have_attribute("data-preview-total", str(both), timeout=NORMAL_TIMEOUT)

    # Filter: status is not done.
    editor.locator("[data-editor-step=filter]").click()
    # The sentence is the default Filter step; the rule tree is behind Advanced.
    editor.get_by_role("button", name="Advanced").click()
    editor.get_by_role("button", name="Add a rule").click()
    # Connectors are the block's own field (PERMISSIONS-V2): this is the first rule.
    choose(editor.get_by_role("combobox", name="Field", exact=True).last, "Status")
    choose(editor.get_by_role("combobox", name="Condition", exact=True).last, "is not")
    choose(editor.get_by_role("combobox", name="Value", exact=True).last, "done")

    # Sort by status.
    editor.locator("[data-editor-step=group]").click()
    editor.get_by_role("button", name="Add a sort").click()
    choose(editor.get_by_role("combobox", name="Field", exact=True).last, "Status")
    choose(editor.get_by_role("combobox", name="Direction", exact=True).last, "Ascending")

    editor.locator("[data-editor-step=viz]").click()
    editor.get_by_label("Title", exact=True).fill(NEW_TITLE)
    editor.locator("[data-editor-save]").click()
    expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    page.get_by_role("button", name="Done", exact=True).click()

    saved = next(b for b in _work(api_base_url, user, wid)["blocks"] if b["title"] == NEW_TITLE)
    assert sorted(saved["connectors"]) == sorted([ids["clickup"], ids["jira"]])
    rules = saved["query"]["where"]["rules"]
    assert rules == [{"field": "status", "operator": "!=", "value": "done"}]
    assert saved["query"]["sort"][0] == {"field": "status", "dir": "asc"}

    expected = _query(api_base_url, user, wid, {**saved["query"], "limit": 200}, saved["connectors"])
    statuses = [row["status"] for row in expected["rows"]]
    assert "done" not in statuses
    assert {row["source"]["provider"] for row in expected["rows"]} == {"clickup", "jira"}
    assert [_rank(s) for s in statuses] == sorted(_rank(s) for s in statuses)

    # The block shows exactly the API's matching count; every row links back to its source.
    block = _block(page, saved["id"])
    expect(block).to_be_visible(timeout=NORMAL_TIMEOUT)
    show_all = block.get_by_role("button", name=re.compile(r"^Show all"))
    expect(show_all).to_have_text(f"Show all {expected['total']}", timeout=LONG_TIMEOUT)
    show_all.click()
    sheet = page.get_by_role("dialog")
    rows = sheet.locator("li")
    expect(rows).to_have_count(expected["total"], timeout=NORMAL_TIMEOUT)
    links = sheet.locator("a[data-source-link], a[href][aria-label^='Open']")
    expect(links).to_have_count(expected["total"])
    first_title = expected["rows"][0]["title"]
    expect(rows.first).to_contain_text(first_title[:20])
    page.screenshot(path="screens/n4/builder-list-connectors.png")

    _remove_blocks_titled(api_base_url, user, wid, NEW_TITLE)


def test_edit_an_existing_block_filter_priority_at_least_high(
    page: Page, base_url: str, api_base_url: str, demo
):
    user, workspace = demo
    wid = workspace["id"]
    _remove_blocks_titled(api_base_url, user, wid, NEW_TITLE)
    dashboard = _work(api_base_url, user, wid)
    tasks = next(b for b in dashboard["blocks"] if b["title"] == "Tasks")
    # Start from the seeded query every time (an earlier run may have saved a filter). The block
    # reads its connectors, ClickUp and Jira (PERMISSIONS-V2: a block field, not a rule).
    seeded = {k: v for k, v in tasks["query"].items() if k != "where"}
    connectors = tasks["connectors"]
    apply_ops(
        api_base_url, user, wid, dashboard["id"], dashboard["version"],
        [{"op": "update_block", "blockId": tasks["id"], "patch": {"query": seeded}}],
    )
    before = _query(api_base_url, user, wid, {**seeded, "limit": 200}, connectors)["total"]
    high = {**seeded, "limit": 200, "where": {"combinator": "and", "rules": [{"field": "priority", "operator": ">=", "value": 3}]}}
    after = _query(api_base_url, user, wid, high, connectors)["total"]
    assert 0 < after < before

    _open_work_editing(page, base_url, user)
    page.get_by_role("button", name="Options for Tasks").click()
    page.get_by_role("menuitem", name="Edit block").click()
    editor = page.locator("[data-block-editor]")
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(editor.locator("[data-preview-total]")).to_have_attribute(
        "data-preview-total", str(before), timeout=NORMAL_TIMEOUT
    )
    editor.locator("[data-editor-step=filter]").click()
    # The sentence is the default Filter step; the rule tree is behind Advanced.
    editor.get_by_role("button", name="Advanced").click()
    editor.get_by_role("button", name="Add a rule").click()
    choose(editor.get_by_role("combobox", name="Field", exact=True).last, "Priority")
    choose(editor.get_by_role("combobox", name="Condition", exact=True).last, "is at least")
    editor.get_by_label("Value").last.fill("3")
    expect(editor.locator("[data-preview-total]")).to_have_attribute(
        "data-preview-total", str(after), timeout=NORMAL_TIMEOUT
    )
    editor.locator("[data-editor-save]").click()
    expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    page.get_by_role("button", name="Done", exact=True).click()

    block = _block(page, tasks["id"])
    shown = after if after <= 7 else 7
    expect(block.locator("li")).to_have_count(shown, timeout=NORMAL_TIMEOUT)
    if after > 7:
        expect(block.get_by_role("button", name=re.compile(r"^Show all"))).to_have_text(f"Show all {after}")

    # Put the seeded query back.
    fresh = _work(api_base_url, user, wid)
    apply_ops(
        api_base_url, user, wid, fresh["id"], fresh["version"],
        [{"op": "update_block", "blockId": tasks["id"], "patch": {"query": seeded}}],
    )


@pytest.mark.parametrize("provider", sorted(PROVIDER_LABELS))
def test_every_provider_appears_on_the_seeded_main_dashboard(
    page: Page, base_url: str, api_base_url: str, demo, provider: str
):
    user, workspace = demo
    wid = workspace["id"]
    label = PROVIDER_LABELS[provider]
    counts = _query(
        api_base_url,
        user,
        wid,
        {
            "source": "items",
            "where": {"combinator": "and", "rules": [{"field": "status", "operator": "in", "value": ["open", "in_progress"]}]},
            "groupBy": ["source.provider"],
            "aggregate": {"op": "count"},
        },
    )["groups"]
    expected = next(g["value"] for g in counts if g["key"].get("source.provider") == provider)
    assert expected > 0

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    legend = page.get_by_role("row", name=re.compile(rf"^{re.escape(label)}\s+\d+$"))
    expect(legend).to_have_count(1, timeout=LONG_TIMEOUT)
    expect(legend).to_contain_text(str(expected))


def test_source_step_with_connectors_has_no_axe_violations(page: Page, base_url: str, api_base_url: str, demo):
    from axe_playwright_python.sync_playwright import Axe

    from tests.helpers.animations import wait_for_fade_in

    user, _workspace = demo
    _open_work_editing(page, base_url, user)
    page.locator("[data-add-block]").click()
    editor = page.locator("[data-block-editor]")
    editor.locator("[data-block-type=list]").click()
    expect(editor.locator("[data-connectors]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    wait_for_fade_in(page)
    violations = Axe().run(page, context="[data-block-editor]").response.get("violations", [])
    assert violations == [], [(v["id"], [n["target"] for n in v["nodes"]]) for v in violations]
