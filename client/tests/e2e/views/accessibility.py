"""
Views with axe: the tabs and a rigid view in edit mode with the variables panel (English light,
Hebrew dark), and the Add view dialog.
"""
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard, list_dashboards
from tests.helpers.workspaces import open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def _page_with_views(api_base_url, user, workspace_id) -> None:
    scope = {"topicId": topic_id(api_base_url, user, workspace_id, "work")}
    create_dashboard(api_base_url, user, workspace_id, template="work", scope=scope)
    page = list_dashboards(api_base_url, user, workspace_id, "work", "topic")[0]
    page = get_dashboard(api_base_url, user, workspace_id, page["id"])
    apply_ops(
        api_base_url,
        user,
        workspace_id,
        page["id"],
        page["version"],
        [{"op": "add_view", "type": "agenda"}, {"op": "add_view", "templateKey": "study-dashboard@1"}],
    )


def test_views_in_edit_mode_are_accessible(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _page_with_views(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/work?edit=1", h1="Work")
    expect(page.locator("[data-page-vars-panel]")).to_be_visible(timeout=LONG_TIMEOUT)
    expect(page.locator("[data-view-tab]")).to_have_count(3, timeout=NORMAL_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=LONG_TIMEOUT)
    _assert_clean(page)
    page.locator("[data-view-tab]").nth(1).click()
    expect(page.locator("[data-rigid-view='agenda']")).to_be_visible(timeout=LONG_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=LONG_TIMEOUT)
    _assert_clean(page)


def test_views_in_hebrew_dark_are_accessible(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _page_with_views(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/he/t/work?edit=1")
    page.evaluate("() => localStorage.setItem('todolist-ui-theme', 'dark')")
    page.reload(wait_until="load")
    expect(page.locator("[data-view-tab]")).to_have_count(3, timeout=LONG_TIMEOUT)
    page.locator("[data-view-tab]").nth(2).click()
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=LONG_TIMEOUT)
    _assert_clean(page)


def test_the_add_view_dialog_is_accessible(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _page_with_views(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/work", h1="Work")
    page.locator("[data-add-view]").click()
    dialog = page.get_by_role("dialog", name="Add a view")
    expect(dialog).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
    dialog.locator('[data-add-view-mode="template"]').click()
    expect(dialog.locator('[data-view-template="this-week@1"]')).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
