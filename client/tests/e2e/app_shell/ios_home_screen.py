"""
The installed iPhone app: the status bar and the home indicator sit on top of the page
(viewport-fit=cover), so the bars must grow by those insets instead of drawing under them.

Every inset goes through --safe-top/--safe-bottom (src/index.css); the test sets them to a
current iPhone's values (59px, 34px) so a desktop browser lays the page out as the phone does.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT

IPHONE = {"width": 393, "height": 852}
SAFE_TOP = 59
SAFE_BOTTOM = 34
TOP_BAR = 'header:has(> button[aria-label="Search"])'
TAB_BAR = 'nav[aria-label="Sections"]'

FORCE_INSETS = f"""
document.documentElement.style.setProperty('--safe-top', '{SAFE_TOP}px');
document.documentElement.style.setProperty('--safe-bottom', '{SAFE_BOTTOM}px');
"""


def _box(page: Page, selector: str) -> dict:
    box = page.locator(selector).first.bounding_box()
    assert box is not None, f"{selector} has no box"
    return box


def test_shell_bars_clear_the_iphone_insets(base_url: str, authenticated_page: Page):
    page = authenticated_page
    page.set_viewport_size(IPHONE)
    page.goto(f"{base_url}/en/dashboard", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.evaluate(FORCE_INSETS)

    # Top bar: it starts at the top, and its controls start at or below the status bar.
    expect(page.locator(TOP_BAR)).to_be_visible()
    bar = _box(page, TOP_BAR)
    assert bar["y"] == 0
    assert bar["height"] >= SAFE_TOP + 44, f"top bar is only {bar['height']}px tall"
    for control in page.locator(f"{TOP_BAR} button").all():
        box = control.bounding_box()
        assert box is not None and box["y"] >= SAFE_TOP, f"a control starts at {box and box['y']}px"
        assert box["y"] + box["height"] <= bar["y"] + bar["height"] + 0.5, "a control leaves the bar"

    # Tab bar: flush with the bottom edge, its buttons above the home indicator.
    expect(page.locator(TAB_BAR)).to_be_visible()
    tabs = _box(page, TAB_BAR)
    assert round(tabs["y"] + tabs["height"]) == IPHONE["height"], "the tab bar does not reach the bottom"
    for link in page.locator(f"{TAB_BAR} a, {TAB_BAR} button").all():
        box = link.bounding_box()
        assert box is not None
        assert box["y"] + box["height"] <= IPHONE["height"] - SAFE_BOTTOM + 0.5

    # No empty band: the bottom pixel of the screen belongs to the tab bar.
    at_bottom = page.evaluate(
        "document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1)"
        "?.closest('nav')?.getAttribute('aria-label')"
    )
    assert at_bottom == "Sections", "something other than the tab bar sits at the bottom edge"


def test_auth_header_clears_the_iphone_top_inset(app_url: str, page: Page):
    page.set_viewport_size(IPHONE)
    page.goto(f"{app_url}/login", wait_until="load")
    header = page.locator("header").first
    expect(header).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.evaluate(FORCE_INSETS)
    assert _box(page, "header")["height"] >= SAFE_TOP + 56
    for control in header.locator("button, a").all():
        box = control.bounding_box()
        assert box is not None and box["y"] >= SAFE_TOP, f"a control starts at {box and box['y']}px"
