"""
Many-to-one (B1): two connections of the same provider in one workspace.
Tokens are FAKE strings and a stage reaches the real provider, so "Test connection" fails and nothing
syncs (the sync and handshake logic is covered by the server tests). The point is the page: one Jira card whose Manage panel lists both sites, both in the
block editor's connector list, and disconnecting one leaves the other.
"""
from playwright.sync_api import Page, expect

from tests.config import LONG_TIMEOUT, NORMAL_TIMEOUT
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT

SITES = ["alpha-fake.atlassian.net", "beta-fake.atlassian.net"]


def _open_token_form(scope) -> None:
    scope.locator("[data-token-fallback] summary").click()
    scope.locator("[data-use-token]").click()


def _card(page: Page):
    """The provider's one card: it never repeats, whatever number of accounts."""
    return page.locator("[data-integration-card=jira]")


def _accounts(page: Page):
    """The connections, listed in the provider's Manage panel (open it with `_open_manage`)."""
    return page.locator("[data-integration-account=jira]")


def _open_manage(page: Page) -> None:
    page.locator("[data-integration-manage=jira]").click()
    expect(page.locator("[data-integration-panel=jira]")).to_be_visible(timeout=NORMAL_TIMEOUT)


def _form(page: Page):
    """The connect form, never the Manage panel it can open over."""
    return page.locator("[role=dialog]:not([data-integration-panel])")


def _connect_jira(page: Page, site: str, first: bool) -> None:
    if first:
        _open_token_form(_card(page))
    else:
        _open_token_form(page.locator("[data-connect-another=jira]"))
    dialog = _form(page)
    dialog.get_by_label("Site address").fill(f"https://{site}")
    dialog.get_by_label("Email").fill("fake@example.test")
    dialog.locator("[data-secret-field=token]").fill("ATATT3xFAKEtokenForE2ENeverReal1234567890")
    dialog.get_by_role("button", name="Save and connect").click()
    dialog.get_by_role("button", name="Test connection").click()
    expect(dialog.locator("[data-test-result]")).to_be_visible(timeout=LONG_TIMEOUT)  # a FAKE token fails
    dialog.get_by_role("button", name="Done").click()
    expect(dialog).to_have_count(0)


def test_two_jira_connections_show_in_the_card_the_editor_and_disconnect_one(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    expect(_card(page)).to_have_count(1, timeout=NORMAL_TIMEOUT)
    # Nothing connected: Connect, no Manage button and no panel.
    expect(_card(page).locator("[data-oauth-connect=jira]")).to_be_visible()
    expect(page.locator("[data-integration-manage=jira]")).to_have_count(0)
    expect(page.locator("[data-integration-panel=jira]")).to_have_count(0)

    _connect_jira(page, SITES[0], first=True)
    # One account: the card names it and offers Manage.
    expect(_card(page).locator("[data-provider-summary]")).to_contain_text(SITES[0], timeout=NORMAL_TIMEOUT)
    _open_manage(page)
    expect(_accounts(page)).to_have_count(1, timeout=NORMAL_TIMEOUT)
    _connect_jira(page, SITES[1], first=False)

    # Still one card; its panel lists both connections, each with its account label and status.
    expect(_card(page)).to_have_count(1)
    expect(_accounts(page)).to_have_count(2, timeout=NORMAL_TIMEOUT)
    for site in SITES:
        account = _accounts(page).filter(has_text=site)
        expect(account).to_have_count(1)
        expect(account.locator("[data-status-text]")).to_be_visible()
        expect(account.get_by_role("button", name="Sync now")).to_be_visible()
        expect(account.get_by_role("button", name="Test connection")).to_be_visible()
    # A second Jira site is offered another, and the same site again is refused with a clear message.
    expect(page.locator("[data-connect-another=jira]")).to_be_visible()
    # Closing the panel returns to the card, which counts the accounts.
    page.keyboard.press("Escape")
    expect(page.locator("[data-integration-panel=jira]")).to_have_count(0)
    expect(_card(page).locator("[data-provider-summary]")).to_have_text("2 accounts")
    expect(page.locator("[data-integration-manage=jira]")).to_be_focused()

    # The block editor's connector list offers both.
    open_as(page, base_url, user, "/en/t/personal")
    page.get_by_role("button", name="Edit", exact=True).click()
    page.locator("[data-add-block]").click()
    editor = page.locator("[data-block-editor]")
    expect(editor).to_be_visible(timeout=NORMAL_TIMEOUT)
    editor.locator("[data-block-type=list]").click()
    labels = editor.locator("[data-connectors] [data-connector-label]")
    expect(labels).to_have_count(2, timeout=NORMAL_TIMEOUT)
    for site in SITES:
        expect(labels.filter(has_text=site)).to_have_count(1)
    page.screenshot(path="screens/b1/connectors.png")

    # Disconnecting one leaves the other.
    open_as(page, base_url, user, "/en/integrations")
    _open_manage(page)
    expect(_accounts(page)).to_have_count(2, timeout=NORMAL_TIMEOUT)
    _accounts(page).filter(has_text=SITES[0]).get_by_role("button", name="Disconnect").click()
    page.get_by_role("alertdialog").get_by_role("button", name="Disconnect").click()
    expect(_accounts(page)).to_have_count(1, timeout=NORMAL_TIMEOUT)
    expect(_accounts(page).first).to_contain_text(SITES[1])
    page.screenshot(path="screens/b1/after-disconnect.png")


def test_the_same_jira_site_twice_is_refused_with_a_clear_message(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    _connect_jira(page, SITES[0], first=True)
    _open_manage(page)
    _open_token_form(page.locator("[data-connect-another=jira]"))
    dialog = _form(page)
    dialog.get_by_label("Site address").fill(f"https://{SITES[0]}")
    dialog.get_by_label("Email").fill("fake@example.test")
    dialog.locator("[data-secret-field=token]").fill("ATATT3xFAKEtokenForE2ENeverReal1234567890")
    dialog.get_by_role("button", name="Save and connect").click()
    expect(dialog.get_by_role("alert")).to_contain_text("already connected", timeout=NORMAL_TIMEOUT)
