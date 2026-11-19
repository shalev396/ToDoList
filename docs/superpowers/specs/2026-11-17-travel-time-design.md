# Travel time: design

> **Amendment 2026-11-18 (owner's decision): no routing service; trip lengths are set by the user.** In his words: "We said there is no free API. So let's just let the user decide how much time it's going to take. And of course, if it's a repetitive drive, it's going to be the same thing on all of them." This overrides the body below wherever they differ:
>
> - **No outside services.** Nothing in travel calls out: no OpenRouteService, no Nominatim, no straight-line estimate, no routing quota, no geocode cache. A place is a name, aliases, Home, and an optional free-text address used only to open Waze or Google Maps on his device; there are no coordinates and nothing is looked up.
> - **One length per trip, set by him.** A trip is (from place, to place, mode); each direction is its own trip, and the way back starts with the same length when it has none yet (the ruling of 2026-11-19; he can change it on its own). He sets its minutes once (the leg sheet's "How long this trip takes (every time)", the Add-travel panel, or an agent's `minutes`), and every leg of that trip uses them, every day and every occurrence, except legs whose times he set by hand. Changing only leave or arrive moves just that leg (kept until Reset).
> - **Not set yet.** A trip with no length still gets its legs, drawn with a 30-minute placeholder, flagged `lengthUnset` (source `unset`): "Set how long" in the leg sheet and day panel, dashed in the time views, and in conflicts with the placeholder. Sources are "set by you" and "not set yet".
> - **Settings** lose the factors, the buffers and `orsAvailable`; going home in a window, the default mode, default places, rules and places stay.
> - **Anchoring by location** is by place name or alias only; an unmatched location takes the calendar's or project's default place, or asks to set its place.
> - **App links:** Waze (driving) and Google Maps, from the addresses (or names) as text. The Moovit link is removed.
> - **Privacy:** the policy names no outside travel service; places and addresses are private to the member, never shared, logged or given to agents, and an address only opens a map app.

Status: approved by Shalev (2026-11-17). Changes from his follow-up the same day:

- **Agents may set up travel over MCP** (he asked for his week to be populated through the MCP): places, rules and settings, for the key's own member only. Places stay private: tools accept an address but never return one; reads give place names only.
- **Rough values are fine to start.** He will correct them later, so the first setup may use estimated lengths (labelled "estimate" or entered as his remembered length).
- **Without an OpenRouteService key** (he hasn't created the account yet), walking and driving use the remembered length, then the straight-line estimate. The key is read from the stage's secret when present; nothing else changes.
- **The daily pass runs from the hourly schedule** (see the UI and sync design): after the sync dispatch, each workspace with travel rules gets its 14-day horizon refreshed, at most once a day, plus on the triggers below.

## Why

Shalev's days happen in places: home, Braude (lectures, on his personal Google calendar "braude"), TLVTech (work). Getting between them takes real time. Today TodoList knows _when_ things happen but not _where_, so the clock shows free time that is actually spent on a bus or in the car, and nothing protects it.

He wants that time to appear and be protected like a lecture: "It should be like a task. It's not really a task, but it takes time. And this time is taken."

## What it is (his decisions)

- A **travel block** shows wherever tasks and events show (clock, calendar, timeline, agenda), takes its time, and is **done automatically** once it ends, like a calendar event.
- Travel blocks are added **automatically by criteria**, using the same logic builder the dashboards use. They can also be added **by hand**:
  - when creating a to-do, the form asks whether to add travel time;
  - on an existing event, such as a lecture from Google Calendar, he can mark it for travel.
- If the event **repeats**, TodoList asks whether to apply travel to every occurrence, so the whole semester is covered.
- Three modes, as tabs: **walk**, **drive**, **public transport**.
  - Each mode gets its length from a **free** API where one exists. TodoList is a SaaS for Shalev and his friends, and no billing account or pay-per-use service is allowed.
  - Where no free API exists, the user enters it. **Start, end and length:** fill any two, and the third is computed. From and to places are optional too.
  - A computed length is multiplied by a **factor the user sets**, a global setting per mode.
- Each block keeps links that open that trip in the right app:
  - walking: Google Maps;
  - driving: Waze;
  - public transport: Moovit (Egged's new "egg" app has no public link format).
- Public transport: no free trip planner exists for Israel, so its times are entered by hand.
  - TodoList remembers the length he last entered for the same from → to trip, so a weekly trip is typed once.
  - If he sets the block to end at the bus's arrival, 20 minutes before the lecture, the spare time stays free; nothing merges.
- **TravelLeg is a scheduled block** (time-blocks design). It reserves time, has no status, and is never ticked.

## Goals

1. Every located, timed commitment he cares about gets a travel block before it and, where needed, after it.
2. Windows between events at the same place don't produce travel. Real moves between places do.
3. One semester rule, e.g. "lectures on the braude calendar, by public transport", covers every week without per-week work.
4. Times come from free routing (walking, driving) multiplied by his factors, or from his own entry (public transport, or any override). Each block says which.
5. One tap opens the trip in Waze, Google Maps or Moovit.

## Non-goals (first version)

- Live traffic.
- Real-time bus tracking.
- "Leave now" notifications.
- Multi-stop route optimisation.
- Cycling.
- Travel for all-day events.
- A different start place per day ("I slept elsewhere").
- ~~Agents creating travel rules over MCP~~ (now in scope, see Status). Agents also **see** travel blocks as busy time.

## Anti-goals (would make this a failure even if it works)

- Travel blocks that look and count like to-dos to tick. They are time, not work: they don't count in "open tasks", and nobody ticks them.
- A block that silently shows a wrong or stale time, or disappears without a reason he can see.
- Rules that create blocks he didn't ask for.
- Travel that edits his lectures or anything at a provider. Rules only ever **add** TodoList's own blocks, and the read-only guarantee still holds.
- His home address leaking to the workspace, to agents, or into logs.
- Any bill: no billing account, no card on file, no pay-per-use API, however small.

## Concepts

1. **Places**, per member and private.
   - A place is a name, an address, coordinates and optional aliases. Examples: Home; Braude (aliases "ORT Braude", "בראודה"); TLVTech.
   - Exactly one place is **Home**, the start and end of every day.
   - A calendar or project can have a **default place**: the "braude" calendar maps to Braude, for events that have no location.
2. **Where an event is.** In this order:
   1. its location text matches a place's name or alias;
   2. its location is geocoded once (free: OpenRouteService's geocoder, or Nominatim at 1 request a second with caching) and matched to the nearest saved place within 300 m;
   3. its calendar or project's default place applies;
   4. otherwise it has no place and gets no travel. The block UI offers "set place".

   Google events already sync their `location` (`props.location`).

3. **Travel rule.** Its shape: "When [a where-group, the dashboard logic builder] → travel by [mode], [there / back / both]".
   - Example: "calendar is braude → public transport, both".
   - Rules live in Settings → Travel.
   - Marking one recurring event "every week" creates a rule scoped to that series.
4. **Manual travel**, on one item: the same choice stored on that to-do or occurrence (mode, there/back).
5. **Travel settings**, his "global variables". The defaults are my call:

   | Setting                  | Default                                                                   |
   | ------------------------ | ------------------------------------------------------------------------- |
   | Factor, walking          | ×1.0                                                                      |
   | Factor, driving          | ×1.15                                                                     |
   | Factor, public transport | ×1.0                                                                      |
   | Buffer, walking          | +0 min                                                                    |
   | Buffer, driving          | +10 min (parking)                                                         |
   | Buffer, public transport | +5 min (to the stop)                                                      |
   | Go home in a window      | off; when on, at least 3 h, and only if it leaves at least 60 min at home |
   | Default mode             | public transport                                                          |

## The day plan

This answers his question "how do you know when the day starts, with windows between lectures?". The plan is derived per day, in the workspace time zone:

1. **Anchors** are the day's timed items that have travel (from a rule or set by hand) and a place.
2. **Stays.** Sort the anchors by start. Consecutive anchors at the same place merge into one stay.
   - Lectures 10–12 and 14–16 at Braude are one stay, 10–16, and the window in between is spent there. No travel.
   - Exception: with "go home in a window" on, a long enough window at a place is split into two stays, with travel home and back.
3. **Legs:**
   - Home → the first stay, arriving by its start. That leg is where the day starts, so no "day start" setting is needed.
   - Between stays at different places: leave after the first ends, arrive by the next starts.
   - The last stay → Home, leaving after it ends.
   - "There" and "back" on a rule control only the first and last legs of the day.
   - A leg between two stays always exists when both have travel. It uses the **destination** anchor's mode (bus to Braude, then car to TLVTech: the Braude → TLVTech leg drives). A to-do's own manual choice beats any rule.
4. **Times.**
   - The length comes from, in order:
     1. what he typed for this leg;
     2. for walking and driving, OpenRouteService × factor + buffer;
     3. the length he last entered for the same from → to trip and mode;
     4. a straight-line estimate, labelled "estimate".
   - Unless he says otherwise, a leg there ends at the anchor's start: `[start − length, start]`. A return leg starts when the stay ends.
   - **Start, end and length are editable on any leg.** Filling two computes the third. An edited leg keeps his times until he resets it, even when it is regenerated.
5. **Conflicts.** A leg that doesn't fit is still shown, starting at the earlier stay's end, and is marked as a conflict (red edge, "you can't make it": e.g. A ends 12:00, B starts 12:15, travel takes 40 min). The plan never moves or edits his events.
6. Items with no place, all-day events, and anchors already in the past (that day) don't create new legs.
7. **Areas** (_added 2026-11-18_). A painted area ("Studying 8–16 at Braude") anchors like any item, and the items inside it nest:
   - an inner item with a place of its own is there for its own time: leave the area to arrive as it starts, and go back into the area as it ends (in that item's mode; late only matters when an appointment waits there);
   - a marked area lends its place to an inner item with none (the innermost marked area around its start): that item adds no trips of its own, and marking it says it is inside the area, at that place;
   - the rest of the area is spent at its place: no legs between two inner items there, and none from the area's place to itself;
   - he goes back into a part of the area with no appointment only when the gap holds the trip back and the trip on, and he gets there before the part ends; otherwise he goes straight on, or home, from the inner item (_fix round 1, 2026-11-18_);
   - legs go to the area at its start, and back (or onward) at its end, by the rules above. An area stays not busy; its legs are busy.

## Generation and lifecycle (my calls after review)

- **Stored, not computed on read.** Travel legs are stored items. Every view, MCP tool and the optional Google push then gets them for free. Their status (upcoming / done) is derived from the time.
- **Key.** One leg per (anchor item, the occurrence's **original** start, direction). The original start doesn't change when one occurrence is moved: Google's `originalStartTime`, or a time block exception's `originalStart`. Regeneration upserts by that key, so running it twice changes nothing.
- **Anchors.**
  - Any `CalendarEvent`, `Todo` with a start, or `TimeBlock` (including one occurrence of a repeating block) can be an anchor.
  - A `TravelLeg` never is.
  - Travel on a repeating time block works like travel on a Google series: a series-scoped rule keyed on the series record, or per occurrence.
- **When an anchor moves or is skipped.**
  - A skipped or cancelled occurrence removes its legs, with the reason shown.
  - A moved one moves its legs, since they are regenerated from the new time.
  - A leg he **edited by hand** keeps his times. If its anchor moved, it is flagged ("the event moved; check this trip") instead of being dropped or silently shifted. Reset brings back the computed times.
- **Storage.** Plain documents in the existing database through classes, with no new infrastructure:
  - places;
  - travel rules;
  - remembered lengths, per member: (from place, to place, mode) → minutes. A trip without both places is not remembered;
  - one daily counter document per workspace for the routing cap.
- **Triggers.** A day's plan is regenerated when:
  - a sync changes an anchor (moved, cancelled, new occurrence);
  - a to-do with travel is created or edited;
  - a rule, a place or a setting changes;
  - once a day for days entering the 14-day horizon.

  How the daily pass runs inside the one-Lambda setup is left to the builder: the existing scheduled run, or the first app open of the day.

- **Removal is visible.** When a leg's anchor is cancelled, moved away or no longer matches, the leg is removed. The day's travel panel shows the reason for that day (e.g. "Bus to Braude removed: the lecture was cancelled"). A soft-deleted tombstone holds it until the day ends.
- **Shared free quota.** OpenRouteService's free key has a daily limit shared by every TodoList user. Each workspace gets at most **100 routing calls a day** (my call). Past it, or when the service is down, legs use the remembered length or the straight-line estimate, labelled as such. Nothing fails silently.

## Durations and links

**Free services only (Shalev's rule).** No billing account, no card, no pay-per-use API.

| Mode             | Where the length comes from                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walking          | **OpenRouteService** `foot-walking` (free key, no card) × factor + buffer                                                                                                                                 |
| Driving          | **OpenRouteService** `driving-car`, without live traffic, × factor + buffer                                                                                                                               |
| Public transport | **His entry.** No free trip planner exists for Israel: Google's is billed, Moovit's is partner-only, and the Ministry's data has no hosted planner. The remembered length for the same trip pre-fills it. |

- The fallback for every mode is a straight-line estimate (walking 4.5 km/h × 1.3; driving 40 km/h), labelled "estimate".
- Waze has no public travel-time API. Its links (below) are free.
- **To check before the build:**
  - OpenRouteService's free plan states commercial use is allowed and gives two different daily limits (2,000 or 10,000 directions); confirm both in the HeiGIT dashboard.
  - The key goes into the stage's existing secret (merge, never overwrite).
  - Shalev creates the free account, since it needs his email.
- **Storage:** OpenRouteService results come from OpenStreetMap data (ODbL, with attribution), so storing a leg's times is allowed. We store start, end, length, source and `computedAt`, never route geometry.
- **Reuse:** requests for the same (from, to, mode) within a day are reused.

**Links**, kept on each block:

- **Walking:** Google Maps, `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=walking`.
- **Driving:** Waze, `https://waze.com/ul?ll=<lat>,<lon>&navigate=yes`. Waze always starts from where the phone is. The Google Maps driving link is offered as a second choice.
- **Public transport:**
  - Moovit app: `moovit://directions?orig_lat=…&orig_lon=…&dest_lat=…&dest_lon=…&date=<ISO>&auto_run=true`, with its install link as the fallback;
  - plus the Google Maps transit link.

## Where travel comes from (three entry points)

1. **New to-do.** The create form has an "Add travel time" switch, collapsed by default.
   - When it's on: tabs Walk / Drive / Public transport.
   - **From** defaults to the plan's previous place, or Home. **To** defaults to the to-do's place: pick a saved place or type an address. Both are optional. Without places, the leg is just time he enters, with no links.
   - **Start, end and length:** filled from the computed or remembered length; editing any two computes the third.
   - **There / back** choice.
   - A live preview, e.g. "Leave 13:20 · arrive 13:52 · 32 min (OpenRouteService)" or "(your last trip)", with its links.
   - A to-do needs a start time for travel. If it has only a due date, the form asks for a time.
2. **An existing event.** The item sheet has "Add travel" with the same panel. If the event repeats: "Every occurrence (until the series ends)?"
   - **Yes** creates a series-scoped rule.
   - **No** applies to this occurrence only.
3. **Rules.** Settings → Travel lists rules, built with the logic builder, plus Places and the factors.

## Repeating events and how far ahead

Google repeating events sync as **one series item**: the master carries its RRULE, and exceptions carry `recurringEventId`. Today only the client expands them (`client/src/features/dashboards/blocks/time/occurrences.ts`).

- The day plan runs on the server, so expansion must run there too. Share or port that logic next to the server's existing `RecurrenceRule`, so the client and server agree occurrence by occurrence.
- A series-scoped rule keys on the series master's item id.
- **Horizon (my call):** legs exist for the next **14 days** and are regenerated as days come into range.
- A rule covers the whole semester because it persists. Blocks appear as the weeks approach, with fresh times.
- Generating a full semester up front would mean many API calls, and times would go stale.

## How it shows

- **Time views** (clock ring, calendar, timeline, agenda): a block in its topic's colour family, using the "travel" shade with hatching (see the topic colours design), and an icon for its mode. The clock's Now/Next names it, e.g. "Bus to Braude".
- **Task views and counts:** not included. "Open tasks", charts and lists filter out `kind = travel` by default.
- **Done:** past blocks are dimmed and shown as done. A block can be **skipped** (hidden for that day); it cannot be ticked or edited directly. Changing mode or place recomputes it.
- **Busy:** MCP `list_today` and `get_calendar` include travel blocks as busy time. Agents (Grok Bot) see them and plan around them.
- **Google Calendar push:** optional and off by default. The existing push can include travel blocks so other calendars see the time as busy.

## Object model ("implement or extend")

- **`TravelLeg extends ScheduledItem`** (see the class diagram in the time-blocks design).
  - A travel block **is an item**, so it shows wherever items show, but it is **not a markable to-do**: a sibling of `TimeBlock` under `ScheduledItem`.
  - It does **not** implement `Completable`. It has no status. Its actions are: edit start/end/length, skip, and reset to computed.
  - New item kind: `travel`.
  - Fields:
    - anchor item id, plus the occurrence start for a series;
    - direction (`there` / `back` / `between`);
    - from place, to place, mode;
    - `startAt`, `endAt`;
    - source (`ors` / `remembered` / `manual` / `estimate`), `computedAt`;
    - conflict flag;
    - links.
- **`Place extends WorkspaceEntity implements Owned`**: private to its member.
- **`TravelRule extends WorkspaceEntity implements Owned, Auditable`**: holds a `Query` (the existing where-group value object), plus mode and direction.
- **`interface RouteProvider { readonly modes; estimate(from, to, mode) }`**, implemented by `OpenRouteService` (walking, driving), `RememberedLength` (his last entry for the same trip) and `StraightLine`. **`RouteChain`** tries them in order (strategy plus fallback). A leg he edited by hand bypasses the chain. A billed provider can't be added without changing the rule above.
- **`DayPlanner`** (pure, no I/O): anchors, places and settings in; legs out. This is the heart, and gets the most tests: same place, windows, go-home threshold, conflicts, midnight, DST change days, repeating occurrences, a cancelled occurrence.
- **`TravelLinks`** (pure): a leg in, its app links out.

## Privacy and safety

- **Travel blocks are private to their member.** They are visible only on that member's views and to that member's agents, never to other members of a shared workspace.
- Titles use place **names** only ("Bus to Braude", "Drive home"), never an address. That keeps the optional Google push and agent views from leaking Home.
- Places, and Home above all, are visible only to their member.
  - Never shared with the workspace.
  - Never in audit-log details.
  - Never returned to agents. MCP shows place **names** only.
- Coordinates are sent to OpenRouteService (and addresses to the geocoder) to compute lengths. The privacy page must say so.
- Rules and manual travel only create TodoList's own blocks. They never edit the anchor or anything at a provider.
- Cost: none. Free services only, plus the per-workspace daily cap on the shared free key.

## Left to the builder

- Exact storage shape and indexes.
- Which mechanism runs the daily pass (see Generation and lifecycle).
- UI layout details within the existing design system.
- i18n copy (en and he).
- Test structure.

## Answered by Shalev

- **No billing of any kind**, because TodoList is a SaaS for him and his friends. Walking and driving use OpenRouteService's free key. Public transport is entered by hand, pre-filled from the last trip.
- Start, end and length: fill any two. From and to are optional.

## Calls I made (for Shalev to check)

- OpenRouteService for walking and driving, then his remembered length, then a straight-line estimate. Each workspace gets at most 100 routing calls a day.
- A 14-day horizon instead of the whole semester up front.
- Stay at the same place through windows. Going home is optional and off.
- The default factors and buffers in the table above.
- Travel blocks are hidden from task counts and lists, and visible in time views and to agents.
- No travel for all-day events. No per-day start place in the first version.
