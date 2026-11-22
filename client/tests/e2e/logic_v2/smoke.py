"""
Logic v2 end to end (H4), on a workspace with the demo data (`loadDemoData`, loaded once per module on dev and qa):

1. build a filter with the sentence editor (the default Filter step);
2. set Importance (a custom attribute value) on an item in the item sheet;
3. switch a page's importance preset and see the order change.

Expected data comes from the API (`POST …/query`), never from the page. Each test puts back what
it changed.
"""
import pytest
import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, get_dashboard, list_dashboards
from tests.helpers.select import choose
from tests.helpers.workspaces import demo_workspace, open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT
from tests.helpers.block_editor import save_block_editor

NEW_TITLE = "E2E sentence"
OPEN_ITEMS = {
    "source": "items",
    "where": {"combinator": "and", "rules": [{"field": "status", "operator": "in", "value": ["open", "in_progress"]}]},
    "sort": [{"field": "importance", "dir": "desc"}],
    "limit": 5,
}


@pytest.fixture(scope="module")
def demo(api_base_url, pooled_demo):
    """The worker's demo workspace and its owner (each worker has its own, so saves never meet)."""
    yield from demo_workspace(api_base_url, pooled_demo)


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _query(api_base_url, user, workspace_id, body: dict) -> dict:
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/query", json=body, headers=_headers(user), timeout=15
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


def _top_titles(api_base_url, user, workspace_id, preset: str) -> list:
    # The page's own items: the settings preview is scoped to the Work page's topic.
    work = topic_id(api_base_url, user, workspace_id, "work")
    draft = {
        **OPEN_ITEMS,
        "where": {
            "combinator": "and",
            "rules": [*OPEN_ITEMS["where"]["rules"], {"field": "topic", "operator": "=", "value": work}],
        },
    }
    rows = _query(
        api_base_url, user, workspace_id, {"draft": draft, "importance": {"preset": preset, "params": {}}, "preview": True}
    )["rows"]
    return [row["title"] for row in rows]


def test_build_a_filter_with_the_sentence_editor(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    wid = workspace["id"]
    _remove_blocks_titled(api_base_url, user, wid, NEW_TITLE)

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/work")
    page.get_by_role("button", name="Edit", exact=True).click()
    page.locator("[data-add-block]").click()
    editor = page.locator('[role="dialog"][data-state="open"][data-block-editor]')
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()
    expect(editor.locator("[data-preview-total]")).to_be_visible(timeout=NORMAL_TIMEOUT)

    # The Filter step opens on the sentence, not the rule tree.
    editor.locator("[data-editor-step=filter]").click()
    sentence = editor.locator("[data-sentence-filter]")
    expect(sentence).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(sentence).to_contain_text("Show")
    expect(sentence).to_contain_text("sorted by")

    # "where [Status] [is not] [Done]"
    editor.get_by_role("button", name="Add a condition").click()
    first = editor.locator("[data-sentence-condition]").first
    choose(first.get_by_role("combobox", name="Field", exact=True), "Status")
    choose(first.get_by_role("combobox", name="Condition", exact=True), "is not")
    choose(first.get_by_role("combobox", name="Value", exact=True), "Done")

    # "and [Due] [is in the next] [7] [days]"
    editor.get_by_role("button", name="Add a condition").click()
    second = editor.locator("[data-sentence-condition]").nth(1)
    choose(second.get_by_role("combobox", name="Field", exact=True), "Due")
    expect(second.get_by_role("combobox", name="Condition", exact=True)).to_contain_text("is in the next")
    expect(second.get_by_label("Count")).to_have_value("7")
    expect(second.get_by_role("combobox", name="Unit", exact=True)).to_contain_text("days")

    # ", sorted by [Importance score]"
    choose(editor.get_by_role("combobox", name="Sorted by", exact=True), "Importance score")

    saved_query = {
        "source": "items",
        "where": {
            "combinator": "and",
            "rules": [
                {"field": "status", "operator": "!=", "value": "done"},
                {"field": "dueAt", "operator": "inNext", "value": [7, "days"]},
            ],
        },
        "sort": [{"field": "importance", "dir": "desc"}],
        "limit": 200,
    }
    expected = _query(api_base_url, user, workspace["id"], {"draft": saved_query})["total"]
    expect(editor.locator("[data-preview-total]")).to_have_attribute(
        "data-preview-total", str(expected), timeout=LONG_TIMEOUT
    )

    # Advanced shows the same filter in the rule tree, and back again.
    editor.get_by_role("button", name="Advanced").click()
    expect(editor.locator("[data-query-builder]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.get_by_role("button", name="Back to the sentence").click()
    expect(sentence).to_be_visible(timeout=NORMAL_TIMEOUT)

    editor.locator("[data-editor-step=viz]").click()
    editor.get_by_label("Title", exact=True).fill(NEW_TITLE)
    save_block_editor(page, editor)
    page.get_by_role("button", name="Done", exact=True).click()

    saved = next(b for b in _work(api_base_url, user, wid)["blocks"] if b["title"] == NEW_TITLE)
    rules = saved["query"]["where"]["rules"]
    assert {"field": "status", "operator": "!=", "value": "done"} in rules
    assert {"field": "dueAt", "operator": "inNext", "value": [7, "days"]} in rules
    assert saved["query"]["sort"][0] == {"field": "importance", "dir": "desc"}

    _remove_blocks_titled(api_base_url, user, wid, NEW_TITLE)


def test_set_importance_on_an_item(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    wid = workspace["id"]
    items = _query(api_base_url, user, wid, {"draft": {"source": "items", "limit": 1}})["rows"]
    item = items[0]
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, f"/en/t/work?item={item['id']}")
    field = page.locator("[data-item-attribute=importance]")
    expect(field).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(field).to_contain_text("Not set: counts as 3")
    field.locator("[data-attribute-rating='5']").click()
    expect(page.get_by_text("Saved", exact=False).first).to_be_visible(timeout=NORMAL_TIMEOUT)

    response = requests.get(
        f"{api_base_url}/private/workspaces/{wid}/items/{item['id']}", headers=_headers(user), timeout=15
    )
    assert response.json()["data"]["overlay"]["attrs"]["importance"] == 5

    # It is local data: a filter on the attribute finds the item; the source is untouched.
    found = _query(
        api_base_url,
        user,
        wid,
        {"draft": {"source": "items", "where": {"combinator": "and", "rules": [{"field": "attr.importance", "operator": "=", "value": 5}]}}},
    )
    assert item["id"] in [row["id"] for row in found["rows"]]

    requests.patch(
        f"{api_base_url}/private/workspaces/{wid}/items/{item['id']}/overlay",
        json={"attrs": {"importance": None}},
        headers=_headers(user),
        timeout=15,
    )


def test_switch_the_pages_importance_preset(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    wid = workspace["id"]
    dashboard = _work(api_base_url, user, wid)
    if dashboard.get("importance") is not None:
        apply_ops(api_base_url, user, wid, dashboard["id"], dashboard["version"], [{"op": "set_importance", "importance": None}])

    weighted = _top_titles(api_base_url, user, wid, "weighted")
    fair = _top_titles(api_base_url, user, wid, "fair")
    shortest = _top_titles(api_base_url, user, wid, "shortest")
    assert weighted and fair and shortest
    assert len({tuple(weighted), tuple(fair), tuple(shortest)}) > 1, "the presets should order the seeded items differently"

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/work")
    page.locator("[data-open-importance]").click()
    panel = page.locator("[data-importance-settings]")
    expect(panel).to_be_visible(timeout=NORMAL_TIMEOUT)
    preview = panel.locator("[data-importance-preview] li")

    def shown() -> list:
        return [text.rsplit("Score", 1)[0].strip() for text in preview.all_inner_texts()]

    # Weighted is the default; its explanation and sliders are there.
    expect(panel.locator("[data-importance-explanation]")).to_contain_text("You decide how much each thing matters")
    expect(panel.locator("[data-importance-weight=dueSoon]")).to_be_visible()
    expect(preview).to_have_count(len(weighted), timeout=LONG_TIMEOUT)
    assert shown() == weighted

    # The fair queue is explained with the processor analogy, and the order follows it.
    panel.locator("[data-importance-preset=fair]").click()
    expect(panel.locator("[data-importance-explanation]")).to_contain_text("processor")
    expect(panel.locator("[data-importance-weight=dueSoon]")).to_have_count(0)
    expect(preview).to_have_count(len(fair), timeout=LONG_TIMEOUT)
    for _ in range(40):
        if shown() == fair:
            break
        page.wait_for_timeout(250)
    assert shown() == fair

    panel.locator("[data-importance-save]").click()
    expect(panel).to_have_count(0, timeout=NORMAL_TIMEOUT)
    saved = _work(api_base_url, user, wid)
    assert saved["importance"] == {"preset": "fair", "params": {}}

    apply_ops(api_base_url, user, wid, saved["id"], saved["version"], [{"op": "set_importance", "importance": None}])


@pytest.mark.parametrize("language,words", [("he", ("הצג", "ממוינים לפי")), ("en", ("Show", "sorted by"))])
def test_sentence_reads_naturally_and_fits_a_phone(page: Page, base_url: str, api_base_url: str, demo, language, words):
    user, _ = demo
    page.set_viewport_size({"width": 390, "height": 844})
    open_as(page, base_url, user, f"/{language}/t/work?edit=1")
    page.locator("[data-add-block]").click()
    editor = page.locator('[role="dialog"][data-state="open"][data-block-editor]')
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()
    editor.locator("[data-editor-step=filter]").click()
    sentence = editor.locator("[data-sentence-filter]")
    expect(sentence).to_be_visible(timeout=NORMAL_TIMEOUT)
    for word in words:
        expect(sentence).to_contain_text(word)
    # The Hebrew sentence is its own order (a template), right to left: the verb first, at the
    # right edge; the English one starts at the left edge.
    text = sentence.locator("p").first
    box = text.bounding_box()
    first = text.locator("span").first.bounding_box()
    if language == "he":
        assert first["x"] + first["width"] > box["x"] + box["width"] / 2
    else:
        assert first["x"] < box["x"] + box["width"] / 2
    # Nothing spills sideways on a phone, and the controls are tappable.
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
    assert editor.evaluate("node => node.scrollWidth <= node.clientWidth + 1")
    for button in editor.locator("[data-sentence-filter] button").all():
        size = button.bounding_box()
        assert size["height"] >= 36, size
