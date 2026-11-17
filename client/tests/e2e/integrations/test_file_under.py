"""
File under (the Manage panel): the connection's topic and one calendar's own topic.

Runs on a demo workspace (`loadDemoData`, dev and qa): its Google Calendar connection and calendars
are stored records, so choosing a topic re-files them at once and nothing reaches a provider.
"""
import pytest
import requests
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.items import list_items
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.helpers.select import choose
from tests.helpers.workspaces import demo_workspace, get_workspace, open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT

PROVIDER = "google_calendar"


@pytest.fixture(scope="module")
def demo(api_base_url):
    yield from demo_workspace(api_base_url)


def _open_panel(page: Page, base_url: str, user, workspace_id: str, locale: str = "en"):
    open_as(page, base_url, user, f"/{locale}/integrations", workspace_id=workspace_id)
    page.locator(f"[data-integration-manage={PROVIDER}]").click()
    panel = page.locator(f"[data-integration-panel={PROVIDER}]")
    expect(panel).to_be_visible(timeout=NORMAL_TIMEOUT)
    return panel


def _calendars(api_base_url: str, user, workspace_id: str) -> list:
    response = requests.get(
        f"{api_base_url}/private/workspaces/{workspace_id}/facets",
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code == 200, response.text
    return [c for c in response.json()["data"]["containers"] if c["provider"] == PROVIDER]


def _items_of(api_base_url, user, workspace_id, container_id=None) -> list:
    items = list_items(api_base_url, user, workspace_id, provider=PROVIDER)
    if container_id is not None:
        items = [i for i in items if i["containerId"] == container_id]
    return items


def test_connection_file_under_moves_its_items(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    work = topic_id(api_base_url, user, workspace["id"], "work")
    page.set_viewport_size(DESKTOP_VIEWPORT)
    panel = _open_panel(page, base_url, user, workspace["id"])
    with page.expect_response(
        lambda r: r.request.method == "PATCH" and "/integrations/" in r.url
    ) as saved:
        choose(panel.locator("[data-file-under-connection]"), "Work")
    assert saved.value.status == 200
    items = _items_of(api_base_url, user, workspace["id"])
    assert items, "the demo workspace has Google Calendar items"
    assert {i["topicId"] for i in items} == {work}


def test_calendar_file_under_writes_a_rule_and_back(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    work = topic_id(api_base_url, user, workspace["id"], "work")
    college = topic_id(api_base_url, user, workspace["id"], "college")
    calendar = _calendars(api_base_url, user, workspace["id"])[0]
    page.set_viewport_size(DESKTOP_VIEWPORT)
    panel = _open_panel(page, base_url, user, workspace["id"])
    panel.locator("[data-file-under-containers] summary").click()
    row = panel.locator(f"[data-file-under-container='{calendar['id']}']")
    expect(row).to_be_visible(timeout=NORMAL_TIMEOUT)

    with page.expect_response(lambda r: r.request.method == "PUT" and "/file-under" in r.url) as saved:
        choose(row.get_by_role("combobox"), "College")
    assert saved.value.status == 200
    rules = get_workspace(api_base_url, user, workspace["id"])["settings"]["topicRules"]
    assert {"match": calendar["matchKey"], "topicId": college} in rules
    mine = _items_of(api_base_url, user, workspace["id"], calendar["id"])
    assert mine and {i["topicId"] for i in mine} == {college}

    with page.expect_response(lambda r: r.request.method == "PUT" and "/file-under" in r.url) as cleared:
        choose(row.get_by_role("combobox"), "Same as the connection (Work)")
    assert cleared.value.status == 200
    rules = get_workspace(api_base_url, user, workspace["id"])["settings"]["topicRules"]
    assert all(rule["match"] != calendar["matchKey"] for rule in rules)
    mine = _items_of(api_base_url, user, workspace["id"], calendar["id"])
    assert {i["topicId"] for i in mine} == {work}


def test_hebrew_panel_is_rtl(page: Page, base_url: str, api_base_url: str, demo):
    user, workspace = demo
    page.set_viewport_size({"width": 393, "height": 852})
    panel = _open_panel(page, base_url, user, workspace["id"], locale="he")
    block = panel.locator("[data-file-under]").first
    expect(block).to_contain_text("סיווג לנושא", timeout=NORMAL_TIMEOUT)
    expect(block).to_contain_text("פריטים ששייכתם ידנית")
    panel.locator("[data-file-under-containers] summary").click()
    expect(panel.locator("[data-file-under-containers]")).to_contain_text("יומנים ופרויקטים")
    assert page.evaluate("() => document.documentElement.dir") == "rtl"
    assert_no_horizontal_overflow(page, "iphone", 393)
