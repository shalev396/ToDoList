"""
The control blocks (filter, action, note), the item Sheet (`?item=`) and New to-do's Repeat.

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
    # It pushes the workspace calendar only: without one chosen the button is off, with the reason
    # as its title.
    calendar = page.get_by_role("button", name="Sync to calendar")
    expect(calendar).to_be_disabled(timeout=NORMAL_TIMEOUT)
    expect(calendar).to_have_attribute("title", "Choose the workspace calendar first")
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

    expect(sheet.locator("[data-item-local-edit] [data-save-status=saved]")).to_have_count(1)

    # Overlay: pin it; the change is saved (its own status, beside the overlay controls).
    sheet.get_by_role("switch", name="Pin this item").click()
    expect(sheet.locator("section[aria-labelledby=item-overlay] [data-save-status=saved]")).to_be_visible()

    # The browser's back button closes the Sheet.
    page.go_back()
    expect(sheet).to_have_count(0)
    expect(page).not_to_have_url(re.compile(r"item="))


def test_mirrored_item_edits_follow_its_connection(
    page: Page, base_url: str, api_base_url: str, new_workspace
):
    """Demo data stays read-only and can't be switched: Jira's own fields are locked under one
    hint (no "switch it"), while a start date Jira lacks is kept in TodoList by any editor."""
    owner = pooled_user(api_base_url, "demo")
    demo = new_workspace(owner, "Demo workspace", timezone="Asia/Jerusalem", loadDemoData=True)
    items = list_items(api_base_url, owner, demo["id"], provider="jira")
    assert items, "the seed has Jira items"
    item = items[0]

    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, owner, f"/en/dashboard?item={item['id']}", workspace_id=demo["id"])
    sheet = page.locator("[data-item-sheet]")
    expect(sheet.locator("[data-item-title]")).to_have_text(item["title"], timeout=NORMAL_TIMEOUT)
    expect(sheet.locator("[data-read-only-marker]")).to_contain_text("Read-only")
    lock = sheet.locator("[data-provider-lock]")
    expect(lock).to_have_attribute("data-provider-lock", "writes_off", timeout=NORMAL_TIMEOUT)
    expect(lock).to_have_text("TodoList can’t send changes to Jira from this connection.")
    link = sheet.locator("a[data-source-link]")
    expect(link).to_have_attribute("href", item["source"]["url"])

    # The provider's fields are shown, disabled under that hint; the start date is TodoList's own.
    edit = sheet.locator("[data-item-edit]")
    edit.get_by_role("button", name="Edit", exact=True).click()
    form = sheet.locator("[data-item-edit-form]")
    title = form.get_by_label("Title", exact=True)
    expect(title).to_be_disabled()
    expect(title).to_have_attribute("aria-describedby", re.compile(".+"))
    start = form.locator("[data-edit-field=startAt]")
    expect(start).to_have_attribute("data-origin", "override")
    expect(start.locator("[data-only-here]")).to_contain_text("Only in TodoList")
    # Nothing here goes to Jira, so the footer never promises it (and never claims it happened).
    expect(form.locator("[data-sends-to]")).to_have_count(0)
    expect(sheet.get_by_text("Saved to Jira too.")).to_have_count(0)
    start.locator("input[type=date]").fill("2027-01-04")
    form.locator("[data-item-edit-save]").click()
    expect(edit.locator("[data-save-status=saved]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(edit.locator("[data-sent-fields]")).to_have_count(0)
    stored = next(i for i in list_items(api_base_url, owner, demo["id"], provider="jira") if i["id"] == item["id"])
    assert stored["overlay"]["overrides"]["startAt"], "the start is kept as an override"

    # Use Jira's value: Jira has no start date, so the override goes.
    edit.get_by_role("button", name="Edit", exact=True).click()
    sheet.locator("[data-use-source=startAt]").click()
    expect(sheet.locator("[data-use-source=startAt]")).to_have_count(0, timeout=NORMAL_TIMEOUT)

    # The overlay still works: it never writes to Jira.
    sheet.get_by_role("switch", name="Hide from dashboards").click()
    overlay = sheet.locator("section[aria-labelledby=item-overlay]")
    expect(overlay.locator("[data-save-status=saved]")).to_be_visible()
    sheet.get_by_role("switch", name="Hide from dashboards").click()


def test_new_todo_repeat_needs_the_workspace_calendar(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """Repeat is like Google Calendar's; a repeating to-do goes to the workspace calendar only, so
    without one it says so, links to its settings, and can't be saved."""
    user, workspace = fresh_owner
    create_dashboard(api_base_url, user, workspace["id"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/dashboard")
    page.locator("[data-new-todo-open]").first.click()
    sheet = page.locator("[data-new-todo]")
    expect(sheet).to_be_visible(timeout=NORMAL_TIMEOUT)
    sheet.get_by_label("Title").fill("Water the plants")
    sheet.get_by_label("Due", exact=True).fill("2026-12-01")

    sheet.get_by_label("Repeat", exact=True).click()
    page.get_by_role("option", name=re.compile(r"^Weekly")).click()
    # 1 Dec 2026 is a Tuesday: the rule starts on its day; another day can be added.
    expect(sheet.locator("[data-weekday]")).to_have_count(7)
    expect(sheet.locator("[data-weekday=TU]")).to_have_attribute("aria-pressed", "true")
    # Google counts the first event, so the due date's day can't be unticked.
    expect(sheet.locator("[data-weekday=TU]")).to_have_attribute("aria-disabled", "true")
    # Playwright never clicks an aria-disabled control by itself: forced, the tap is ignored.
    sheet.locator("[data-weekday=TU]").click(force=True)
    expect(sheet.locator("[data-weekday=TU]")).to_have_attribute("aria-pressed", "true")
    sheet.locator("[data-weekday=TH]").click()
    expect(sheet.get_by_label("Repeat", exact=True)).to_have_text("Weekly on Tuesday and Thursday")

    expect(sheet.locator("[data-calendar-only]")).to_have_text(
        "Repeating to-dos are created in Google Calendar only"
    )
    blocked = sheet.locator("[data-repeat-blocked=unset]")
    expect(blocked).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(blocked.get_by_role("link", name="Open the workspace calendar settings")).to_have_attribute(
        "href", "/en/integrations"
    )
    expect(sheet.locator("[data-new-todo-save]")).to_be_disabled()

    # Ends after N times: a count out of range says so.
    sheet.get_by_role("radio", name="After").click()
    sheet.get_by_label("Number of times").fill("0")
    expect(sheet.locator("[data-repeat-problem]")).to_have_text("End after 1 to 999 times.")

    # Does not repeat: a plain to-do again.
    sheet.get_by_label("Repeat", exact=True).click()
    page.get_by_role("option", name="Does not repeat").click()
    expect(sheet.locator("[data-calendar-only]")).to_have_count(0)
    expect(sheet.locator("[data-new-todo-save]")).to_be_enabled()
