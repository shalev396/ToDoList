"""
Page views, the page-variables panel and persona templates (H3, H6), on a fresh workspace each:

1. add a List view from "+ Add view" (Custom);
2. add a view from a template ("This week");
3. the Summary can't be removed, renamed or moved;
4. the page-variables panel shows while editing, lists a variable with where it is set and what
   listens to it, clears it, and collapses on a phone;
5. instantiate "Light student" (and again: nothing is duplicated).

What the page should hold is read back through the API, never from the page.
"""
import re

import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard, list_dashboards
from tests.helpers.workspaces import list_topics, open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT

PHONE_VIEWPORT = {"width": 375, "height": 800}


def _work_page(api_base_url, user, workspace_id) -> dict:
    """A Work page from the template, on the workspace's Work topic."""
    scope = {"topicId": topic_id(api_base_url, user, workspace_id, "work")}
    create_dashboard(api_base_url, user, workspace_id, template="work", scope=scope)
    page = list_dashboards(api_base_url, user, workspace_id, "work", "topic")[0]
    return get_dashboard(api_base_url, user, workspace_id, page["id"])


def _open_work(page: Page, base_url: str, user, query: str = "") -> None:
    open_as(page, base_url, user, f"/en/t/work{query}", h1="Work")
    expect(page.get_by_role("article").first).to_be_visible(timeout=LONG_TIMEOUT)


def test_owner_adds_a_list_view(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    work = _work_page(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    _open_work(page, base_url, user)

    # The Summary is the first and open tab.
    tabs = page.get_by_role("tab")
    expect(tabs.first).to_have_text("Summary")
    expect(tabs.first).to_have_attribute("aria-selected", "true")

    page.locator("[data-add-view]").click()
    dialog = page.get_by_role("dialog", name="Add a view")
    expect(dialog).to_be_visible(timeout=NORMAL_TIMEOUT)
    dialog.locator('[data-view-type="list"]').click()
    dialog.locator("[data-add-view-submit]").click()

    # The new view opens at once: its tab is selected and it is one full-page list block.
    expect(page).to_have_url(re.compile(r"[?&]view=vw_"), timeout=LONG_TIMEOUT)
    expect(page.locator('[data-view-tab]').nth(1)).to_have_text("List")
    expect(page.locator("[data-rigid-view='list']")).to_be_visible(timeout=LONG_TIMEOUT)

    # "+ Add" in the list opens the New to-do sheet on this page; the new row appears.
    add = page.locator("[data-rigid-view='list'] [data-list-add]")
    expect(add).to_be_visible(timeout=LONG_TIMEOUT)
    add.click()
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    sheet.get_by_label("Title").fill("Plan the week from a view")
    sheet.locator("[data-new-todo-save]").click()
    expect(page.locator("[data-rigid-view='list']").get_by_text("Plan the week from a view")).to_be_visible(
        timeout=LONG_TIMEOUT
    )

    saved = get_dashboard(api_base_url, user, workspace["id"], work["id"])
    assert [view["type"] for view in saved["views"]] == ["list"]
    (view,) = saved["views"]
    (block_id,) = view["blockIds"]
    block = next(b for b in saved["blocks"] if b["id"] == block_id)
    assert block["type"] == "list"
    # The Summary is untouched: the view's block has no place on its grid.
    assert all(item["i"] != block_id for item in saved["layouts"]["lg"])
    assert len(saved["blocks"]) == len(work["blocks"]) + 1


def test_owner_adds_a_view_from_a_template(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    work = _work_page(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    _open_work(page, base_url, user)

    page.locator("[data-add-view]").click()
    dialog = page.get_by_role("dialog", name="Add a view")
    dialog.locator('[data-add-view-mode="template"]').click()
    dialog.locator('[data-view-template="this-week@1"]').click()
    dialog.locator("[data-add-view-submit]").click()

    expect(page).to_have_url(re.compile(r"[?&]view=vw_"), timeout=LONG_TIMEOUT)
    expect(page.locator("[data-view-tab]").nth(1)).to_have_text("This week")
    expect(page.locator("[data-rigid-view='timeline']")).to_be_visible(timeout=LONG_TIMEOUT)

    saved = get_dashboard(api_base_url, user, workspace["id"], work["id"])
    assert [(view["type"], view["templateKey"]) for view in saved["views"]] == [
        ("timeline", "this-week@1")
    ]
    # A page of a topic: the view reads that topic.
    assert saved["vars"]["topic"] == topic_id(api_base_url, user, workspace["id"], "work")


def test_the_summary_cannot_be_removed(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    work = _work_page(api_base_url, user, workspace["id"])
    apply_ops(
        api_base_url, user, workspace["id"], work["id"], work["version"], [{"op": "add_view", "type": "table"}]
    )
    page.set_viewport_size(DESKTOP_VIEWPORT)
    _open_work(page, base_url, user, "?edit=1")

    # Summary stays first, whatever views follow.
    expect(page.locator("[data-view-tab]").first).to_have_text("Summary")
    page.locator('[data-view-menu="summary"]').click()
    menu = page.get_by_role("menu")
    expect(menu).to_contain_text("always first")
    expect(menu.get_by_role("menuitem", name="Remove view")).to_have_attribute("aria-disabled", "true")
    expect(menu.get_by_role("menuitem", name="Rename")).to_have_attribute("aria-disabled", "true")
    page.keyboard.press("Escape")

    # Another view can be removed, with a confirmation.
    page.locator("[data-view-tab]").nth(1).click()
    page.locator("[data-view-menu]").first.click()
    page.get_by_role("menuitem", name="Remove view").click()
    page.locator("[data-view-remove-confirm]").click()
    expect(page.locator("[data-view-tab]")).to_have_count(1, timeout=LONG_TIMEOUT)

    # The server holds the same rule: the Summary has no id to remove.
    saved = get_dashboard(api_base_url, user, workspace["id"], work["id"])
    assert saved["views"] == []
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace['id']}/dashboards/{work['id']}/ops",
        json={"expectedVersion": saved["version"], "ops": [{"op": "remove_view", "viewId": "summary"}]},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code == 400


def test_the_variables_panel_shows_while_editing(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _work_page(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    _open_work(page, base_url, user)
    # Not while viewing.
    expect(page.locator("[data-page-vars-panel]")).to_have_count(0)

    open_as(page, base_url, user, "/en/t/work?edit=1&range=next_7d", h1="Work")
    panel = page.locator("[data-page-vars-panel]")
    expect(panel).to_be_visible(timeout=LONG_TIMEOUT)
    topic = panel.locator('[data-page-var="topic"]')
    expect(topic).to_contain_text("$page.topic")
    expect(topic.locator("[data-page-var-origin]")).to_have_attribute("data-page-var-origin", "route")
    # Where it is set, and what listens to it.
    expect(topic).to_contain_text("Used by:")

    range_ = panel.locator('[data-page-var="range"]')
    expect(range_.locator("[data-page-var-value]")).to_have_text("next_7d")
    expect(range_.locator("[data-page-var-origin]")).to_have_attribute("data-page-var-origin", "url")
    range_.locator("[data-page-var-clear]").click()
    expect(range_.locator("[data-page-var-value]")).to_have_text("Not set")
    expect(page).not_to_have_url(re.compile(r"range=next_7d"))
    # The route's variable can't be cleared here.
    expect(topic.locator("[data-page-var-clear]")).to_be_disabled()


def test_the_variables_panel_collapses_on_a_phone(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _work_page(api_base_url, user, workspace["id"])
    page.set_viewport_size(PHONE_VIEWPORT)
    open_as(page, base_url, user, "/en/t/work?edit=1", h1="Work")
    toggle = page.locator("[data-page-vars-toggle]")
    expect(toggle).to_be_visible(timeout=LONG_TIMEOUT)
    expect(toggle).to_have_attribute("aria-expanded", "false")
    expect(page.locator("#page-vars-body")).to_be_hidden()
    toggle.click()
    expect(toggle).to_have_attribute("aria-expanded", "true")
    expect(page.locator("#page-vars-body")).to_be_visible()


def test_owner_instantiates_light_student(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/templates", h1="Templates")

    gallery = page.locator("[data-persona-gallery]")
    expect(gallery).to_be_visible(timeout=LONG_TIMEOUT)
    # Smallest first.
    assert gallery.locator("[data-persona]").evaluate_all("els => els.map(e => e.dataset.persona)") == [
        "light-student@1",
        "two-jobs-studies-side-project@1",
        "student-job@1",
    ]
    card = gallery.locator('[data-persona="light-student@1"]')
    card.locator("[data-persona-use]").click()

    # No connections to share on a fresh workspace: it goes straight through to the page.
    expect(page).to_have_url(re.compile(r"/en/t/college"), timeout=LONG_TIMEOUT)
    topics = {topic["slug"]: topic for topic in list_topics(api_base_url, user, workspace["id"])}
    pages = list_dashboards(api_base_url, user, workspace["id"], "college", "topic")
    assert len(pages) == 1
    college = get_dashboard(api_base_url, user, workspace["id"], pages[0]["id"])
    assert [view["templateKey"] for view in college["views"]] == ["deadlines-agenda@1", "this-week@1"]
    assert len(college["blocks"]) > 4

    # Again: nothing is duplicated.
    again = requests.post(
        f"{api_base_url}/private/workspaces/{workspace['id']}/builder/personas/light-student@1/instantiate",
        json={"language": "en"},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=30,
    )
    assert again.status_code == 201, again.text
    (result,) = again.json()["data"]["topics"]
    assert result["created"] is False and result["pageCreated"] is False and result["viewsAdded"] == []
    after = {topic["slug"]: topic for topic in list_topics(api_base_url, user, workspace["id"])}
    assert set(after) == set(topics)
    assert len(list_dashboards(api_base_url, user, workspace["id"], "college", "topic")) == 1
