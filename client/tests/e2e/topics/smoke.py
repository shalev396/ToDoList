"""
Dynamic topics (H2): an editor or owner adds a page from the sidebar (a name and an optional
template), renames it in place and deletes it after a confirmation. Deleting removes only the
page's dashboards; its items stay, Unsorted.

Each test owns a fresh workspace (deleted after it).
"""
import re

import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import list_dashboards
from tests.helpers.items import create_local_item
from tests.helpers.select import choose
from tests.helpers.workspaces import create_topic, list_topics, open_as
from tests.viewports import DESKTOP_VIEWPORT


def _nav(page: Page):
    return page.get_by_role("navigation", name="Main")


def _topic(api_base_url: str, user, workspace_id: str, slug: str):
    return next(
        (topic for topic in list_topics(api_base_url, user, workspace_id) if topic["slug"] == slug),
        None,
    )


def test_owner_adds_a_page_from_a_template(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/personal", h1="Personal")

    _nav(page).get_by_role("button", name="Add page").click()
    dialog = page.get_by_role("dialog", name="Add a page")
    expect(dialog).to_be_visible(timeout=NORMAL_TIMEOUT)
    # A name is required.
    dialog.get_by_role("button", name="Add page").click()
    expect(dialog.get_by_role("alert")).to_have_text("Give the page a name.")
    dialog.get_by_label("Name", exact=True).fill("Night job")
    choose(dialog.get_by_role("combobox", name="Start from"), "Work layout")
    dialog.get_by_role("button", name="Add page").click()

    # The new page opens at once, from the template, under its standardized slug.
    expect(page).to_have_url(re.compile(r"/en/t/night-job$"), timeout=LONG_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_text("Night job", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("article").first).to_be_visible(timeout=LONG_TIMEOUT)
    expect(_nav(page).get_by_role("link", name="Night job", exact=True)).to_be_visible()

    topic = _topic(api_base_url, user, workspace["id"], "night-job")
    assert topic is not None and topic["name"] == "Night job"
    pages = list_dashboards(api_base_url, user, workspace["id"], "night-job", "topic")
    assert len(pages) == 1
    assert pages[0]["scope"]["topicId"] == topic["id"]


def test_owner_renames_a_page_in_place(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    create_topic(api_base_url, user, workspace["id"], "Side gig")
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/side-gig", h1="Side gig")

    _nav(page).get_by_role("button", name="Options for Side gig").click()
    page.get_by_role("menuitem", name="Rename").click()
    field = _nav(page).get_by_role("textbox", name="New name for Side gig")
    expect(field).to_be_focused()
    field.fill("Freelance")
    field.press("Enter")

    expect(page.get_by_text("Renamed to “Freelance”")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(_nav(page).get_by_role("link", name="Freelance", exact=True)).to_be_visible()
    expect(_nav(page).get_by_role("link", name="Side gig", exact=True)).to_have_count(0)
    # The address stays: a rename never moves a page's slug.
    expect(page).to_have_url(re.compile(r"/en/t/side-gig$"))
    topic = _topic(api_base_url, user, workspace["id"], "side-gig")
    assert topic is not None and topic["name"] == "Freelance"

    # Escape keeps the old name.
    _nav(page).get_by_role("button", name="Options for Freelance").click()
    page.get_by_role("menuitem", name="Rename").click()
    field = _nav(page).get_by_role("textbox", name="New name for Freelance")
    field.fill("Nope")
    field.press("Escape")
    expect(_nav(page).get_by_role("link", name="Freelance", exact=True)).to_be_visible()
    assert _topic(api_base_url, user, workspace["id"], "side-gig")["name"] == "Freelance"


def test_owner_deletes_a_page_and_its_items_stay_unsorted(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    created = create_topic(api_base_url, user, workspace["id"], "Gym", template_key="personal@1")
    gym_id = created["topic"]["id"]
    item = create_local_item(api_base_url, user, workspace["id"], "Renew the membership", "gym")
    assert item["topicId"] == gym_id
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/t/gym", h1="Gym")

    _nav(page).get_by_role("button", name="Options for Gym").click()
    page.get_by_role("menuitem", name="Delete").click()
    confirm = page.get_by_role("alertdialog", name="Delete “Gym”?")
    expect(confirm).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(confirm).to_contain_text("Its items stay in the workspace as Unsorted")
    confirm.get_by_role("button", name="Delete page").click()

    expect(page.get_by_text("“Gym” was deleted")).to_be_visible(timeout=NORMAL_TIMEOUT)
    # Off the deleted page: home is the one topic left.
    expect(page).to_have_url(re.compile(r"/en/(dashboard|t/personal)$"), timeout=NORMAL_TIMEOUT)
    expect(_nav(page).get_by_role("link", name="Gym", exact=True)).to_have_count(0)

    assert _topic(api_base_url, user, workspace["id"], "gym") is None
    headers = {"Authorization": f"Bearer {user.id_token}"}
    base = f"{api_base_url}/private/workspaces/{workspace['id']}"
    pages = requests.get(f"{base}/dashboards", params={"topic": gym_id}, headers=headers, timeout=15)
    assert pages.status_code == 200 and pages.json()["data"] == []
    kept = requests.get(f"{base}/items/{item['id']}", headers=headers, timeout=15)
    assert kept.status_code == 200, kept.text
    assert kept.json()["data"]["title"] == "Renew the membership"
    assert kept.json()["data"]["topicId"] is None

    # Its old address now says the page is gone.
    page.goto(f"{base_url}/en/t/gym", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text(
        "This page isn’t available", timeout=NORMAL_TIMEOUT
    )
