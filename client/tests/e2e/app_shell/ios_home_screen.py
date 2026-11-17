"""
The installed iPhone app: the status bar and the home indicator sit on top of the page
(viewport-fit=cover), so the bars must grow by those insets instead of drawing under them.

The raw insets go through --inset-top/--inset-bottom (src/index.css); the tests set them to a
current iPhone's values (59px, 34px) so a desktop browser lays the page out as the phone does.
The Home Screen app can also end its viewport above the home indicator while the bottom inset
still reports it (src/lib/standaloneInsets.ts); the last test fakes that phone.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT

IPHONE = {"width": 393, "height": 852}
SAFE_TOP = 59
SAFE_BOTTOM = 34
# The Home Screen app's viewport on such a phone: 62px of screen lie below it.
SHORT_VIEWPORT = {"width": 393, "height": 790}
TOP_BAR = 'header:has(> button[aria-label="Search"])'
TAB_BAR = 'nav[aria-label="Sections"]'

FORCE_INSETS = f"""
document.documentElement.style.setProperty('--inset-top', '{SAFE_TOP}px');
document.documentElement.style.setProperty('--inset-bottom', '{SAFE_BOTTOM}px');
"""

# Runs before the app's scripts: an iPhone Home Screen app on a 393 × 852 screen.
FAKE_HOME_SCREEN_APP = f"""
Object.defineProperty(Navigator.prototype, 'standalone', {{ get: () => true, configurable: true }});
Object.defineProperty(Screen.prototype, 'width', {{ get: () => {IPHONE["width"]}, configurable: true }});
Object.defineProperty(Screen.prototype, 'height', {{ get: () => {IPHONE["height"]}, configurable: true }});
Object.defineProperty(ScreenOrientation.prototype, 'type', {{ get: () => 'portrait-primary', configurable: true }});
"""


def _box(page: Page, selector: str) -> dict:
    box = page.locator(selector).first.bounding_box()
    assert box is not None, f"{selector} has no box"
    return box


def _open_dashboard(page: Page, base_url: str, viewport: dict) -> None:
    page.set_viewport_size(viewport)
    page.goto(f"{base_url}/en/dashboard", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
    page.evaluate(FORCE_INSETS)
    expect(page.locator(TOP_BAR)).to_be_visible()
    expect(page.locator(TAB_BAR)).to_be_visible()


def _bottom_edge_is_the_tab_bar(page: Page) -> None:
    at_bottom = page.evaluate(
        "document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1)"
        "?.closest('nav')?.getAttribute('aria-label')"
    )
    assert at_bottom == "Sections", "something other than the tab bar sits at the bottom edge"


def test_shell_bars_clear_the_iphone_insets(base_url: str, authenticated_page: Page):
    page = authenticated_page
    _open_dashboard(page, base_url, IPHONE)

    # Top bar: it starts at the top, and its controls start at or below the status bar.
    bar = _box(page, TOP_BAR)
    assert bar["y"] == 0
    assert bar["height"] >= SAFE_TOP + 44, f"top bar is only {bar['height']}px tall"
    for control in page.locator(f"{TOP_BAR} button").all():
        box = control.bounding_box()
        assert box is not None and box["y"] >= SAFE_TOP, f"a control starts at {box and box['y']}px"
        assert box["y"] + box["height"] <= bar["y"] + bar["height"] + 0.5, "a control leaves the bar"

    # Tab bar: flush with the bottom edge, its buttons above the home indicator.
    tabs = _box(page, TAB_BAR)
    assert round(tabs["y"] + tabs["height"]) == IPHONE["height"], "the tab bar does not reach the bottom"
    for link in page.locator(f"{TAB_BAR} a, {TAB_BAR} button").all():
        box = link.bounding_box()
        assert box is not None
        assert box["y"] + box["height"] <= IPHONE["height"] - SAFE_BOTTOM + 0.5
    _bottom_edge_is_the_tab_bar(page)


def test_home_screen_app_with_a_short_viewport_has_no_gap(base_url: str, authenticated_page: Page):
    page = authenticated_page
    page.add_init_script(FAKE_HOME_SCREEN_APP)
    _open_dashboard(page, base_url, SHORT_VIEWPORT)

    # The home indicator is already below the viewport, so the tab bar must not pad for it again.
    tabs = page.locator(TAB_BAR).first
    expect(tabs).to_have_css("padding-bottom", "0px")
    box = _box(page, TAB_BAR)
    assert round(box["y"] + box["height"]) == SHORT_VIEWPORT["height"], "the tab bar does not reach the bottom"
    lowest = max(
        (b["y"] + b["height"] for b in (el.bounding_box() for el in page.locator(f"{TAB_BAR} a").all()) if b),
        default=0,
    )
    assert lowest > SHORT_VIEWPORT["height"] - SAFE_BOTTOM, f"the tabs end at {lowest}px, above an empty band"
    _bottom_edge_is_the_tab_bar(page)

    # The top keeps its inset: the status bar still covers the page.
    for control in page.locator(f"{TOP_BAR} button").all():
        control_box = control.bounding_box()
        assert control_box is not None and control_box["y"] >= SAFE_TOP


def test_home_screen_app_tabs_sit_low_but_clear_the_home_indicator(base_url: str, authenticated_page: Page):
    page = authenticated_page
    page.add_init_script(FAKE_HOME_SCREEN_APP)
    _open_dashboard(page, base_url, IPHONE)

    # The viewport reaches the bottom: the app keeps 20px of the 34px inset (BOTTOM_INSET_CAP_PX),
    # so the tabs sit 14px lower than in a Safari tab, still clear of the home indicator.
    tabs = page.locator(TAB_BAR).first
    expect(tabs).to_have_css("padding-bottom", "20px")
    box = _box(page, TAB_BAR)
    assert round(box["y"] + box["height"]) == IPHONE["height"], "the tab bar does not reach the bottom"
    for link in page.locator(f"{TAB_BAR} a").all():
        link_box = link.bounding_box()
        assert link_box is not None
        assert link_box["y"] + link_box["height"] <= IPHONE["height"] - 20 + 0.5, "a tab reaches the home indicator"
    _bottom_edge_is_the_tab_bar(page)


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
