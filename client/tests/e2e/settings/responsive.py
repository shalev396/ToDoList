"""
Settings and members at every viewport, in both languages: no horizontal scroll.
"""
from playwright.sync_api import Page, expect

from tests.config import NORMAL_TIMEOUT
from tests.helpers.users import new_mailbox
from tests.helpers.workspaces import create_invite, sign_in
from tests.helpers.responsive import assert_no_horizontal_overflow
from tests.viewports import VIEWPORTS


def test_settings_and_members_responsive(
    page: Page, base_url: str, api_base_url: str, fresh_owner
):
    user, workspace = fresh_owner
    create_invite(api_base_url, user, workspace["id"], new_mailbox(), "editor")
    sign_in(page, base_url, user)
    for lng in ("en", "he"):
        for path in ("settings", "settings/members"):
            for vp in VIEWPORTS:
                page.set_viewport_size({"width": vp["width"], "height": vp["height"]})
                page.goto(f"{base_url}/{lng}/{path}", wait_until="load")
                expect(page.get_by_role("heading", level=1)).to_be_visible(timeout=NORMAL_TIMEOUT)
                expect(page.locator("main section").first).to_be_visible()
                assert_no_horizontal_overflow(page, f"{lng}-{path}-{vp['name']}", vp["width"])
