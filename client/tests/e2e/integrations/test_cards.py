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
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.workspaces import open_as
from tests.viewports import DESKTOP_VIEWPORT


def test_provider_cards_start_not_connected(page: Page, base_url: str, fresh_owner):
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    for provider in ("google_calendar", "github", "jira"):
        card = page.locator(f"[data-integration-card={provider}]")
        expect(card.first).to_be_visible(timeout=NORMAL_TIMEOUT)
        expect(card.first.locator("[data-status-text]")).to_have_text("Not connected")


def test_google_calendar_connects_with_google_only(page: Page, base_url: str, fresh_owner):
    """The one way to connect Google Calendar is Google sign-in (no bridge, no pasted script)."""
    user, _workspace = fresh_owner
    page.set_viewport_size(DESKTOP_VIEWPORT)
    open_as(page, base_url, user, "/en/integrations")
    card = page.locator("[data-integration-card=google_calendar]")
    expect(card.get_by_role("button", name="Connect Google Calendar")).to_be_visible(
        timeout=NORMAL_TIMEOUT
    )
    expect(card.get_by_role("button", name="Use a token instead")).to_have_count(0)
