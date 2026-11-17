"""
The block editor's Save, waited on properly.

Save sends one builder op (`POST .../dashboards/:id/ops`) and closes the editor when it is
answered. Against a remote stage that answer can take well over 15 s, so the wait is the server's
answer itself, bounded by the app's own request timeout, not a fixed guess.
"""
from playwright.sync_api import Locator, Page, Response, expect

from tests.config import APP_REQUEST_TIMEOUT, NORMAL_TIMEOUT


def _is_ops_post(response: Response) -> bool:
    return response.url.endswith("/ops") and response.request.method == "POST"


def save_block_editor(page: Page, editor: Locator, closes: bool = True) -> Response:
    """Clicks Save and returns the server's answer. With `closes` (the usual case) the save must
    succeed and the editor must close; pass False when the test expects a refusal (a conflict)."""
    with page.expect_response(_is_ops_post, timeout=APP_REQUEST_TIMEOUT) as answered:
        editor.locator("[data-editor-save]").click()
    if closes:
        assert answered.value.ok, f"the block save was answered {answered.value.status}"
        expect(editor).to_have_count(0, timeout=NORMAL_TIMEOUT)
    return answered.value
