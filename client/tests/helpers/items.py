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


def create_timed_todo(
    api_base_url: str,
    user,
    workspace_id: str,
    title: str,
    start_at: str,
    end_at: str,
    topic: str = "work",
) -> dict:
    """POST …/items: a local to-do that happens from `start_at` to `end_at` (ISO instants), the
    shape travel can get him to. Returns the item."""
    from tests.helpers.workspaces import topic_id

    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/items",
        json={
            "title": title,
            "topicId": topic_id(api_base_url, user, workspace_id, topic),
            "startAt": start_at,
            "endAt": end_at,
            "allDay": False,
        },
        headers=_headers(user),
        timeout=15,
    )
    return _data(response, "Creating a timed to-do")


def delete_item(api_base_url: str, user, workspace_id: str, item_id: str) -> None:
    """DELETE …/items/:id (a local to-do)."""
    response = requests.delete(
        f"{api_base_url}/private/workspaces/{workspace_id}/items/{item_id}",
        headers=_headers(user),
        timeout=15,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Deleting an item failed: {response.status_code} {response.text[:200]}")
