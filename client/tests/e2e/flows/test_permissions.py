"""
Permissions v2 between two members (docs/design/PERMISSIONS-V2.md), through the UI:

1. A connects Jira with a FAKE token; it is private. A template never shares it silently: the
   gallery asks first, and "Create without them" keeps it private. A attaches it to a block, and
   the first attach asks: "Adding <site> shares its items with everyone in <workspace>".
2. B (an editor) sees A's provider icon on Members, never A's account: not on the block, not on
   Members, not on Integrations.
3. B can't add A's connector: the block editor never offers it, and the server refuses it.
4. A stops sharing (after a confirmation), and the block that read only it says a source was
   removed.

Two real accounts (the worker's owner and second account). The token is FAKE and a stage reaches
the real provider, so nothing here syncs or tests the connection: what a shared source's items look
like to another member (rows, never the account) is covered by the server's HTTP tests
(server/src/sync and the integrations route tests), with their provider stand-ins.
"""
import re

import requests
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import create_dashboard, get_dashboard
from tests.helpers.items import list_items
from tests.helpers.workspaces import (
    accept_invite,
    create_invite,
    ensure_topics,
    invite_token,
    open_as,
)
from tests.viewports import DESKTOP_VIEWPORT

SITE = "perm-fake.atlassian.net"


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _jira_card(page: Page):
    return page.locator("[data-integration-card=jira]").filter(has_text=SITE)


def _connect_jira(page: Page) -> None:
    page.locator("[data-integration-card=jira]").first.get_by_role(
        "button", name="Use a token instead"
    ).click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Site address").fill(f"https://{SITE}")
    dialog.get_by_label("Email").fill("fake@example.test")
    dialog.locator("[data-secret-field=token]").fill("ATATT3xFAKEtokenForE2ENeverReal1234567890")
    dialog.get_by_role("button", name="Save and connect").click()
    dialog.get_by_role("button", name="Done").click()
    expect(dialog).to_have_count(0)


def test_share_on_attach_between_two_members(
    page: Page, base_url: str, api_base_url: str, fresh_owner, second_user
):
    owner, workspace = fresh_owner
    wid = workspace["id"]
    member = second_user
    invite = create_invite(api_base_url, owner, wid, member.email, role="editor")
    accept_invite(api_base_url, member, invite_token(invite["inviteUrl"]))
    # The main dashboard first: a template binds the integrations its creator has then (none).
    dashboard = create_dashboard(api_base_url, owner, wid)
    page.set_viewport_size(DESKTOP_VIEWPORT)

    # 1. A connects Jira (FAKE token): private until it is on a block.
    open_as(page, base_url, owner, "/en/integrations")
    _connect_jira(page)
    expect(_jira_card(page).locator("[data-sharing]")).to_have_attribute(
        "data-sharing", "private", timeout=NORMAL_TIMEOUT
    )
    mine = requests.get(
        f"{api_base_url}/private/workspaces/{wid}/integrations", headers=_headers(owner), timeout=15
    ).json()["data"]
    integration_id = next(entry["id"] for entry in mine if entry["provider"] == "jira")
    assert list_items(api_base_url, member, wid, "jira") == [], "B sees A's unshared items"

    # A template never shares silently: the gallery names what it would attach, and "Create
    # without them" keeps the integration private.
    ensure_topics(api_base_url, owner, wid, ["work"])
    open_as(page, base_url, owner, "/en/templates")
    page.locator("[data-template^='work@']").get_by_role("button", name="Use template").click()
    ask = page.locator("[data-template-share-confirm]")
    # Named by its account label (the card's), with the workspace it would be shared with.
    expect(ask).to_contain_text(SITE, timeout=NORMAL_TIMEOUT)
    expect(ask).to_contain_text(f"shares its items with everyone in {workspace['name']}")
    ask.locator("[data-template-share-without]").click()
    expect(page).to_have_url(re.compile(r"/en/t/work\?dashboard="), timeout=NORMAL_TIMEOUT)
    sharing = requests.get(
        f"{api_base_url}/private/workspaces/{wid}/integrations/sharing",
        headers=_headers(owner),
        timeout=15,
    ).json()["data"]
    assert sharing == {"shared": []}, "a template shared A's Jira without asking"

    # A attaches it to a block: the first attach asks, naming the workspace.
    open_as(page, base_url, owner, "/en/dashboard?edit=1")
    page.locator("[data-add-block]").click()
    editor = page.locator("[data-block-editor]")
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()
    # Not shared yet: the click asks first instead of ticking it.
    editor.locator("[data-connectors]").get_by_label(SITE).click()
    confirm = page.locator("[data-share-confirm]")
    expect(confirm).to_contain_text(f"shares its items with everyone in {workspace['name']}")
    confirm.get_by_role("button", name="Share", exact=True).click()
    expect(editor.locator("[data-connectors]").get_by_label(SITE)).to_be_checked()
    editor.locator("[data-editor-step=viz]").click()
    editor.get_by_label("Title", exact=True).fill("Team issues")
    editor.locator("[data-editor-save]").click()
    expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    saved = get_dashboard(api_base_url, owner, wid, dashboard["id"])
    block = next(b for b in saved["blocks"] if b["title"] == "Team issues")
    assert block["connectors"] == [integration_id]
    open_as(page, base_url, owner, "/en/integrations")
    expect(_jira_card(page).locator("[data-sharing]")).to_have_attribute(
        "data-sharing", "shared", timeout=NORMAL_TIMEOUT
    )
    page.screenshot(path="screens/h1/owner-shared.png")

    # 2. B sees A's provider icon, never A's account.
    open_as(page, base_url, member, "/en/dashboard", workspace_id=wid)
    block = page.get_by_role("article", name="Team issues")
    expect(block).to_be_visible(timeout=LONG_TIMEOUT)
    expect(page.get_by_text(SITE)).to_have_count(0)
    open_as(page, base_url, member, "/en/settings/members", workspace_id=wid)
    page.get_by_role("button", name="Share", exact=True).click()
    icons = page.get_by_role("dialog").locator("[data-member-providers=jira]")
    expect(icons).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(icons).to_have_attribute("aria-label", "Connected: Jira")
    expect(page.get_by_text(SITE)).to_have_count(0)
    page.screenshot(path="screens/h1/member-icons.png")
    open_as(page, base_url, member, "/en/integrations", workspace_id=wid)
    expect(page.locator("[data-integration-card=jira]").first).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(page.get_by_text(SITE)).to_have_count(0)
    expect(page.locator("[data-sharing]")).to_have_count(0)

    # 3. B can't add A's connector: never offered, and refused by the server.
    open_as(page, base_url, member, "/en/dashboard?edit=1", workspace_id=wid)
    page.locator("[data-add-block]").click()
    editor = page.locator("[data-block-editor]")
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()
    expect(editor.locator("[data-connectors]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(editor.locator("[data-connector-label]")).to_have_count(0)
    expect(editor.get_by_text(SITE)).to_have_count(0)
    page.keyboard.press("Escape")
    current = get_dashboard(api_base_url, member, wid, dashboard["id"])
    refused = requests.post(
        f"{api_base_url}/private/workspaces/{wid}/dashboards/{dashboard['id']}/ops",
        json={
            "expectedVersion": current["version"],
            "ops": [
                {
                    "op": "add_block",
                    "block": {"type": "list", "query": {"source": "items"}, "connectors": [integration_id]},
                }
            ],
        },
        headers=_headers(member),
        timeout=15,
    )
    assert refused.status_code == 404, refused.text
    assert refused.json().get("code") == "integration_not_found"

    # 4. A stops sharing; B no longer sees the items.
    open_as(page, base_url, owner, "/en/integrations")
    _jira_card(page).locator("[data-stop-sharing]").click()
    stop = page.locator("[data-stop-sharing-confirm]")
    expect(stop).to_contain_text("other members’ dashboards included")
    stop.get_by_role("button", name="Stop sharing", exact=True).click()
    expect(_jira_card(page).locator("[data-sharing]")).to_have_attribute(
        "data-sharing", "private", timeout=NORMAL_TIMEOUT
    )
    assert list_items(api_base_url, member, wid, "jira") == []
    open_as(page, base_url, member, "/en/dashboard", workspace_id=wid)
    block = page.get_by_role("article", name="Team issues")
    expect(block).to_be_visible(timeout=LONG_TIMEOUT)
    # It read only A's Jira: it reads nothing now (never every source) and says why.
    expect(block.locator("[data-source-removed]")).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(block.get_by_role("listitem")).to_have_count(0, timeout=NORMAL_TIMEOUT)
    page.screenshot(path="screens/h1/member-after-stop.png")
