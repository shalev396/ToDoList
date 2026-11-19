"""
Travel legs as the API answers them, for the e2e that stubs the reads (a Playwright `page.route`)
because the dev stage can't store a leg yet: its Items validator predates kind `travel`.

Every shape is built from the server's own types and serializers, field for field:
  - a leg's props: server/src/types/travel.ts (`TravelLegProps`, `props.travelKey`);
  - an ItemSummary / ItemDetail: server/src/classes/item/Item.ts (`toSummary`, `toView`) over a local
    item (server/src/models/mongoose/Item.ts `localItemDoc`: `source.url` is `/w/<wid>/items/<id>`);
  - an item row of POST …/query: server/src/builder/run.ts (`toItemRow`);
  - the day panel: server/src/types/travel.ts (`TravelDaysResponse`), links: `TravelLinks`;
  - a trip's length (`POST …/travel/preview`): `TravelPreviewResponse`.
The envelope is `{ data }` (middlewares/responseFormatter.ts); a skip answers 204.

The stub answers only reads (a trip's length too) and the leg's own changes (edit, skip, reset),
and keeps their effect, so what the page shows after one is what the server would show (a length
set fills the way back when it has none, as TravelProfile#setTripLength does). Its request bodies
are kept for the test to assert. Everything else goes to the real server (`route.fallback()`).
"""
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import quote

from playwright.sync_api import Page, Request, Route

#: Asia/Jerusalem in the winter (after the clocks went back on 2026-10-25).
JERUSALEM = timezone(timedelta(hours=2))
#: The page's clock: Wednesday 18 November 2026, 12:00 in Jerusalem.
NOW = datetime(2026, 11, 18, 12, 0, tzinfo=JERUSALEM)
TODAY = "2026-11-18"
TOMORROW = "2026-11-19"
USER_ID = "00000000-0000-4000-8000-000000000001"

VERBS = {"transit": "Bus", "drive": "Drive", "walk": "Walk"}
#: The length a trip is drawn with until it is set (UNSET_TRIP_MINUTES).
UNSET_MINUTES = 30


def at(day: str, time: str) -> datetime:
    """`HH:MM` on `day` (`YYYY-MM-DD`) on Jerusalem's wall clock."""
    year, month, date = (int(part) for part in day.split("-"))
    hour, minute = (int(part) for part in time.split(":"))
    return datetime(year, month, date, hour, minute, tzinfo=JERUSALEM)


def iso(moment: datetime) -> str:
    """A JSON date as the server writes it: UTC, milliseconds, `Z`."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def travel_props(
    anchor: str,
    direction: str,
    mode: str,
    from_name: str,
    to_name: str,
    anchor_start: datetime,
    minutes: int,
    source: str = "set",
    from_home: bool = False,
    to_home: bool = False,
    conflict: bool = False,
    edited: bool = False,
    anchor_moved: bool = False,
    anchor_start_now: Optional[datetime] = None,
    removed_reason: Optional[str] = None,
) -> dict:
    """`props.travel` (TravelLegProps): every field the server stores, place ids and names only.
    `source` is `set` (the trip's length, or his times) or `unset` (the placeholder)."""
    return {
        "anchorItemId": anchor,
        "occurrence": "single",
        "anchorStart": iso(anchor_start),
        "direction": direction,
        "mode": mode,
        "fromPlaceId": "place-home" if from_home else f"place-{from_name.lower()}",
        "fromName": from_name,
        "toPlaceId": "place-home" if to_home else f"place-{to_name.lower()}",
        "toName": to_name,
        "fromHome": from_home,
        "toHome": to_home,
        "minutes": minutes,
        "source": source,
        "lengthUnset": source == "unset",
        "computedAt": iso(NOW - timedelta(hours=3)),
        "conflict": conflict,
        "edited": edited,
        "anchorMoved": anchor_moved,
        "anchorStartNow": None if anchor_start_now is None else iso(anchor_start_now),
        "removedReason": removed_reason,
    }


def stored_title(travel: dict) -> str:
    """The title the server stores (DayPlanner `#title`): English, the place's name only."""
    verb = VERBS[travel["mode"]]
    return f"{verb} home" if travel["toHome"] else f"{verb} to {travel['toName']}"


#: The fixture places' addresses, as their member typed them (a link carries them; nothing else does).
ADDRESSES = {"from": "Herzl 1, Haifa", "to": "Snunit St 51, Karmiel"}


def links_of(mode: str) -> list:
    """What `GET …/legs/:id/links` answers (TravelLinks): Waze for driving, Google Maps for every
    trip, from the places' text. They are never shown as text."""
    google = {
        "app": "google_maps",
        "url": f"https://www.google.com/maps/dir/?api=1&origin={quote(ADDRESSES['from'], safe='')}"
        f"&destination={quote(ADDRESSES['to'], safe='')}"
        f"&travelmode={ {'walk': 'walking', 'drive': 'driving', 'transit': 'transit'}[mode] }",
    }
    if mode == "drive":
        waze = f"https://waze.com/ul?q={quote(ADDRESSES['to'], safe='')}&navigate=yes"
        return [{"app": "waze", "url": waze}, google]
    return [google]


class Leg:
    """One live leg of the stub: its times and props now, and as the server computes them."""

    def __init__(self, leg_id: str, start: datetime, end: datetime, travel: dict, computed: Optional[dict] = None):
        self.id = leg_id
        self.start = start
        self.end = end
        self.travel = travel
        # What Reset brings back: the computed times (default: the leg as it is, unedited).
        self.computed = computed or {"start": start, "end": end, "travel": {**travel}}
        self.skipped = False

    @property
    def title(self) -> str:
        return stored_title(self.travel)

    def summary(self, workspace_id: str) -> dict:
        """ItemSummary (Item#toSummary) of a local leg."""
        url = f"/w/{workspace_id}/items/{self.id}"
        return {
            "id": self.id,
            "kind": "travel",
            "topicId": None,
            "title": self.title,
            "bodyPreview": None,
            "status": "open",
            "priority": None,
            "startAt": iso(self.start),
            "dueAt": None,
            "endAt": iso(self.end),
            "containerId": None,
            "source": {"provider": "local", "externalId": self.id, "key": None, "url": url},
            "openIn": {"provider": "local", "url": url},
            "props": {"travel": self.travel, "travelKey": f"{USER_ID}|{self.travel['anchorItemId']}|single|{self.travel['direction']}"},
            "overlay": {
                "pinned": None,
                "note": None,
                "hidden": None,
                "topicOverride": None,
                "calendarSync": None,
                "plannedAt": None,
                "editedAt": None,
                "attrs": {},
                "overrides": {
                    "title": None,
                    "status": None,
                    "dueAt": None,
                    "allDay": None,
                    "startAt": None,
                    "priority": None,
                },
            },
            "copies": [],
            "lastSeenAt": None,
        }

    def detail(self, workspace_id: str) -> dict:
        """ItemDetail (Item#toView): a leg is private to its member."""
        return {
            **self.summary(workspace_id),
            "integrationId": None,
            "statusRaw": None,
            "allDay": False,
            "assignees": [],
            "labels": [],
            "parentId": None,
            "ownerUserId": USER_ID,
            "visibility": "private",
            "closedAt": None,
            "createdAt": iso(NOW - timedelta(days=1)),
            "updatedAt": iso(NOW - timedelta(hours=1)),
            "editing": {
                "origin": "local",
                "providerFields": [],
                "overridableFields": [],
                "reachableStatuses": [],
                "ownsIntegration": False,
                "mode": None,
                "canWriteProvider": False,
                "needsReconnect": False,
                "needsGuestNotice": False,
            },
            "sourceValues": None,
        }

    def row(self, workspace_id: str) -> dict:
        """An item row of POST …/query (builder/run.ts `toItemRow`)."""
        item = self.summary(workspace_id)
        return {
            "id": self.id,
            "kind": "travel",
            "topicId": None,
            "title": self.title,
            "status": "open",
            "statusRaw": None,
            "priority": None,
            "startAt": item["startAt"],
            "dueAt": None,
            "endAt": item["endAt"],
            "allDay": False,
            "containerId": None,
            "labels": [],
            "assignees": [],
            "source": {
                "provider": "local",
                "key": None,
                "url": item["source"]["url"],
                "externalId": self.id,
            },
            "props": item["props"],
            "overlay": {
                "pinned": None,
                "note": None,
                "hidden": None,
                "topicOverride": None,
                "calendarSync": None,
                "plannedAt": None,
                "editedAt": None,
                "attrs": {},
            },
            "closedAt": None,
        }


class StubbedLegs:
    """Answers the reads that carry legs and the leg's own changes, for one workspace.

    `legs` are the live ones; `removed` the days' tombstones (`RemovedLegView`) that aren't skips.
    `calls` records every change the page makes: ("edit" | "skip" | "reset", leg id, body).
    """

    def __init__(self, workspace_id: str, legs: list, removed: Optional[dict] = None):
        self.workspace_id = workspace_id
        self.legs = {leg.id: leg for leg in legs}
        self.removed = removed or {}
        self.calls: list = []
        self.block_ids: set = set()
        self.days_requested: list = []
        # Rows of other kinds the blocks' query also answers (a screenshot's ordinary event).
        self.extra_rows: list = []
        # How long each trip takes, as set (from place, to place, mode → minutes): the length its
        # legs are computed with, read from the legs as computed.
        self.trip_lengths: dict = {
            StubbedLegs._trip(leg.computed["travel"]): leg.computed["travel"]["minutes"]
            for leg in legs
            if leg.computed["travel"]["source"] == "set"
        }

    # ─── What the page reads ────────────────────────────────────────────────

    def _live(self) -> list:
        return [leg for leg in self.legs.values() if not leg.skipped]

    def _day(self, date: str) -> dict:
        """TravelDayView: the legs that start on `date`, and the ones removed (skips included)."""
        legs = [
            leg.summary(self.workspace_id)
            for leg in sorted(self._live(), key=lambda leg: leg.start)
            if leg.start.astimezone(JERUSALEM).strftime("%Y-%m-%d") == date
        ]
        removed = list(self.removed.get(date, []))
        removed += [
            {
                "id": leg.id,
                "title": leg.title,
                "reason": "skipped",
                "removedAt": iso(NOW),
                "mode": leg.travel["mode"],
                "toHome": leg.travel["toHome"],
                "toName": leg.travel["toName"],
            }
            for leg in self.legs.values()
            if leg.skipped and leg.start.astimezone(JERUSALEM).strftime("%Y-%m-%d") == date
        ]
        return {"date": date, "legs": legs, "removed": removed}

    def _days(self, start: str, end: str) -> dict:
        first = datetime.strptime(start, "%Y-%m-%d")
        last = datetime.strptime(end, "%Y-%m-%d")
        days = []
        while first <= last:
            days.append(self._day(first.strftime("%Y-%m-%d")))
            first += timedelta(days=1)
        return {"days": days}

    # ─── Routing ────────────────────────────────────────────────────────────

    def install(self, page: Page, block_ids: list) -> None:
        """Routes the stub's reads and changes on `page`; any other call goes on to the server."""
        self.block_ids = set(block_ids)
        prefix = re.escape(f"/private/workspaces/{self.workspace_id}/")
        page.route(
            re.compile(rf".*{prefix}(query|travel/days|travel/preview|travel/legs/.*|items/[^/?]+)(\?.*)?$"),
            self._handle,
        )

    def _answer(self, route: Route, data: Any = None, status: int = 200) -> None:
        origin = route.request.headers.get("origin", "*")
        headers = {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "vary": "Origin",
        }
        if status == 204:
            route.fulfill(status=204, headers=headers)
        else:
            route.fulfill(
                status=status,
                headers={**headers, "content-type": "application/json"},
                body=json.dumps({"data": data}),
            )

    def _handle(self, route: Route) -> None:
        request: Request = route.request
        path = request.url.split("?")[0].split(f"/private/workspaces/{self.workspace_id}/")[1]
        method = request.method
        if method == "POST" and path == "query":
            body = request.post_data_json or {}
            if body.get("blockId") not in self.block_ids:
                return route.fallback()
            rows = [leg.row(self.workspace_id) for leg in self._live()] + self.extra_rows
            return self._answer(route, {"rows": rows, "total": len(rows), "appliedVars": {}, "warnings": []})
        if method == "GET" and path == "travel/days":
            query = dict(part.split("=") for part in request.url.split("?")[1].split("&"))
            self.days_requested.append((query["from"], query["to"]))
            return self._answer(route, self._days(query["from"], query["to"]))
        if method == "POST" and path == "travel/preview":
            return self._answer(route, self._preview(request.post_data_json or {}))
        if method == "GET" and path.startswith("items/"):
            leg = self.legs.get(path.split("/")[1])
            if leg is None or leg.skipped:
                return route.fallback()
            return self._answer(route, leg.detail(self.workspace_id))
        match = re.fullmatch(r"travel/legs/([^/]+)(?:/(skip|reset|links))?", path)
        if match is None:
            return route.fallback()
        leg = self.legs.get(match.group(1))
        action = match.group(2)
        if leg is None:
            return route.fallback()
        if method == "GET" and action == "links":
            return self._answer(route, {"links": links_of(leg.travel["mode"])})
        if method == "PATCH" and action is None:
            body = request.post_data_json
            self.calls.append(("edit", leg.id, body))
            self._edit(leg, body)
            return self._answer(route, leg.detail(self.workspace_id))
        if method == "POST" and action == "skip":
            self.calls.append(("skip", leg.id, request.post_data_json))
            leg.skipped = True
            return self._answer(route, status=204)
        if method == "POST" and action == "reset":
            self.calls.append(("reset", leg.id, request.post_data_json))
            leg.skipped = False
            leg.start, leg.end = leg.computed["start"], leg.computed["end"]
            leg.travel = {**leg.computed["travel"]}
            return self._answer(route, leg.detail(self.workspace_id))
        return route.fallback()

    @staticmethod
    def _trip(travel: dict) -> tuple:
        return (travel["fromPlaceId"], travel["toPlaceId"], travel["mode"])

    def _preview(self, body: dict) -> dict:
        """A trip's length (TravelPreviewResponse): the one set for it, else the placeholder,
        flagged."""
        minutes = self.trip_lengths.get((body.get("fromPlaceId"), body.get("toPlaceId"), body.get("mode")))
        if minutes is None:
            return {"minutes": UNSET_MINUTES, "source": "unset", "lengthUnset": True,
                    "startAt": None, "endAt": None}
        return {"minutes": minutes, "source": "set", "lengthUnset": False, "startAt": None, "endAt": None}

    def _set_length(self, trip: tuple, minutes: int, edited: Leg) -> None:
        """A trip's length set (TravelProfile#setTripLength): its legs follow it, and its way back
        (to → from, same mode) starts with the same length when it has none yet."""
        back = (trip[1], trip[0], trip[2])
        fill = back != trip and back not in self.trip_lengths
        self._follow(trip, minutes, edited)
        if fill:
            self._follow(back, minutes, None)

    def _follow(self, trip: tuple, minutes: int, edited: Optional[Leg]) -> None:
        """A trip's length: every leg of it is computed with it (a trip back keeps its departure,
        any other its arrival), and the ones he never timed by hand take it now."""
        self.trip_lengths[trip] = minutes
        for leg in self.legs.values():
            if StubbedLegs._trip(leg.computed["travel"]) != trip:
                continue
            start, end = leg.computed["start"], leg.computed["end"]
            if leg.computed["travel"]["direction"] == "back":
                end = start + timedelta(minutes=minutes)
            else:
                start = end - timedelta(minutes=minutes)
            computed = {**leg.computed["travel"], "minutes": minutes, "source": "set", "lengthUnset": False}
            leg.computed = {"start": start, "end": end, "travel": computed}
            if leg is not edited and not leg.travel["edited"]:
                leg.start, leg.end, leg.travel = start, end, {**computed}

    def _edit(self, leg: Leg, body: dict) -> None:
        """LegEditRequest (TravelLeg#editTimes): `minutes` is the trip's length, every time (this
        leg keeps its arrival, or its departure for a trip back); `startAt` and `endAt` move this
        leg only (one alone keeps its length) and make it his (`edited`). Its source is `set`, and
        the "event moved" flag is acknowledged."""
        start = datetime.fromisoformat(body["startAt"].replace("Z", "+00:00")) if "startAt" in body else None
        end = datetime.fromisoformat(body["endAt"].replace("Z", "+00:00")) if "endAt" in body else None
        length = timedelta(minutes=body.get("minutes") or (leg.end - leg.start).total_seconds() / 60)
        if start is not None and end is None:
            end = start + length
        elif end is not None and start is None:
            start = end - length
        elif start is None and end is None:
            if leg.travel["direction"] == "back":
                start, end = leg.start, leg.start + length
            else:
                start, end = leg.end - length, leg.end
        leg.start, leg.end = start, end
        leg.travel = {
            **leg.travel,
            "minutes": round((end - start).total_seconds() / 60),
            "source": "set",
            "lengthUnset": False,
            "edited": leg.travel["edited"] or "startAt" in body or "endAt" in body,
            "anchorMoved": False,
            "anchorStartNow": None,
        }
        if "minutes" in body:
            self._set_length(StubbedLegs._trip(leg.travel), body["minutes"], leg)
