"""
The provider cards before anything is connected: provider-free checks only.

The OAuth handshakes (Google Calendar PKCE, single-use state, the browser-binding cookie, many
accounts, revoke on disconnect; Linear and ClickUp sign-in) and creating a to-do in the user's
providers need a provider that answers, and a stage talks to the real ones. Their logic is covered
by the server tests with injected provider stand-ins, not by the browser:

- server/src/gcal/oauth.loop.test.ts, oauth.twoway.test.ts, oauthCalendar.test.ts, createEvent.test.ts
- server/src/services/googleCalendarOAuth.test.ts and server/src/services/oauth/
- server/src/services/providerCreate/providerCreate.test.ts and boundary.test.ts
"""
import re

from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT


def test_provider_cards_start_not_connected(page: Page, base_url: str, fresh_owner):
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    for provider in ("google_calendar", "github", "jira", "clickup", "linear"):
        card = page.locator(f"[data-integration-card={provider}]")
        expect(card.first).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(card.first.locator("[data-status-text]")).to_have_text("Not connected")


def test_google_calendar_connects_with_google_only(page: Page, base_url: str, fresh_owner):
    """The one way to connect Google Calendar is Google sign-in (no bridge, no pasted script)."""
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    card = page.locator("[data-integration-card=google_calendar]")
    expect(card.get_by_role("button", name="Connect with Google Calendar")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(card.locator("[data-token-fallback]")).to_have_count(0)


def test_every_open_provider_leads_with_oauth_and_hides_the_token_option(
    page: Page, base_url: str, fresh_owner
):
    """Sign-in is the primary action; the API token is a collapsed fallback.

    The button says "Connect with <Provider>" when the stage has that provider's OAuth app, and
    "Coming soon" (disabled) when it has none.
    """
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    for provider, name in (
        ("jira", "Jira"),
        ("clickup", "ClickUp"),
        ("linear", "Linear"),
        ("github", "GitHub"),
    ):
        card = page.locator(f"[data-integration-card={provider}]").first
        button = card.locator(f"[data-oauth-connect={provider}]")
        expect(button).not_to_have_attribute("data-oauth-mode", "checking", timeout=NORMAL_TIMEOUT)
        if button.get_attribute("data-oauth-mode") == "connect":
            expect(button).to_have_text(f"Connect with {name}")
            expect(button).to_be_enabled()
        else:
            expect(button).to_have_text("Coming soon")
            expect(button).to_be_disabled()
        fallback = card.locator("[data-token-fallback]")
        expect(fallback.locator("summary")).to_have_text("Use an API token instead")
        expect(fallback).not_to_have_attribute("open", "")
        expect(card.locator("[data-use-token]")).to_be_hidden()
    # Never an instruction to create an app, whatever the stage has configured.
    expect(page.get_by_text(re.compile("client secret|developer console", re.I))).to_have_count(0)


def test_providers_are_listed_in_order_with_moodle_coming_soon(
    page: Page, base_url: str, fresh_owner
):
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    cards = page.locator("[data-integration-card]")
    expect(cards).to_have_count(6, timeout=NORMAL_TIMEOUT)
    assert [cards.nth(i).get_attribute("data-integration-card") for i in range(6)] == [
        "jira",
        "clickup",
        "linear",
        "google_calendar",
        "github",
        "moodle",
    ]
    moodle = page.locator("[data-integration-card=moodle]")
    expect(moodle.locator("[data-coming-soon-badge]")).to_have_text("Coming soon")
    expect(moodle.get_by_role("button")).to_have_count(0)
    expect(page.locator("[data-integration-card=google_drive]")).to_have_count(0)
