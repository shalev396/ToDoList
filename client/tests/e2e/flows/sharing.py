"""
Sharing between two people (plan "Workspaces & sharing", Review focus 2), through the UI:

1. The owner creates a workspace on onboarding.
2. The owner invites the classmate (a real account) as a viewer, on Members. A workspace is shared
   whole (PERMISSIONS-V2): there is no topic scoping.
3. The invite email reaches the classmate's Mail.tm inbox; the link comes from there.
4. The classmate logs in, opens the link and accepts: they see every topic, and Settings and
   Members are read-only for them.
5. The classmate, now in two workspaces, switches between them; nothing of one is shown in
   the other.

Two real Cognito accounts (Mail.tm signups) and one invite email through the stage's queue and SES.
"""
import re

import pytest
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.mailtm import wait_for_invite_path
from tests.helpers.select import choose
from tests.helpers.users import new_user
from tests.helpers.workspaces import (
    create_workspace,
    invite_path,
    list_workspaces,
    ensure_topics,
    open_as,
    sign_in,
)

TOPICS = ("Work", "College", "Personal")


@pytest.mark.email
def test_owner_shares_college_with_a_classmate(
    page: Page, base_url: str, app_url: str, api_base_url: str, fresh_user
):
    owner = fresh_user
    classmate = new_user(api_base_url)
    classmate_email = classmate.email

    # 1. The owner creates a workspace.
    open_as(page, base_url, owner, "/en/onboarding", h1="Welcome to TodoList")
    page.get_by_label("Name", exact=True).fill("Shared Studies")
    page.get_by_role("checkbox", name="Load demo data").uncheck()
    page.get_by_role("button", name="Create workspace").click()
    # A new workspace starts with one empty Personal page (D1).
    expect(page).to_have_url(re.compile(rf"^{re.escape(app_url)}/(dashboard|t/personal)$"), timeout=LONG_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_text("Personal", timeout=NORMAL_TIMEOUT)
    expect(page.get_by_text("This page is empty")).to_be_visible()
    expect(page.get_by_role("button", name="Add block")).to_be_visible()
    expect(page.get_by_role("link", name="Use a template")).to_be_visible()
    workspace = list_workspaces(api_base_url, owner)[0]["workspace"]
    ensure_topics(api_base_url, owner, workspace["id"], ["work", "college", "personal"])

    # 2. A viewer invite, for the whole workspace.
    page.goto(f"{app_url}/settings/members", wait_until="load")
    page.get_by_role("button", name="Share", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Email addresses").fill(classmate_email)
    choose(dialog.get_by_label("Access", exact=True), "Can view")
    expect(dialog.get_by_role("checkbox", name="Work")).to_have_count(0)
    dialog.get_by_role("button", name="Send invite").click()

    expect(page.get_by_text("Invite sent")).to_be_visible(timeout=NORMAL_TIMEOUT)

    # 3. The link is in the invite email.
    link = wait_for_invite_path(classmate)

    # 4. The classmate signs in and opens the link.
    sign_in(page, base_url, classmate)
    page.goto(f"{base_url}{invite_path(link)}", wait_until="load")
    page.get_by_role("button", name="Accept invite").click()
    expect(page).to_have_url(re.compile(rf"^{re.escape(app_url)}/(dashboard|t/college)$"), timeout=LONG_TIMEOUT)
    nav = page.get_by_role("navigation", name="Main")
    expect(nav.get_by_role("button", name="Shared Studies, switch workspace")).to_be_visible()
    for topic in TOPICS:
        expect(nav.get_by_role("link", name=topic, exact=True)).to_be_visible()
    # A viewer reads pages; adding, renaming and deleting them is for editors and owners.
    expect(nav.get_by_role("button", name="Add page")).to_have_count(0)
    expect(nav.get_by_role("button", name="Options for Work")).to_have_count(0)
    # A viewer sees "Workspace" with their role, not "Settings".
    expect(nav.get_by_role("link", name="Settings", exact=True)).to_have_count(0)
    expect(nav.get_by_role("link", name="Workspace (Viewer)")).to_be_visible()

    page.goto(f"{app_url}/t/work", wait_until="load")
    expect(page.get_by_role("heading", level=1)).to_have_text("Work", timeout=NORMAL_TIMEOUT)

    # No Settings edits.
    page.goto(f"{app_url}/settings", wait_until="load")
    expect(page.get_by_text("You’re a viewer here.", exact=False)).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_label("Name", exact=True)).to_be_disabled()
    expect(page.get_by_role("button", name="Add page")).to_have_count(0)
    expect(page.get_by_role("button", name="Add rule")).to_have_count(0)
    expect(page.get_by_role("button", name="Delete workspace")).to_have_count(0)

    page.goto(f"{app_url}/settings/members", wait_until="load")
    page.get_by_role("button", name="Share", exact=True).click()
    dialog = page.get_by_role("dialog")
    people = dialog.get_by_role("region", name="People with access")
    expect(people.get_by_role("listitem")).to_have_count(2, timeout=NORMAL_TIMEOUT)
    expect(dialog.get_by_role("button", name="Send invite")).to_have_count(0)
    expect(people.get_by_role("combobox")).to_have_count(0)
    page.keyboard.press("Escape")
    expect(page.get_by_role("button", name="Leave workspace")).to_be_visible()

    # 5. In two workspaces: switching keeps them apart.
    create_workspace(api_base_url, classmate, "Classmate Own")
    page.reload(wait_until="load")
    page.get_by_role("button", name="Share", exact=True).click()
    expect(people.get_by_role("listitem")).to_have_count(2, timeout=NORMAL_TIMEOUT)
    page.keyboard.press("Escape")
    nav.get_by_role("button", name="Shared Studies, switch workspace").click()
    page.get_by_role("menuitemradio", name="Classmate Own").click()
    expect(page).to_have_url(re.compile(rf"^{re.escape(app_url)}/(dashboard|t/personal)$"), timeout=NORMAL_TIMEOUT)
    expect(nav.get_by_role("button", name="Classmate Own, switch workspace")).to_be_visible()
    # Their own workspace starts with Personal only.
    expect(nav.get_by_role("link", name="Personal", exact=True)).to_be_visible()
    for topic in ("Work", "College"):
        expect(nav.get_by_role("link", name=topic, exact=True)).to_have_count(0)
    expect(nav.get_by_role("link", name="Settings", exact=True)).to_be_visible()

    page.goto(f"{app_url}/settings/members", wait_until="load")
    page.get_by_role("button", name="Share", exact=True).click()
    expect(people.get_by_role("listitem")).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(people).not_to_contain_text(owner.email.split("@")[0])
    page.keyboard.press("Escape")

    # Back to the shared workspace through ⌘K.
    page.keyboard.press("Control+k")
    page.keyboard.type("switch shared")
    page.keyboard.press("Enter")
    expect(nav.get_by_role("button", name="Shared Studies, switch workspace")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    # Shared whole: every page is back (PERMISSIONS-V2, no topic scoping).
    for topic in TOPICS:
        expect(nav.get_by_role("link", name=topic, exact=True)).to_be_visible()
