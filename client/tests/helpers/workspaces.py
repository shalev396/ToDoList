"""
Workspaces for E2E tests, set up through the API (requests), never the UI. Accounts come from
tests/helpers/users.py (real Cognito users). A test owns a workspace it creates, so a pooled
account can serve many tests.
"""
import re
from typing import Any, Optional

import requests


def _check(response: requests.Response, what: str) -> Any:
    if response.status_code >= 400:
        raise RuntimeError(f"{what} failed: {response.status_code} {response.text[:200]}")
    if response.status_code == 204 or not response.text:
        return None
    return response.json().get("data")


def delete_workspace(api_base_url: str, user, workspace_id: str) -> None:
    """DELETE /private/workspaces/:wid (owner). Never raises: a test may have deleted it already."""
    try:
        requests.delete(
            f"{api_base_url}/private/workspaces/{workspace_id}", headers=_headers(user), timeout=30
        )
    except requests.RequestException:
        pass


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def list_workspaces(api_base_url: str, user) -> list:
    response = requests.get(f"{api_base_url}/private/workspaces", headers=_headers(user), timeout=15)
    return _check(response, "Listing workspaces")


def get_workspace(api_base_url: str, user, workspace_id: str) -> dict:
    """One of the user's workspaces by id, from GET /private/workspaces (a pooled account owns
    several over a run, so never take the first)."""
    for entry in list_workspaces(api_base_url, user):
        if entry["workspace"]["id"] == workspace_id:
            return entry["workspace"]
    raise AssertionError(f"Workspace {workspace_id} is not in the user's workspaces")


def create_workspace(api_base_url: str, user, name: str, **extra: Any) -> dict:
    """POST /private/workspaces; the new workspace becomes the user's default."""
    response = requests.post(
        f"{api_base_url}/private/workspaces",
        json={"name": name, **extra},
        headers=_headers(user),
        timeout=15,
    )
    return _check(response, f"Creating workspace {name!r}")


DEFAULT_TOPIC_NAMES = {"work": "Work", "college": "College", "personal": "Personal"}


def _topics_url(api_base_url: str, workspace_id: str) -> str:
    return f"{api_base_url}/private/workspaces/{workspace_id}/topics"


def list_topics(api_base_url: str, user, workspace_id: str) -> list:
    """GET /private/workspaces/:wid/topics: the workspace's topics (its pages), in sidebar order."""
    response = requests.get(_topics_url(api_base_url, workspace_id), headers=_headers(user), timeout=15)
    return _check(response, "Listing topics")


def create_topic(
    api_base_url: str, user, workspace_id: str, name: str, template_key: Optional[str] = None
) -> dict:
    """POST /private/workspaces/:wid/topics ("+ Add page"): {topic, dashboardId}."""
    body: dict = {"name": name}
    if template_key is not None:
        body["templateKey"] = template_key
    response = requests.post(
        _topics_url(api_base_url, workspace_id), json=body, headers=_headers(user), timeout=15
    )
    return _check(response, f"Adding the page {name!r}")


def ensure_topics(api_base_url: str, user, workspace_id: str, slugs: list, pages: bool = False) -> list:
    """The default topics `slugs` (work, college, personal) the workspace lacks, added (a new
    workspace has Personal only). Without `pages`, a topic added here has no page yet, as a topic
    switched on before H2 had: its first page is removed again. Returns all its topics."""
    have = {topic["slug"] for topic in list_topics(api_base_url, user, workspace_id)}
    for slug in slugs:
        if slug in have:
            continue
        created = create_topic(api_base_url, user, workspace_id, DEFAULT_TOPIC_NAMES[slug])
        if not pages:
            response = requests.delete(
                f"{api_base_url}/private/workspaces/{workspace_id}/dashboards/{created['dashboardId']}",
                headers=_headers(user),
                timeout=15,
            )
            _check(response, f"Removing the first page of {slug!r}")
    return list_topics(api_base_url, user, workspace_id)


def topic_id(api_base_url: str, user, workspace_id: str, slug: str) -> str:
    """The id of the workspace's topic with this slug; a default topic it lacks is added first."""
    topics = list_topics(api_base_url, user, workspace_id)
    found = next((topic for topic in topics if topic["slug"] == slug), None)
    if found is None and slug in DEFAULT_TOPIC_NAMES:
        topics = ensure_topics(api_base_url, user, workspace_id, [slug])
        found = next((topic for topic in topics if topic["slug"] == slug), None)
    if found is None:
        raise RuntimeError(f"No topic {slug!r} in the workspace")
    return found["id"]


def ensure_workspace(api_base_url: str, user, name: str = "E2E workspace") -> dict:
    """The user's first workspace, created when they have none (the app sends a user
    without one to onboarding, so every shared or fixture user needs one)."""
    mine = list_workspaces(api_base_url, user)
    if mine:
        return mine[0]["workspace"]
    workspace = create_workspace(api_base_url, user, name, timezone="Asia/Jerusalem")
    # A new workspace is minimal (D1: Personal only); shared users get every default topic.
    ensure_topics(api_base_url, user, workspace["id"], ["work", "college", "personal"])
    return workspace


def create_invite(
    api_base_url: str,
    user,
    workspace_id: str,
    email: str,
    role: str = "viewer",
) -> dict:
    """POST /private/workspaces/:wid/invites: {invite, inviteUrl}. A workspace is shared whole."""
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/invites",
        json={"email": email, "role": role},
        headers=_headers(user),
        timeout=15,
    )
    return _check(response, f"Inviting {email}")


def accept_invite(api_base_url: str, user, token: str) -> dict:
    response = requests.post(
        f"{api_base_url}/private/invites/{token}/accept", headers=_headers(user), timeout=15
    )
    return _check(response, "Accepting an invite")


def invite_path(invite_url: str) -> str:
    """The app path of an invite link ("/en/invites/<token>"), whatever origin the API used:
    the local API links to http://localhost:5173, the suite may run on another port."""
    match = re.search(r"/(?:en|he)/invites/[A-Za-z0-9_%-]+", invite_url)
    if not match:
        raise AssertionError(f"Not an invite link: {invite_url[:60]}…")
    return match.group(0)


def invite_token(invite_url: str) -> str:
    return invite_path(invite_url).rsplit("/", 1)[1]


def sign_in(page, base_url: str, user, workspace_id: Optional[str] = None) -> None:
    """Puts the user's tokens into the browser (as the app stores them) without opening a page:
    the caller goes wherever the test starts (onboarding, an invite link, settings). A pooled
    account belongs to several workspaces; `workspace_id` makes the app open that one instead of
    the account's default."""
    page.goto(f"{base_url}/robots.txt", wait_until="domcontentloaded")
    page.evaluate(
        """([{ idToken, refreshToken, workspaceId }]) => {
            sessionStorage.setItem('idToken', idToken);
            localStorage.setItem('refreshToken', refreshToken);
            if (workspaceId) {
                localStorage.setItem('todolist-current-workspace', workspaceId);
            } else {
                localStorage.removeItem('todolist-current-workspace');
            }
        }""",
        [{"idToken": user.id_token, "refreshToken": user.refresh_token, "workspaceId": workspace_id}],
    )


def open_as(
    page,
    base_url: str,
    user,
    path: str,
    h1: Optional[str] = None,
    timeout: int = 20000,
    workspace_id: Optional[str] = None,
) -> None:
    """Signs the user in and opens an app path ("/en/settings"). With `h1`, waits until the
    page's h1 reads it (lazy routes and the workspace list load first)."""
    from playwright.sync_api import expect

    sign_in(page, base_url, user, workspace_id)
    page.goto(f"{base_url}{path}", wait_until="load")
    if h1 is not None:
        expect(page.get_by_role("heading", level=1)).to_have_text(h1, timeout=timeout)


def demo_workspace(api_base_url: str):
    """Generator for a module-scoped fixture: a workspace filled with the demo data
    (`loadDemoData`, honoured on dev and qa), owned by the worker's "demo" account, deleted at the
    end of the module. Yields (user, workspace).

        @pytest.fixture(scope="module")
        def demo(api_base_url):
            yield from demo_workspace(api_base_url)
    """
    from tests.helpers.users import pooled_user

    user = pooled_user(api_base_url, "demo")
    workspace = create_workspace(
        api_base_url, user, "Demo workspace", timezone="Asia/Jerusalem", loadDemoData=True
    )
    try:
        yield user, workspace
    finally:
        delete_workspace(api_base_url, user, workspace["id"])
