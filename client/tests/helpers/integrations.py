"""
Integration and agent-key setup for E2E tests, through the API (requests), never the UI.

A connect link is made the way an agent makes it: an agent key with `integrations:connect` calls
the MCP tool `integrations_start_connect` (server/src/mcp/tools/integrations/startConnect.ts).
"""
import re
from typing import Any

import requests


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def create_agent_key(api_base_url: str, user, workspace_id: str, scopes: list, name: str = "e2e") -> dict:
    """POST …/agent-keys: the key view with its raw `key` (shown once)."""
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/agent-keys",
        json={"name": name, "scopes": scopes},
        headers=_headers(user),
        timeout=15,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Creating an agent key failed: {response.status_code}")
    return response.json()["data"]


def start_connect_link(api_base_url: str, user, workspace_id: str, provider: str) -> str:
    """The app path (with query) of a fresh connect link: `/en/integrations?workspace=…&link=…`.
    The link the server returns points at its own configured origin, so only the path is kept."""
    key = create_agent_key(api_base_url, user, workspace_id, ["read", "integrations:connect"])["key"]
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
    }
    call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "integrations_start_connect", "arguments": {"provider": provider}},
    }
    response = requests.post(f"{api_base_url}/mcp", json=call, headers=headers, timeout=15)
    result: Any = response.json()["result"]["structuredContent"]
    match = re.search(r"/(?:en|he)/integrations\?[^\"\s]+", result["connectUrl"])
    if not match:
        raise AssertionError("The connect link has no integrations path")
    return match.group(0)
