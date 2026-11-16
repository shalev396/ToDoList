"""The block editor Sheet and the integrations pages with axe."""
from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.e2e.block_editor.smoke import _editor, _setup
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    found = [(v["id"], [n["target"] for n in v["nodes"]]) for v in violations]
    assert violations == [], f"Accessibility violations: {found}"


def test_editor_steps_en_light(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _setup(api_base_url, user, workspace)
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard?edit=1")
    page.locator("[data-add-block]").click()
    editor = _editor(page)
    editor.locator("[data-block-type=list]").click()
    for step in ("source", "filter", "group", "viz"):
        editor.locator(f"[data-editor-step={step}]").click()
        if step == "filter":
            # The sentence first (a condition added), then the rule tree behind Advanced.
            editor.get_by_role("button", name="Add a condition").click()
            _assert_clean(page)
            editor.get_by_role("button", name="Advanced").click()
            editor.get_by_role("button", name="Add a rule").click()
        expect(editor.locator(f"[data-editor-step={step}]")).to_have_attribute("aria-current", "step")
        _assert_clean(page)


def test_integrations_and_keys_he_dark(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    page.emulate_media(color_scheme="dark")
    open_as(page, base_url, user, "/he/integrations")
    expect(page.locator("[data-integration-card]").first).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
    # "Connect" signs in with the provider (OAuth first); the form is behind "use a token instead".
    fallback = page.locator("[data-token-fallback]").first
    fallback.locator("summary").click()
    fallback.locator("[data-use-token]").click()
    expect(page.get_by_role("dialog")).to_be_visible()
    _assert_clean(page)
    page.keyboard.press("Escape")
    page.goto(f"{base_url}/he/settings/agent-keys", wait_until="load")
    expect(page.get_by_role("button", name="מפתח חדש")).to_be_visible(timeout=NORMAL_TIMEOUT)
    _assert_clean(page)
