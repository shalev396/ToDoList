"""
The iPhone layout. The status bar and the home indicator sit on top of the page
(viewport-fit=cover), so the bars must grow by those insets instead of drawing under them.

The raw insets go through --inset-top/--inset-bottom (src/index.css); the tests force a current
iPhone's values on a desktop browser. A Safari tab keeps the full insets. The Home Screen app
(navigator.standalone, faked here) keeps 20px at the bottom and adds 10px under the status bar
(src/lib/standaloneInsets.ts), as measured on the owner's phone, where window.innerHeight is
about 50px less than screen.height although the page fills the screen.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT

IPHONE = {"width": 393, "height": 852}
SAFE_TOP = 59
SAFE_BOTTOM = 34
HOME_SCREEN_BOTTOM = 20
HOME_SCREEN_TOP_EXTRA = 10
TOP_BAR = 'header:has(> button[aria-label="Search"])'
TAB_BAR = 'nav[aria-label="Sections"]'

FORCE_INSETS = f"""
document.documentElement.style.setProperty('--inset-top', '{SAFE_TOP}px');
document.documentElement.style.setProperty('--inset-bottom', '{SAFE_BOTTOM}px');
"""

# Runs before the app's scripts: the owner's Home Screen app, whose screen.height is 50px more
# than window.innerHeight.
FAKE_HOME_SCREEN_APP = f"""
Object.defineProperty(Navigator.prototype, 'standalone', {{ get: () => true, configurable: true }});
Object.defineProperty(Screen.prototype, 'width', {{ get: () => {IPHONE["width"]}, configurable: true }});
Object.defineProperty(Screen.prototype, 'height', {{ get: () => {IPHONE["height"] + 50}, configurable: true }});
"""


def _box(page: Page, selector: str) -> dict:
    box = page.locator(selector).first.bounding_box()
    assert box is not None, f"{selector} has no box"
    return box


def _open_dashboard(page: Page, base_url: str) -> None:
    page.set_viewport_size(IPHONE)
    page.goto(f"{base_url}/en/dashboard", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.evaluate(FORCE_INSETS)
    expect(page.locator(TOP_BAR)).to_be_visible()
    expect(page.locator(TAB_BAR)).to_be_visible()


def _assert_top_bar_starts_below(page: Page, top: int) -> None:
    bar = _box(page, TOP_BAR)
    assert bar["y"] == 0
    controls = page.locator(f"{TOP_BAR} button:visible").all()
    assert controls, "the top bar shows no controls"
    for control in controls:
        box = control.bounding_box()
        assert box is not None and box["y"] >= top, f"a control starts at {box and box['y']}px, above {top}px"
        assert box["y"] + box["height"] <= bar["y"] + bar["height"] + 0.5, "a control leaves the bar"


def _assert_tab_bar(page: Page, bottom_padding: int) -> None:
    tabs = page.locator(TAB_BAR).first
    expect(tabs).to_have_css("padding-bottom", f"{bottom_padding}px")
    box = _box(page, TAB_BAR)
    assert round(box["y"] + box["height"]) == IPHONE["height"], "the tab bar does not reach the bottom"
    for link in page.locator(f"{TAB_BAR} a, {TAB_BAR} button").all():
        link_box = link.bounding_box()
        assert link_box is not None
        assert link_box["y"] + link_box["height"] <= IPHONE["height"] - bottom_padding + 0.5
    at_bottom = page.evaluate(
        "document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1)"
        "?.closest('nav')?.getAttribute('aria-label')"
    )
    assert at_bottom == "Sections", "something other than the tab bar sits at the bottom edge"


def test_safari_tab_keeps_the_full_insets(base_url: str, authenticated_page: Page):
    page = authenticated_page
    _open_dashboard(page, base_url)
    _assert_top_bar_starts_below(page, SAFE_TOP)
    _assert_tab_bar(page, SAFE_BOTTOM)


def test_home_screen_app_tabs_sit_low_and_the_top_clears_the_blur(base_url: str, authenticated_page: Page):
    page = authenticated_page
    page.add_init_script(FAKE_HOME_SCREEN_APP)
    _open_dashboard(page, base_url)
    # A shorter innerHeight than screen.height must not take the bottom padding away (it did, and
    # the labels went into the rounded corners): 20px stays.
    _assert_tab_bar(page, HOME_SCREEN_BOTTOM)
    _assert_top_bar_starts_below(page, SAFE_TOP + HOME_SCREEN_TOP_EXTRA)


def test_auth_header_clears_the_iphone_top_inset(app_url: str, page: Page):
    page.set_viewport_size(IPHONE)
    page.goto(f"{app_url}/login", wait_until="load")
    header = page.locator("header").first
    expect(header).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.evaluate(FORCE_INSETS)
    assert _box(page, "header")["height"] >= SAFE_TOP + 56
    controls = header.locator("button:visible, a:visible").all()
    assert controls, "the header shows no controls"
    for control in controls:
        box = control.bounding_box()
        assert box is not None and box["y"] >= SAFE_TOP, f"a control starts at {box and box['y']}px"
