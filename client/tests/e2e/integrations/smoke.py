"""
Integrations, agent keys and the template gallery.

Each test owns a fresh workspace on a pooled account. Tokens in these tests are FAKE strings: the
point is where they travel, which is only the body of the credential PUT. A stage reaches the real
provider, so a FAKE token never passes "Test connection" and nothing syncs: what a working
connection, a sync and the OAuth handshakes do is covered by the server tests (server/src/sync,
server/src/services/*OAuth*.test.ts and the integrations route tests), not here.
"""
import re

from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.dashboards import list_dashboards
from tests.helpers.integrations import start_connect_link
from tests.helpers.workspaces import ensure_topics, open_as
from tests.viewports import DESKTOP_VIEWPORT

FAKE_TOKEN = "ghp_FAKEtokenForE2ENeverReal1234567890"
FAKE_PROJECTS_TOKEN = "ghp_FAKEprojectsTokenNeverReal0987654321"
FAKE_FRAGMENT = "FAKE"


def _card(page: Page, provider: str):
    return page.locator(f"[data-integration-card={provider}]")


def test_connect_github_keeps_the_token_in_one_request_body(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    requests_seen = []
    console_lines = []
    page.on("request", lambda r: requests_seen.append((r.method, r.url, r.post_data or "")))
    page.on("console", lambda m: console_lines.append(m.text))
    open_as(page, base_url, user, "/en/integrations")

    github = _card(page, "github")
    expect(github).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(github.locator("[data-status-text]")).to_have_text("Not connected")
    github.get_by_role("button", name="Use a token instead").click()

    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Owner", exact=True).fill("shalev396")
    token = dialog.locator("[data-secret-field=token]")
    projects = dialog.locator("[data-secret-field=projectsToken]")
    for field in (token, projects):
        expect(field).to_have_attribute("type", "password")
        expect(field).to_have_attribute("autocomplete", "off")
    # No reveal control, and the help for both tokens is there.
    expect(dialog.get_by_role("button", name=re.compile("show|reveal", re.I))).to_have_count(0)
    expect(dialog.get_by_text("read:project")).to_be_visible()
    token.fill(FAKE_TOKEN)
    projects.fill(FAKE_PROJECTS_TOKEN)
    dialog.get_by_role("button", name="Save and connect").click()

    expect(dialog.get_by_text("Saved. Test the connection to finish.")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    # Inputs are gone, and nothing on the page holds the secret.
    expect(dialog.locator("[data-secret-field]")).to_have_count(0)

    dialog.get_by_role("button", name="Test connection").click()
    # The provider rejects a FAKE token: the failure is shown, and the card keeps the connection.
    result = dialog.locator("[data-test-result]")
    expect(result).to_be_visible(timeout=LONG_TIMEOUT)
    assert result.get_attribute("data-test-result") != "ok"
    dialog.get_by_role("button", name="Done").click()

    # The card shows the status shape: a status, and the connection stays listed.
    expect(github.locator("[data-status-text]")).not_to_have_text("Not connected", timeout=NORMAL_TIMEOUT)

    # The FAKE tokens travelled only in the body of the credential PUT.
    carriers = [(m, u) for m, u, body in requests_seen if FAKE_FRAGMENT in body or FAKE_FRAGMENT in u]
    assert len(carriers) == 1, carriers
    method, url = carriers[0]
    assert method == "PUT" and url.endswith("/credential"), carriers
    put_body = next(body for m, u, body in requests_seen if m == "PUT" and u.endswith("/credential"))
    assert FAKE_TOKEN in put_body and FAKE_PROJECTS_TOKEN in put_body
    html = page.content()
    assert FAKE_FRAGMENT not in html
    storage = page.evaluate(
        "() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])"
    )
    assert FAKE_FRAGMENT not in storage
    assert not any(FAKE_FRAGMENT in line for line in console_lines)
    assert FAKE_FRAGMENT not in page.url


def test_a_viewer_sees_the_cards_read_only(
    page: Page, base_url: str, api_base_url: str, fresh_owner, second_user
):
    from tests.helpers.workspaces import accept_invite, create_invite, invite_token

    user, workspace = fresh_owner
    viewer = second_user
    invite = create_invite(api_base_url, user, workspace["id"], viewer.email, "viewer")
    accept_invite(api_base_url, viewer, invite_token(invite["inviteUrl"]))
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, viewer, "/en/integrations", workspace_id=workspace["id"])
    expect(_card(page, "github")).to_be_visible(timeout=NORMAL_TIMEOUT)
    # PERMISSIONS-V2: viewers connect nothing; editors and owners connect their own.
    expect(page.locator("[data-integrations-read-only]")).to_contain_text("Viewers can’t connect accounts.")
    expect(page.get_by_role("button", name="Connect")).to_have_count(0)
    expect(page.get_by_role("button", name="Use a token instead")).to_have_count(0)


def test_agent_key_is_shown_once_and_can_be_revoked(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/settings/agent-keys")
    page.get_by_role("button", name="New key").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Name").fill("Laptop assistant")
    dialog.get_by_role("button", name="Create key").click()

    raw = dialog.locator("[data-copy-field=agentKey]")
    expect(raw).to_be_visible(timeout=NORMAL_TIMEOUT)
    key = raw.input_value()
    assert key.startswith("elk_")
    # Escape does not lose it: only the explicit button closes.
    page.keyboard.press("Escape")
    expect(raw).to_be_visible()
    dialog.get_by_role("button", name="I’ve stored it").click()
    expect(page.get_by_role("dialog")).to_have_count(0)

    row = page.locator("[data-agent-key='Laptop assistant']")
    expect(row).to_be_visible()
    expect(row).to_contain_text(key[:8])
    assert key not in page.content()
    page.reload()
    expect(page.locator("[data-agent-key='Laptop assistant']")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert key not in page.content()
    assert key not in page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")

    row = page.locator("[data-agent-key='Laptop assistant']")
    row.get_by_role("button", name="Revoke").click()
    page.get_by_role("alertdialog").get_by_role("button", name="Revoke").click()
    expect(page.locator("[data-agent-key='Laptop assistant'][data-revoked]")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )


def test_connect_link_opens_the_form_and_a_reused_one_says_so(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    path = start_connect_link(api_base_url, user, workspace["id"], "github")
    open_as(page, base_url, user, path)
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_role("heading", name="Connect GitHub")).to_be_visible(timeout=NORMAL_TIMEOUT)
    assert "link=" not in page.url  # the single-use link leaves the address bar

    # The same link again: already used.
    page.keyboard.press("Escape")
    page.goto(f"{base_url}{path}", wait_until="load")
    expect(page.locator("[data-connect-link-error]")).to_contain_text(
        "already used", timeout=NORMAL_TIMEOUT
    )
    expect(page.get_by_role("dialog")).to_have_count(0)


def test_template_gallery_creates_a_dashboard(page: Page, base_url: str, api_base_url: str, fresh_owner):
    user, workspace = fresh_owner
    # A new workspace starts with Personal only; the Work template goes on the Work page.
    ensure_topics(api_base_url, user, workspace["id"], ["work", "college", "personal"])
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/templates")
    card = page.locator("[data-template^='work@']")
    expect(card).to_be_visible(timeout=NORMAL_TIMEOUT)
    expect(card.locator("[data-mini-block]").first).to_be_visible()
    card.get_by_role("button", name="Use template").click()
    expect(page).to_have_url(re.compile(r"/en/t/work\?dashboard=[0-9a-f-]+$"), timeout=NORMAL_TIMEOUT)
    expect(page.get_by_role("heading", level=1)).to_have_text("Work", timeout=NORMAL_TIMEOUT)
    assert list_dashboards(api_base_url, user, workspace["id"], "work")


def test_sync_to_calendar_dry_run_shows_counts_or_a_clear_error(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    import requests

    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    button = page.locator("[data-gcal-sync]")
    expect(button).to_be_disabled(timeout=NORMAL_TIMEOUT)  # no calendar connected yet
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace['id']}/integrations",
        json={"provider": "google_calendar", "config": {"calendars": []}},
        headers={"Authorization": f"Bearer {user.id_token}"},
        timeout=15,
    )
    assert response.status_code == 201
    page.reload()
    expect(button).to_be_enabled(timeout=NORMAL_TIMEOUT)
    button.click()
    dialog = page.get_by_role("dialog")
    # With no connected calendar the server refuses: the message is ours, translated, not the
    # server's English.
    outcome = dialog.locator("[data-gcal-counts], [data-gcal-sync-error]")
    expect(outcome).to_be_visible(timeout=NORMAL_TIMEOUT)
