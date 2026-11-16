"""
Workspace settings (/settings). Each test owns a fresh workspace (deleted after it), since it
changes it. Read-only views for editors and viewers are covered by flows/sharing.py.
"""
import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.select import choose
from tests.helpers.workspaces import ensure_topics, get_workspace, list_topics, list_workspaces, open_as


def test_settings_redirects_unauthenticated(page: Page, app_url: str):
    page.goto(f"{app_url}/settings", wait_until="load")
    expect(page).to_have_url(f"{app_url}/auth/login?next=%2Fen%2Fsettings")


def test_owner_edits_and_saves(
    page: Page, base_url: str, app_url: str, api_base_url: str, fresh_owner
):
    """Name and week start, saved in one go: the sidebar and the switcher follow."""
    user, workspace = fresh_owner
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    expect(page.get_by_label("Link name")).to_have_value(workspace["slug"])
    expect(page.get_by_role("button", name="Save changes")).to_have_count(0)

    page.get_by_label("Name", exact=True).fill("Renamed Lab")
    page.get_by_text("Monday", exact=True).click()
    page.get_by_role("button", name="Save changes").click()
    expect(page.get_by_text("Settings saved")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("button", name="Save changes")).to_have_count(0)

    nav = page.get_by_role("navigation", name="Main")
    expect(nav.get_by_role("button", name="Renamed Lab, switch workspace")).to_be_visible()

    saved = get_workspace(api_base_url, user, workspace["id"])
    assert saved["name"] == "Renamed Lab"
    assert saved["settings"]["weekStart"] == "mon"
    assert "areas" not in saved["settings"]


def test_a_new_workspace_starts_with_personal_only(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    """D1: the Personal page only; the Topics section lists the pages and links to them."""
    user, workspace = fresh_owner
    slugs = [topic["slug"] for topic in list_topics(api_base_url, user, workspace["id"])]
    assert slugs == ["personal"]
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    topics = page.locator("section").filter(has=page.get_by_role("heading", name="Topics"))
    expect(topics.get_by_role("link", name="Personal", exact=True)).to_be_visible()
    expect(topics.get_by_role("button", name="Add page")).to_be_visible()
    topics.get_by_role("link", name="Personal", exact=True).click()
    expect(page.get_by_role("heading", level=1)).to_have_text("Personal", timeout=NORMAL_TIMEOUT)


def test_topic_rules_add_reorder_remove(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    ids = {
        topic["slug"]: topic["id"]
        for topic in ensure_topics(api_base_url, user, workspace["id"], ["work", "college"])
    }
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    expect(page.get_by_text("No rules yet.", exact=False)).to_be_visible()
    for match, topic in (("shalev396/*", "Personal"), ("acme/*", "Work"), ("cs101*", "College")):
        page.get_by_role("button", name="Add rule").click()
        rule = page.get_by_role("listitem").filter(has=page.get_by_role("textbox")).last
        rule.get_by_role("textbox").fill(match)
        choose(rule.get_by_role("combobox"), topic)
    page.get_by_role("button", name="Move rule 2 up").click()
    page.get_by_role("button", name="Remove rule 3").click()
    page.get_by_role("button", name="Save changes").click()
    expect(page.get_by_text("Settings saved")).to_be_visible(timeout=NORMAL_TIMEOUT)

    rules = get_workspace(api_base_url, user, workspace["id"])["settings"]["topicRules"]
    assert rules == [
        {"match": "acme/*", "topicId": ids["work"]},
        {"match": "shalev396/*", "topicId": ids["personal"]},
    ]


def test_an_empty_rule_blocks_saving(page: Page, base_url: str, fresh_owner):
    user, _ = fresh_owner
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    page.get_by_role("button", name="Add rule").click()
    page.get_by_role("button", name="Save changes").click()
    expect(page.get_by_text("Enter a pattern, or remove the rule.")).to_be_visible()


def test_time_zone_is_searchable(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    page.get_by_label("Time zone").click()
    page.get_by_role("combobox", name="Search time zones").fill("tokyo")
    page.get_by_role("option", name="Asia/Tokyo", exact=False).click()
    expect(page.get_by_label("Time zone")).to_contain_text("Asia/Tokyo")
    page.get_by_role("button", name="Save changes").click()
    expect(page.get_by_text("Settings saved")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert get_workspace(api_base_url, user, workspace["id"])["settings"]["timezone"] == "Asia/Tokyo"


def test_delete_workspace_needs_its_name(
    page: Page, base_url: str, app_url: str, api_base_url: str, fresh_owner
):
    """Typing the name enables the delete; the user had only this workspace, so they land
    on onboarding."""
    user, workspace = fresh_owner
    open_as(page, base_url, user, "/en/settings", h1="Settings")
    page.get_by_role("button", name="Delete workspace").click()
    dialog = page.get_by_role("alertdialog")
    confirm = dialog.get_by_role("button", name="Delete workspace")
    expect(confirm).to_be_disabled()
    dialog.get_by_label("Workspace name").fill("Not the name")
    expect(confirm).to_be_disabled()
    dialog.get_by_label("Workspace name").fill(workspace["name"])
    confirm.click()
    expect(page).to_have_url(f"{app_url}/onboarding", timeout=LONG_TIMEOUT)
    assert workspace["id"] not in [w["workspace"]["id"] for w in list_workspaces(api_base_url, user)]
    gone = requests.get(
        f"{api_base_url}/private/workspaces/{workspace['id']}",
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert gone.status_code == 404
