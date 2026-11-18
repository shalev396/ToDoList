"""
Travel in E2E tests: places, rules and marks set up through the API (requests), never the UI.

Routes: server/src/routes/private/travel.ts (editors and owners; everything is the caller's own).
Places are best made by coordinates, so no test waits on a geocoder.
"""
from typing import Any, Optional

import requests


def _url(api_base_url: str, workspace_id: str, path: str) -> str:
    return f"{api_base_url}/private/workspaces/{workspace_id}/travel/{path}"


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _data(response: requests.Response, what: str) -> Any:
    if response.status_code >= 400:
        raise RuntimeError(f"{what} failed: {response.status_code} {response.text[:200]}")
    return response.json().get("data") if response.content else None


def create_place(
    api_base_url: str,
    user,
    workspace_id: str,
    name: str,
    coords: Optional[tuple[float, float]] = None,
    address: Optional[str] = None,
    aliases: Optional[list[str]] = None,
    home: bool = False,
) -> dict:
    """POST …/travel/places: a place at `coords` (lat, lon) or an `address` to look up. Returns
    its PlaceView (id, name, aliases, home, address)."""
    body: dict[str, Any] = {"name": name, "home": home}
    if coords is not None:
        body["coords"] = {"lat": coords[0], "lon": coords[1]}
    if address is not None:
        body["address"] = address
    if aliases:
        body["aliases"] = aliases
    response = requests.post(
        _url(api_base_url, workspace_id, "places"), json=body, headers=_headers(user), timeout=30
    )
    return _data(response, "Creating a place")


def list_places(api_base_url: str, user, workspace_id: str) -> list:
    """GET …/travel/places: the caller's places, oldest first."""
    response = requests.get(
        _url(api_base_url, workspace_id, "places"), headers=_headers(user), timeout=30
    )
    return _data(response, "Listing places")


def create_rule(
    api_base_url: str,
    user,
    workspace_id: str,
    where: dict,
    mode: str = "transit",
    direction: str = "both",
    place_id: Optional[str] = None,
) -> dict:
    """POST …/travel/rules: "When `where` (a rule group) → by `mode`, `direction`", to
    `place_id` or the event's own place. Returns its TravelRuleView."""
    response = requests.post(
        _url(api_base_url, workspace_id, "rules"),
        json={
            "scope": {"kind": "where", "where": where},
            "mode": mode,
            "direction": direction,
            "placeId": place_id,
        },
        headers=_headers(user),
        timeout=30,
    )
    return _data(response, "Creating a travel rule")


def list_rules(api_base_url: str, user, workspace_id: str) -> list:
    """GET …/travel/rules: the caller's rules, oldest first."""
    response = requests.get(
        _url(api_base_url, workspace_id, "rules"), headers=_headers(user), timeout=30
    )
    return _data(response, "Listing travel rules")


def get_settings(api_base_url: str, user, workspace_id: str) -> dict:
    """GET …/travel/settings: {settings, containerPlaces, orsAvailable}."""
    response = requests.get(
        _url(api_base_url, workspace_id, "settings"), headers=_headers(user), timeout=30
    )
    return _data(response, "Reading travel settings")


def mark_item(
    api_base_url: str,
    user,
    workspace_id: str,
    item_id: str,
    mode: str = "transit",
    direction: str = "both",
    every: Optional[bool] = None,
    occurrence: Optional[str] = None,
    place_id: Optional[str] = None,
    there: Optional[dict] = None,
    back: Optional[dict] = None,
) -> dict:
    """POST …/travel/items/:itemId: travel to (and from) one timed item, every occurrence of a
    series (`every=True`) or one occurrence (`occurrence`, its original start). `there` and `back`
    are spans (`startAt`, `endAt`, `minutes`). Returns {rule, legs}. Needs a Home first."""
    body: dict[str, Any] = {"mode": mode, "direction": direction}
    for key, value in (
        ("every", every),
        ("occurrence", occurrence),
        ("placeId", place_id),
        ("there", there),
        ("back", back),
    ):
        if value is not None:
            body[key] = value
    response = requests.post(
        _url(api_base_url, workspace_id, f"items/{item_id}"),
        json=body,
        headers=_headers(user),
        timeout=30,
    )
    return _data(response, "Marking an item for travel")
