"""
Dashboards for E2E tests, set up and read through the API (requests), never the UI.

Routes: server/src/routes/private/dashboards.ts. Every write carries `expectedVersion`; a stale one
answers 409 with the current version.
"""
from typing import Any, Optional

import requests


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _data(response: requests.Response, what: str) -> Any:
    if response.status_code >= 400:
        raise RuntimeError(f"{what} failed: {response.status_code} {response.text[:200]}")
    if response.status_code == 204 or not response.text:
        return None
    return response.json().get("data")


def _dashboards(api_base_url: str, workspace_id: str) -> str:
    return f"{api_base_url}/private/workspaces/{workspace_id}/dashboards"


def create_dashboard(
    api_base_url: str,
    user,
    workspace_id: str,
    template: str = "dashboard",
    language: str = "en",
    scope: Optional[dict] = None,
) -> dict:
    """POST …/dashboards from a template; an owner's is published at once. Returns the view."""
    body: dict = {"fromTemplate": template, "language": language}
    if scope is not None:
        body["scope"] = scope
    response = requests.post(
        _dashboards(api_base_url, workspace_id), json=body, headers=_headers(user), timeout=15
    )
    return _data(response, f"Creating a {template} dashboard")


def list_dashboards(
    api_base_url: str, user, workspace_id: str, topic: str, page: Optional[str] = None
) -> list:
    """GET …/dashboards?topic=…&page=…, oldest first. `topic`: `main`, or a topic's slug."""
    from tests.helpers.workspaces import topic_id

    key = topic if topic == "main" else topic_id(api_base_url, user, workspace_id, topic)
    params = {"topic": key} if page is None else {"topic": key, "page": page}
    response = requests.get(
        _dashboards(api_base_url, workspace_id), params=params, headers=_headers(user), timeout=15
    )
    return _data(response, "Listing dashboards")


def get_dashboard(
    api_base_url: str, user, workspace_id: str, dashboard_id: str, copy: str = "draft"
) -> dict:
    response = requests.get(
        f"{_dashboards(api_base_url, workspace_id)}/{dashboard_id}?as={copy}",
        headers=_headers(user),
        timeout=15,
    )
    return _data(response, "Reading a dashboard")


def put_layout(
    api_base_url: str, user, workspace_id: str, dashboard_id: str, expected_version: int, layouts: dict
) -> dict:
    """PUT …/layout: {version, warnings}."""
    response = requests.put(
        f"{_dashboards(api_base_url, workspace_id)}/{dashboard_id}/layout",
        json={"expectedVersion": expected_version, "layouts": layouts},
        headers=_headers(user),
        timeout=15,
    )
    return _data(response, "Saving a layout")


def apply_ops(
    api_base_url: str, user, workspace_id: str, dashboard_id: str, expected_version: int, ops: list
) -> dict:
    """POST …/ops: {version, warnings}."""
    response = requests.post(
        f"{_dashboards(api_base_url, workspace_id)}/{dashboard_id}/ops",
        json={"expectedVersion": expected_version, "ops": ops},
        headers=_headers(user),
        timeout=15,
    )
    return _data(response, "Applying ops")


def block_id(dashboard: dict, title: str) -> str:
    """The id of the block with this title."""
    for block in dashboard["blocks"]:
        if block["title"] == title:
            return block["id"]
    raise AssertionError(f"No block titled {title!r}")


def layout_item(dashboard: dict, breakpoint: str, block: str) -> dict:
    """A block's stored position on one breakpoint."""
    for item in dashboard["layouts"][breakpoint]:
        if item["i"] == block:
            return item
    raise AssertionError(f"{block} has no {breakpoint} position")


def overlaps(layout: list) -> list:
    """Pairs of block ids that overlap (none in a valid layout)."""
    found = []
    for index, a in enumerate(layout):
        for b in layout[index + 1 :]:
            if (
                a["x"] < b["x"] + b["w"]
                and b["x"] < a["x"] + a["w"]
                and a["y"] < b["y"] + b["h"]
                and b["y"] < a["y"] + a["h"]
            ):
                found.append((a["i"], b["i"]))
    return found
