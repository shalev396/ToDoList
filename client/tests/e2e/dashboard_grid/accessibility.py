"""
The dashboard runtime with axe: a template dashboard in view and edit modes (English light,
Hebrew dark), and with a block menu open.
"""
import re

from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.animations import wait_for_fade_in
from tests.helpers.dashboards import create_dashboard
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

# The template's Area filter is a real block now (T4.8); the others are still placeholders.
PHONE_VIEWPORT = {"width": 390, "height": 844}


def _assert_clean(page: Page) -> None:
    wait_for_fade_in(page)
    violations = Axe().run(page).response.get("violations", [])
    assert violations == [], f"Accessibility violations: {violations}"


def _open(
    page: Page,
    base_url: str,
    user,
    path: str,
    blocks: int,
) -> None:
    """Every block frame drawn and settled (its data loaded) before axe looks."""
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, path)
    expect(page.get_by_role("article")).to_have_count(blocks, timeout=NORMAL_TIMEOUT)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)


def test_dashboard_view_and_edit_modes(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    blocks = len(dashboard["blocks"])
    _open(page, base_url, user, "/en/dashboard", blocks)
    _assert_clean(page)
    page.get_by_role("button", name="Edit", exact=True).click()
    expect(page.get_by_role("button", name="Done", exact=True)).to_be_visible()
    expect(page.locator(".block-drag-handle")).to_have_count(blocks)
    _assert_clean(page)


def test_dashboard_edit_mode_he_dark(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"], language="he")
    page.emulate_media(color_scheme="dark")
    _open(
        page,
        base_url,
        user,
        "/he/dashboard?edit=1",
        len(dashboard["blocks"]),
    )
    page.evaluate("() => localStorage.setItem('todolist-ui-theme', 'dark')")
    page.reload(wait_until="load")
    expect(page.locator("html")).to_have_class(re.compile(r"\bdark\b"))
    expect(page.get_by_role("article")).to_have_count(
        len(dashboard["blocks"]), timeout=NORMAL_TIMEOUT
    )
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)
    _assert_clean(page)


def test_block_menu_open(page: Page, base_url: str, api_base_url: str, fresh_owner):
    """The open menu and its Move submenu. Scoped to the menus: while a menu is open Radix hides
    the rest of the page from screen readers (aria-hidden) and keeps focus in the menu, which a
    whole-page scan reports as hidden focusable content (the closed page is scanned whole above)."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    _open(page, base_url, user, "/en/dashboard?edit=1", len(dashboard["blocks"]))
    page.get_by_role("button", name="Options for Today").click()
    page.get_by_role("menuitem", name="Move", exact=True).click()
    expect(page.get_by_role("menu", name="Move", exact=True)).to_be_visible()
    violations = (
        Axe().run(page, context={"include": [["[role='menu']"]]}).response.get("violations", [])
    )
    assert violations == [], f"Accessibility violations: {violations}"


def _luminance(css: str) -> float:
    match = re.match(r"rgba?\((\d+), (\d+), (\d+)", css)
    assert match, f"not an rgb colour: {css}"

    def channel(value: str) -> float:
        c = int(value) / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in match.groups())
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: str, b: str) -> float:
    high, low = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def test_edit_mode_targets_and_resize_corner(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """Phones: every drag handle is at least 44 x 44px. Desktop, light and dark: the resize
    corner is at least 3:1 against its block (WCAG 1.4.11)."""
    user, workspace = fresh_owner
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    blocks = len(dashboard["blocks"])
    _open(page, base_url, user, "/en/dashboard?edit=1", blocks)
    page.set_viewport_size(PHONE_VIEWPORT)
    handles = page.locator(".block-drag-handle")
    expect(handles).to_have_count(blocks)
    for index in range(blocks):
        box = handles.nth(index).bounding_box()
        assert box is not None and box["width"] >= 44 and box["height"] >= 44, box

    page.set_viewport_size(DESKTOP_VIEWPORT)
    for theme in ("light", "dark"):
        page.evaluate(f"() => localStorage.setItem('todolist-ui-theme', '{theme}')")
        page.reload(wait_until="load")
        expect(page.get_by_role("article")).to_have_count(blocks, timeout=NORMAL_TIMEOUT)
        expect(page.locator('article[aria-busy="true"]')).to_have_count(0, timeout=NORMAL_TIMEOUT)
        colours = page.evaluate(
            """() => {
              const handle = document.querySelector('.react-grid-item > .react-resizable-handle');
              const card = handle.parentElement.querySelector('article');
              return {
                mark: getComputedStyle(handle, '::after').borderBottomColor,
                opacity: getComputedStyle(handle, '::after').opacity,
                card: getComputedStyle(card).backgroundColor,
              };
            }"""
        )
        assert colours["opacity"] == "1", colours
        assert _contrast(colours["mark"], colours["card"]) >= 3, (theme, colours)
