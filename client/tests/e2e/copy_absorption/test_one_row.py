"""
H5's "one row" rule after the hole fix, end to end against the stage's API and its MongoDB, on a
workspace with the demo data (`loadDemoData`, dev and qa). API level, no browser.

The rule: a provider copy of a local to-do is hidden only while its to-do shows in the same read;
otherwise the copy is a row of its own. Every list and aggregate read now runs the absorption as
stages of its own aggregation (`$setWindowFields`, then `$match`), right after its filter and
before the count, the groups and the rows.

No provider copy exists on a stage: a copy is made only by a real create at a provider and the
sync that brings it back, and neither the demo data nor any test-only path seeds one. So the copy
cases (a done to-do and its open Linear issue under an "open" filter, `kind = issue`, connectors
without `local`, a private to-do of another member, pages, a group-by-source chart) are the server
tests' (server/src/builder/copyAbsorption.test.ts, server/src/services/copyAbsorption.test.ts,
server/src/classes/calendar/Calendar.copies.test.ts). This file proves on the stage what those
cannot: the new stages run on the stage's MongoDB (Atlas), and for task-shaped and time-shaped
reads, with and without connectors, the total, the groups and the rows agree, and the item list's
pages add up to the same items as a dashboard query.
"""
import pytest
import requests

from tests.helpers.workspaces import demo_workspace

ROW_CAP = 200
OPEN = {"combinator": "and", "rules": [{"field": "status", "operator": "in", "value": ["open", "in_progress"]}]}
ISSUES = {"combinator": "and", "rules": [{"field": "kind", "operator": "=", "value": "issue"}]}


@pytest.fixture(scope="module")
def demo(api_base_url, pooled_demo):
    """The worker's demo workspace and its owner."""
    yield from demo_workspace(api_base_url, pooled_demo)


def _headers(user) -> dict:
    return {"Authorization": f"Bearer {user.id_token}"}


def _query(api_base_url, user, workspace_id, body: dict) -> dict:
    response = requests.post(
        f"{api_base_url}/private/workspaces/{workspace_id}/query", json=body, headers=_headers(user), timeout=30
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _integrations(api_base_url, user, workspace_id) -> list:
    response = requests.get(
        f"{api_base_url}/private/workspaces/{workspace_id}/integrations", headers=_headers(user), timeout=15
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _agree(api_base_url, user, workspace_id, draft: dict, **extra) -> int:
    """Runs `draft` as rows and as a count by source; asserts the total, the groups and the rows
    agree. Answers the total."""
    listed = _query(api_base_url, user, workspace_id, {"draft": {**draft, "limit": ROW_CAP}, **extra})
    chart = _query(
        api_base_url,
        user,
        workspace_id,
        {"draft": {**draft, "groupBy": ["source.provider"], "aggregate": {"op": "count"}}, **extra},
    )
    total = listed["total"]
    assert chart["total"] == total, (draft, extra, chart["total"], total)
    assert sum(group["value"] for group in chart["groups"]) == total, (draft, extra, chart["groups"], total)
    rows = listed["rows"]
    assert len({row["id"] for row in rows}) == len(rows), "a row came back twice"
    assert len(rows) == min(total, ROW_CAP), (draft, extra, len(rows), total)
    return total


def test_totals_groups_and_rows_agree(api_base_url, demo):
    user, workspace = demo
    wid = workspace["id"]
    everything = _agree(api_base_url, user, wid, {"source": "items"})
    assert everything > 0, "the demo workspace has items"
    open_items = _agree(api_base_url, user, wid, {"source": "items", "where": OPEN})
    issues = _agree(api_base_url, user, wid, {"source": "items", "where": ISSUES})
    assert open_items <= everything and issues <= everything
    # A time view: reserved time and repeating series too, on this week.
    _agree(api_base_url, user, wid, {"source": "items", "dateRange": "this_week"}, blockType="calendar")


def test_connectors_with_and_without_local_agree(api_base_url, demo):
    user, workspace = demo
    wid = workspace["id"]
    ids = [integration["id"] for integration in _integrations(api_base_url, user, wid)]
    assert ids, "the demo workspace has integrations"
    providers_only = _agree(api_base_url, user, wid, {"source": "items"}, connectors=ids)
    with_local = _agree(api_base_url, user, wid, {"source": "items"}, connectors=[*ids, "local"])
    assert providers_only <= with_local
    local_only = _agree(api_base_url, user, wid, {"source": "items"}, connectors=["local"])
    # No copy in the demo data: the sources add up exactly.
    assert providers_only + local_only == with_local


def test_item_list_pages_add_up_to_the_dashboard_query(api_base_url, demo):
    user, workspace = demo
    wid = workspace["id"]
    query = _query(api_base_url, user, wid, {"draft": {"source": "items", "limit": ROW_CAP}})
    assert query["total"] <= ROW_CAP, "the demo data fits one dashboard query"
    seen: list = []
    cursor = None
    for _ in range(100):
        params = {"limit": 7, **({"cursor": cursor} if cursor else {})}
        response = requests.get(
            f"{api_base_url}/private/workspaces/{wid}/items", params=params, headers=_headers(user), timeout=30
        )
        assert response.status_code == 200, response.text
        page = response.json()["data"]
        seen.extend(item["id"] for item in page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert cursor is None, "the list kept paging"
    assert len(seen) == len(set(seen)), "an item came back on two pages"
    # Both are task-shaped reads of everything the owner may see: the same items.
    assert sorted(seen) == sorted(row["id"] for row in query["rows"])
