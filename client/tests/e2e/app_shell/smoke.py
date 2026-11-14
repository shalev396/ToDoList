"""
The app shell: sidebar, workspace switcher, ⌘K palette, keyboard shortcuts, the rail, topic
pages, the account menu and the phone bars. Runs as the shared user, changing only per-browser
preferences (language, sidebar), never the workspace.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT

TOPICS = ("Work", "College", "Personal")


def _dashboard(page: Page, app_url: str) -> None:
    page.goto(f"{app_url}/dashboard", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Dashboard", timeout=NORMAL_TIMEOUT)


def test_sidebar_shows_the_frame(page: Page, app_url: str, authenticated_page: Page):
    _dashboard(page, app_url)
    nav = page.get_by_role("navigation", name="Main")
    for name in ("Dashboard", *TOPICS, "Integrations", "Templates", "Settings"):
        expect(nav.get_by_role("link", name=name, exact=True)).to_be_visible()
    expect(nav.get_by_role("link", name="Dashboard", exact=True)).to_have_attribute(
        "aria-current", "page"
    )
    expect(nav.get_by_role("button", name=re.compile(r", switch workspace$"))).to_be_visible()
    expect(nav.get_by_role("button", name=re.compile(r"^Account: "))).to_be_visible()


def test_workspace_switcher_lists_my_workspaces(page: Page, app_url: str, authenticated_page: Page):
    _dashboard(page, app_url)
    page.get_by_role("button", name=re.compile(r", switch workspace$")).click()
    menu = page.get_by_role("menu")
    current = menu.get_by_role("menuitemradio", checked=True)
    expect(current).to_have_count(1)
    expect(current).to_contain_text("Owner")
    expect(menu.get_by_role("menuitem", name="Create workspace")).to_be_visible()
    expect(menu.get_by_role("menuitem", name="Join with an invite link")).to_be_visible()


def test_join_with_an_invite_link(page: Page, app_url: str, authenticated_page: Page):
    """Pasting the whole emailed link opens its accept page; anything else is explained."""
    _dashboard(page, app_url)
    page.get_by_role("button", name=re.compile(r", switch workspace$")).click()
    page.get_by_role("menuitem", name="Join with an invite link").click()
    dialog = page.get_by_role("dialog", name="Join with an invite link")
    field = dialog.get_by_label("Invite link")
    field.fill("not a link")
    dialog.get_by_role("button", name="Open invite").click()
    expect(dialog.get_by_text("That isn’t an invite link.", exact=False)).to_be_visible()
    token = "Ab3_-defghijklmnopqrstuvwxyz0123456789ABCDE"
    field.fill(f"http://localhost:5173/en/invites/{token}")
    dialog.get_by_role("button", name="Open invite").click()
    expect(page).to_have_url(f"{app_url}/invites/{token}")
    expect(page.get_by_role("heading", level=1)).to_have_text("Join a workspace")


def test_command_palette_finds_and_opens_a_page(
    page: Page, app_url: str, authenticated_page: Page
):
    _dashboard(page, app_url)
    page.keyboard.press("Control+k")
    palette = page.get_by_role("dialog", name="Command menu")
    expect(palette).to_be_visible()
    expect(palette.get_by_role("option", name="Sign out")).to_be_visible()
    page.keyboard.type("templ")
    expect(palette.get_by_role("option")).to_have_count(1)
    page.keyboard.press("Enter")
    expect(page).to_have_url(f"{app_url}/templates")
    expect(page.get_by_role("heading", level=1)).to_have_text("Templates")
    expect(palette).to_be_hidden()


def test_command_palette_from_the_search_button(page: Page, app_url: str, authenticated_page: Page):
    _dashboard(page, app_url)
    page.get_by_role("navigation", name="Main").get_by_role("button", name="Search").click()
    palette = page.get_by_role("dialog", name="Command menu")
    page.keyboard.type("nothing matches this")
    expect(palette.get_by_text("No results.")).to_be_visible()
    page.keyboard.press("Escape")
    expect(palette).to_be_hidden()


def test_go_shortcuts(page: Page, app_url: str, authenticated_page: Page):
    _dashboard(page, app_url)
    page.keyboard.press("g")
    page.keyboard.press("c")
    expect(page).to_have_url(f"{app_url}/t/college")
    expect(page.get_by_role("heading", level=1)).to_have_text("College")
    page.keyboard.press("g")
    page.keyboard.press("d")
    expect(page).to_have_url(f"{app_url}/dashboard")


def test_sidebar_collapses_to_a_rail_and_remembers(
    page: Page, app_url: str, authenticated_page: Page
):
    _dashboard(page, app_url)
    nav = page.get_by_role("navigation", name="Main")
    nav.get_by_role("button", name="Collapse sidebar").click()
    expect(nav.get_by_role("button", name="Expand sidebar")).to_be_visible()
    box = nav.bounding_box()
    assert box is not None and box["width"] <= 60, f"rail is {box}"
    # Names stay with the icons, for screen readers and as tooltips.
    expect(nav.get_by_role("link", name="College", exact=True)).to_be_visible()
    page.reload(wait_until="load")
    expect(nav.get_by_role("button", name="Expand sidebar")).to_be_visible(timeout=NORMAL_TIMEOUT)
    nav.get_by_role("button", name="Expand sidebar").click()
    expect(nav.get_by_role("button", name="Collapse sidebar")).to_be_visible()


def test_topic_pages(page: Page, app_url: str, authenticated_page: Page):
    page.goto(f"{app_url}/t/work", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Work", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_text("Start the Work page from a template")).to_be_visible()
    # A group page: one course of College, until its dashboard exists.
    page.goto(f"{app_url}/t/college/some-course", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Course", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_text("Start course pages from a template")).to_be_visible()
    # A slug the workspace has no topic for (never made, or deleted).
    page.goto(f"{app_url}/t/gardening", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "This page isn’t available", timeout=NORMAL_TIMEOUT
    )


def test_placeholder_pages(page: Page, app_url: str, authenticated_page: Page):
    for path, title in (("integrations", "Integrations"), ("templates", "Templates")):
        page.goto(f"{app_url}/{path}", wait_until="load")
        expect(page.get_by_role("heading", level=1)).to_have_text(title, timeout=NORMAL_TIMEOUT)


def test_account_menu_switches_language(page: Page, app_url: str, base_url: str, authenticated_page: Page):
    _dashboard(page, app_url)
    page.get_by_role("button", name=re.compile(r"^Account: ")).click()
    page.get_by_role("menuitem", name="Language").click()
    page.get_by_role("menuitemradio", name="עברית").click()
    expect(page).to_have_url(f"{base_url}/he/dashboard")
    expect(page.locator("html")).to_have_attribute("dir", "rtl")
    expect(page.get_by_role("heading", level=1)).to_have_text("לוח בקרה")
    # The sidebar mirrors to the right.
    box = page.get_by_role("navigation", name="ראשי").bounding_box()
    viewport = page.viewport_size
    assert box is not None and viewport is not None
    assert box["x"] > viewport["width"] / 2, f"sidebar at {box}"


def test_sign_out_from_the_account_menu(page: Page, app_url: str, base_url: str, authenticated_page: Page):
    _dashboard(page, app_url)
    page.get_by_role("button", name=re.compile(r"^Account: ")).click()
    page.get_by_role("menuitem", name="Sign out").click()
    expect(page).to_have_url(re.compile(rf"^{re.escape(app_url)}/?$"))
    tokens = page.evaluate(
        "() => [sessionStorage.getItem('idToken'), localStorage.getItem('refreshToken'),"
        " localStorage.getItem('todolist-current-workspace')]"
    )
    assert tokens == [None, None, None], tokens


def test_phone_tab_bar_and_more_sheet(page: Page, app_url: str, authenticated_page: Page):
    page.set_viewport_size({"width": 390, "height": 844})
    _dashboard(page, app_url)
    tabs = page.get_by_role("navigation", name="Sections")
    for name in ("Dashboard", *TOPICS):
        expect(tabs.get_by_role("link", name=name, exact=True)).to_be_visible()
    expect(page.get_by_role("navigation", name="Main")).to_be_hidden()
    tabs.get_by_role("button", name="More").click()
    sheet = page.get_by_role("dialog", name="More")
    for name in ("Integrations", "Templates", "Settings", "Members", "Profile"):
        expect(sheet.get_by_role("link", name=name, exact=True)).to_be_visible()
    expect(sheet.get_by_role("button", name="Sign out")).to_be_visible()
    sheet.get_by_role("link", name="Templates", exact=True).click()
    expect(page).to_have_url(f"{app_url}/templates")
    expect(sheet).to_be_hidden()
    # The phone top bar has the switcher and search.
    expect(page.get_by_role("button", name=re.compile(r", switch workspace$"))).to_be_visible()
    page.get_by_role("banner").get_by_role("button", name="Search").click()
    expect(page.get_by_role("dialog", name="Command menu")).to_be_visible()
