"""
The control blocks (filter, action, note) and the item Sheet (`?item=`).

Each test owns a fresh workspace. The mirrored-item test loads the demo data (`loadDemoData`,
dev and qa) into its own workspace.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.dashboards import apply_ops, create_dashboard, get_dashboard
from tests.helpers.items import create_local_item, list_items
from tests.helpers.users import pooled_user
from tests.helpers.workspaces import open_as, topic_id
from tests.viewports import DESKTOP_VIEWPORT


def _dashboard_with(api_base_url, user, workspace, blocks):
    dashboard = create_dashboard(api_base_url, user, workspace["id"])
    ops = [{"op": "add_block", "block": block} for block in blocks]
    if ops:
        apply_ops(api_base_url, user, workspace["id"], dashboard["id"], dashboard["version"], ops)
    return get_dashboard(api_base_url, user, workspace["id"], dashboard["id"])


def test_filter_chip_sets_the_variable_and_outlines_listeners(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    create_local_item(api_base_url, user, workspace["id"], "Write the report", "work")
    create_local_item(api_base_url, user, workspace["id"], "Buy milk", "personal")
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")

    # Options come from the facets: only the topics that hold items, by name.
    group = page.get_by_role("group", name=re.compile("Filter"))
    expect(group.get_by_role("button")).to_have_count(2, timeout=NORMAL_TIMEOUT)
    work = group.get_by_role("button", name="Work")

    # Hovering the filter outlines the blocks that listen to its variable (and only those).
    work.hover()
    outlined = page.locator("article[data-outlined]")
    expect(outlined.first).to_be_visible()
    page.mouse.move(0, 0)
    expect(outlined).to_have_count(0)

    # A listening block refetches with the new value (the topic's id); the URL carries it.
    work_id = topic_id(api_base_url, user, workspace["id"], "work")
    with page.expect_request(
        lambda r: r.url.endswith("/query") and f'"$page.topic":"{work_id}"' in (r.post_data or "")
    ):
        work.click()
    expect(page).to_have_url(re.compile(rf"[?&]topic={re.escape(work_id)}"))
    expect(work).to_have_attribute("aria-pressed", "true")

    page.get_by_role("button", name="Clear filter").click()
    expect(page).not_to_have_url(re.compile(r"topic="))
    expect(work).to_have_attribute("aria-pressed", "false")


def test_note_is_plain_text_with_line_breaks(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    text = "Line one <b>bold</b>\n# not a heading\nשורה בעברית"
    _dashboard_with(api_base_url, user, workspace, [{"type": "note", "title": "Notes", "note": text}])
    open_as(page, base_url, user, "/en/dashboard")
    note = page.locator("[data-note-text]")
    expect(note).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(note).to_have_text(text)
    assert note.locator("b, h1").count() == 0
    assert note.evaluate("el => getComputedStyle(el).whiteSpace") == "pre-wrap"


def test_action_buttons(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    _dashboard_with(
        api_base_url,
        user,
        workspace,
        [
            {"type": "action", "title": "Sync", "action": "refresh_source"},
            {"type": "action", "title": "Calendar", "action": "sync_gcal"},
        ],
    )
    open_as(page, base_url, user, "/en/dashboard")
    # Without a connected Google Calendar the button is off, with the reason as its title.
    calendar = page.get_by_role("button", name="Sync to calendar")
    expect(calendar).to_be_disabled(timeout=NORMAL_TIMEOUT)
    expect(calendar).to_have_attribute("title", "Connect Google Calendar first.")
    # Sync now answers 202 and settles on a status.
    page.get_by_role("button", name="Sync now").click()
    expect(
        page.get_by_text(re.compile("Synced just now|Nothing is ready to sync|Syncing|sync failed|problems"))
    ).to_be_visible(timeout=NORMAL_TIMEOUT)


def test_item_sheet_opens_edits_and_back_closes(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    item = create_local_item(api_base_url, user, workspace["id"], "Write the report", "work")
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    page.goto(f"{base_url}/en/dashboard?item={item['id']}", wait_until="load")

    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text("Write the report", timeout=NORMAL_TIMEOUT)

    # A local to-do edits in place.
    sheet.get_by_role("button", name="Edit", exact=True).click()
    sheet.get_by_label("Title").fill("Write the final report")
    sheet.get_by_role("button", name="Save changes").click()
    expect(sheet.locator("[data-item-title]")).to_have_text("Write the final report")

    # Overlay: pin it; the change is saved.
    sheet.get_by_role("switch", name="Pin this item").click()
    expect(sheet.get_by_text("Saved", exact=True)).to_be_visible()

    # The browser's back button closes the Sheet.
    page.go_back()
    expect(sheet).to_have_count(0)
    expect(page).not_to_have_url(re.compile(r"item="))


def test_mirrored_item_has_no_edit_controls(
    page: Page, base_url: str, api_base_url: str, new_workspace
):
    owner = pooled_user(api_base_url, "demo")
    demo = new_workspace(owner, "Demo workspace", timezone="Asia/Jerusalem", loadDemoData=True)
    items = list_items(api_base_url, owner, demo["id"], provider="jira")
    assert items, "the seed has Jira items"
    item = items[0]

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, owner, f"/en/dashboard?item={item['id']}", workspace_id=demo["id"])
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text(item["title"], timeout=NORMAL_TIMEOUT)
    expect(sheet.locator("[data-mirrored-note]")).to_contain_text("edited in Jira")
    expect(sheet.get_by_role("button", name="Edit", exact=True)).to_have_count(0)
    expect(sheet.get_by_label("Title")).to_have_count(0)
    link = sheet.locator("a[data-source-link]")
    expect(link).to_have_attribute("href", item["source"]["url"])
    # The overlay still works: it never writes to Jira.
    sheet.get_by_role("switch", name="Hide from my dashboards").click()
    expect(sheet.get_by_text("Saved", exact=True)).to_be_visible()
    sheet.get_by_role("switch", name="Hide from my dashboards").click()
