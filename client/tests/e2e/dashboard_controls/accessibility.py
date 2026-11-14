"""The control blocks and the item Sheet with axe."""
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.e2e.dashboard_controls.smoke import _dashboard_with
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.dashboards import create_dashboard
from tests.helpers.items import create_local_item
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    found = [(v["id"], [n["target"] for n in v["nodes"]]) for v in violations]
    assert violations == [], f"Accessibility violations: {found}"


def test_control_blocks(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    create_local_item(api_base_url, user, workspace["id"], "Write the report", "work")
    _dashboard_with(
        api_base_url,
        user,
        workspace,
        [
            {"type": "note", "title": "Notes", "note": "Plain text"},
            {"type": "action", "title": "Sync", "action": "refresh_source"},
            {"type": "action", "title": "Calendar", "action": "sync_gcal"},
        ],
    )
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    expect(page.get_by_role("button", name="Work")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.locator("[data-note-text]")).to_be_visible()
    _assert_clean(page)


def test_item_sheet_he_dark(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    item = create_local_item(api_base_url, user, workspace["id"], "כתיבת הדוח", "work")
    create_dashboard(api_base_url, user, workspace["id"], language="he")
    page.set_viewport_size(DESKTOP_VIEWPORT)
    page.emulate_media(color_scheme="dark")
    open_as(page, base_url, user, f"/he/dashboard?item={item['id']}")
    expect(page.locator("[data-item-title]")).to_have_text("כתיבת הדוח", timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
