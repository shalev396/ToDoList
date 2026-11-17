"""
Items for E2E tests, set up and read through the API (requests), never the UI.

Routes: server/src/routes/private/items.ts.
"""
from typing import Any, Optional

import requests


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _data(response: requests.Response, what: str) -> Any:
    if response.status_code >= 400:
        raise RuntimeError(f"{what} failed: {response.status_code} {response.text[:200]}")
    return response.json().get("data")


def create_local_item(api_base_url: str, user, workspace_id: str, title: str, topic: str = "work") -> dict:
    """POST …/items: a local to-do in the topic with this slug (a default one is added when the
    workspace lacks it). Returns the item (id, title, source …)."""
    from tests.helpers.workspaces import topic_id

    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/items",
        json={"title": title, "topicId": topic_id(api_base_url, user, workspace_id, topic)},
        headers=_headers(user),
        timeout=15,
    )
    return _data(response, "Creating an item")


def list_items(api_base_url: str, user, workspace_id: str, provider: Optional[str] = None) -> list:
    """GET …/items (first page), optionally of one provider."""
    params = {"provider": provider} if provider else {}
    response = requests.get(
        f"{api_base_url}/private/workspaces/{workspace_id}/items",
        params=params,
        headers=_headers(user),
        timeout=15,
    )
    return _data(response, "Listing items")["items"]
