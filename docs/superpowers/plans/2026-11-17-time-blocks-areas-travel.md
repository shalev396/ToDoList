# Time Blocks, Areas and Travel Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shalev reserves time in TodoList (time blocks and painted areas, stored once even when they repeat), and TodoList adds his travel time between the places his day happens in, protected like a lecture and private to him.

**Architecture:**

- Blocks, areas and travel legs are **local items** in the existing `Items` collection, with new kinds `block` and `travel`. New classes sit under an abstract `ScheduledItem` that is never `Completable`. A repeating block is one record: `props.recurrence` plus `props.exceptions[]`.
- One pure occurrence expansion in `server/src/types/recurrence/` serves the server (queries, MCP, travel) and the client (calendar, clock, timeline, agenda) through `@api-types`.
- Travel is a pure core (`DayPlanner`, `LegReconciler`, route providers) behind thin storage classes (`Place`, `TravelRule`, `TravelProfile`, `RoutingQuota`, `TravelLeg`).
- `TravelPlanner` regenerates one member's 14-day horizon on triggers and once a day from the hourly scheduled tick. It only writes TodoList's own `travel` items.

**Tech Stack:** TypeScript, Express 5, Mongoose, zod 4, `rrule` 2.8, node:test with mongodb-memory-server, React 19, FullCalendar 6, react-i18next, Tailwind and shadcn, pytest with Playwright.

**Spec:** Read both first; they are binding.

- `docs/superpowers/specs/2026-11-17-time-blocks-design.md`
- `docs/superpowers/specs/2026-11-17-travel-time-design.md`

Context only (a parallel plan builds them before this one starts):

- `docs/superpowers/specs/2026-11-17-topic-colours-design.md`
- `docs/superpowers/specs/2026-11-17-hourly-sync-and-block-tweaks-design.md`

## Global Constraints

- **Where you work:** branch `feat/time-colours-travel` in `C:/Projects/Github/Shalev396/TodoList/.worktrees/feat`, after the colours plan's tasks are committed there. Never push. Plain commit messages with no attribution lines. Never `--no-verify`.
- **Worktree setup**, once, if it isn't done yet:
  1. `npm ci` at the root, then in `server/` and in `client/`.
  2. `cp ../../server/.env.dev server/.env.dev` from the worktree root. Copy it only: never `cat`, open, print or grep any `server/.env*` file.
- **Server OOP:** only classes under `server/src/classes/**` reach the database. This is enforced by:
  - `server/class-boundary.mjs` (`DB_ALLOWED`, `DB_MODULES`);
  - `server/eslint.config.js` (`boundaryRule`);
  - `server/src/classes/classBoundary.test.ts` (import graph and raw-text grep).
- **Server shape:**
  - Contracts are interfaces plus `implements`, as in `server/src/classes/item/contracts.ts` and `server/src/classes/base/contracts.ts`.
  - Bases are abstract (`Item`, `WorkspaceEntity`).
  - Controllers, routes and MCP tools stay thin: parse, call one class method, answer.
  - `AuditLog.record` (`server/src/classes/AuditLog.ts`, `AUDIT_LOG_WRITER`) is the only audit writer.
- **Repositories:** add each new collection as `models/definitions/<X>.ts` (interface and table name) plus `models/mongoose/<X>.ts`, with a `mongoOnly(...)` getter in `server/src/models/index.ts`. Plain Mongo documents only.
- **No new AWS resources:** no function, queue, schedule, table or role (`server/infra/lib/constructs/compute.ts` keeps its one function). The daily travel pass runs inside the colours plan's scheduled tick.
- **Free services only:**
  - OpenRouteService's free key, read from the existing stage secret `todolist-<stage>-app-secrets` under key `OPENROUTESERVICE_API_KEY`, through `APP_SECRETS` in `server/src/services/appSecrets.ts`. It is optional, and the deploy never writes it.
  - Nominatim at most 1 request a second, with an identifying `User-Agent`.
  - Nothing billed.
- **Outbound HTTP** goes only through `createReadOnlyClient` with `liveTransport` (`server/src/sync/http.ts`: GET only, netGuard). Tests make no network calls (`server/src/testing/outboundGuard.ts`) and inject a fake `Transport` through `setTravelTransportForTests` (added in Task 10, following the `*ForTests` pattern in `server/src/config/testSwitches.ts`).
- **Read-only guarantee:** nothing in `classes/travel/**` or `TimeBlock` writes to any provider or edits an anchor item. Task 12 tests this.
- **Privacy rules are tests, not prose** (Tasks 12–14). Home and every place address or coordinate:
  - never appear in an audit-log row, a log line, MCP output, or another member's REST response;
  - travel titles use place names only.
- **i18n:** every user-facing string is added to both `client/src/i18n/translations/en/*.ts` and `he/*.ts`.
  - Key parity is checked by `client/tests/e2e/app/translations.py`.
  - Hebrew uses the existing voice (plural "you", as in `settings.ts`).
  - RTL: `dir="auto"` on user text, and logical classes (`ms-`/`me-`, `ps-`/`pe-`, `start`/`end`).
  - New namespaces are `scheduled` and `travel`. `timeBlocks` already names the calendar and clock views, so don't reuse it.
- **API:**
  - The envelope `res.success(data, status)` and `AppError(status, message, { code })` stay unchanged.
  - New codes go in `server/src/types/errorCodes.ts`, with their client text in `client/src/api/errors.ts` and both i18n `errors.ts` files.
  - Postman: `postman/collections/TodoList API` covers only Auth, Dashboard, Setup, Uploads and User, so no Postman requests are added.
- **Checks green at every commit** (pre-commit runs Prettier and ESLint on staged files; no new `eslint-disable`):
  - root: `npm run format:check`;
  - `cd server && npm run lint && npm run build && npm run test:unit`;
  - `cd client && npm run lint && npm run build && npm run test:unit`.
  - One server test file: `cd server && node --import tsx --test <file>`. One client test file: `cd client && node --import tsx --test <file>`.
- **UI tasks run their e2e locally** before handing over. Use three terminals from the worktree root:
  - API: `cd server && npm run start:local -- --stage dev --no-rate-limits` (`--no-rate-limits` as `client/tests/README.md` and CI run it).
  - Client: `cd client && npx vite --port 5191 --strictPort`.
  - Tests: `cd client && BASE_URL=http://localhost:5191 API_BASE_URL=http://127.0.0.1:3000/api C:/Projects/Github/Shalev396/TodoList/client/.venv/Scripts/python.exe -m pytest <file> --browser chromium --base-url http://localhost:5191 -p no:cacheprovider`. The venv exists only in the main checkout, at this path.
  - e2e files are named `test_*.py` (`client/pytest.ini` `python_files`).
- **Screenshots:** each UI task takes before and after screenshots, desktop (`DESKTOP_VIEWPORT`) and phone (a WebKit run at an iPhone viewport), one of them in Hebrew. Save them in the session scratchpad, not the repo, and list their paths in the hand-off.

## What this plan consumes from the colours plan

That plan (`2026-11-17-tweaks-sync-colours.md`) lands first. These are its real names (reconciled by the controller); use them exactly.

- **C1. Colour resolver** (`server/src/types/colours.ts`, client via `@api-types`):
  - `resolveColour(input: ColourInput, ctx: ColourContext): ItemColour`, plus `roleOf`, `subjectOf`, `subjectsOf`, `nextFamily`.
  - `ColourInput = { kind: ColourKind; provider; title; topicId; topicOverride; subject; layer: 'block' | 'area' | null }`; `ColourKind = ItemKind | 'block' | 'travel'` (compiles before and after `ITEM_KINDS` gains them).
  - `ItemColour = { family; role: 'scheduled' | 'work' | 'travel' | 'area'; from; subject; topicId }`. `roleOf` needs `provider` (a provider event is Scheduled), so call it through `colourInputOf(row)`, never with `{kind, layer}` alone.
  - Client adapter `colourInputOf(row)` reads **`props.layer`** and **`overlay.attrs.subject`**. Task 3 stores the layer at `props.layer` (`'block' | 'area'`; absent = `'block'`).
- **C2. Subjects:**
  - `SUBJECT_ATTRIBUTE_KEY = 'subject'`; an item's own value is at `overlay.attrs.subject` (string).
  - `Workspace#upsertSubject(caller, { name, rename?, family?, patterns?, attributeName? })` creates the Subject attribute on first use. The colours plan restricts it to editors+. Task 5 adds a thin idempotent `Subjects.ensure(caller, name)` (or a `Workspace#ensureSubject`) on top of it if a name-only call is needed: case-insensitive match returns the existing option and never changes its family or patterns.
  - Client: read subject names from the workspace attribute definitions the colours plan's Settings → Subjects uses. If no `subjectOptions(settings)` helper exists, add it next to that page's data hook.
- **C3. Drawing primitives** (the views already split rows by role, so area and travel rows draw as soon as they exist):
  - `splitAreas` and `nestInAreas` in `client/src/features/dashboards/blocks/time/areas.ts`;
  - calendar: `toAreaEventInput(occurrence, colour, timeZone)`, `toEventInput(item, timeZone, colour)`; travel gets class `tc-travel` and `--tc-hatch`;
  - clock: `ClockRingProps.areas: ClockArea[]` (`{id,title,start,end,colour}`), `HatchPatternDefs` and `hatchFill(idPrefix, family)` for travel arcs;
  - `TimelineAreaBand({title,start,end,colour,timeZone,locale,children})`, `AgendaAreaHeader({title,start,end,colour,timeZone,locale})`, `ColourDot`, `paintOf`, `colourVar`, `hatchBackground`.
  - **Agenda (reconciled):** the agenda nests areas with the colours plan's `nestInAreas`. This plan does **not** add `AgendaModel.sections`. Task 8 only makes sure area and block occurrences reach the agenda rows (expanded, with `props.layer`).
- **C4. Scheduled tick** (`server/src/jobs/scheduledTick.ts`):
  - `interface AfterDispatchPass { readonly name: string; run(now: Date): Promise<Record<string, number>> }` and the list `AFTER_DISPATCH_PASSES`.
  - `lambda.ts`'s `sync-dispatch` runs each pass after `dispatchAllSyncs('schedule')`. A pass that throws is recorded as `{failed: true}` and never fails the tick.
  - Task 12 adds `new TravelHorizonPass()` (a class implementing `AfterDispatchPass`, `run` returning counts such as `{workspaces, legsUpserted, legsRemoved}`) to `AFTER_DISPATCH_PASSES`, and updates the test `it('has no after-dispatch passes yet')`.

## Rulings (my calls)

1. **Storage.**
   - Ruling: a block, an area or a leg is a local item:
     - `kind: 'block'` (area: `props.layer: 'area'`) or `'travel'`;
     - repeats: `props.recurrence` (RRULE lines) and `props.exceptions` (`{ originalStart, startAt?, endAt?, skipped? }`, ISO strings);
     - travel: `props.travel` (TravelLegProps) and `props.travelKey`;
     - subject at `overlay.attrs.subject`.
   - Why: the existing queries, policies, views and MCP read items, and the spec asks for plain documents.
2. **Occurrence edits.**
   - Ruling: "This one" changes only start and end, since the spec's exception holds only times. Title, subject, topic and the rule change for all occurrences, so the dialog asks "this one / all" only for time changes.
   - Ruling: an "All" edit that moves the time or changes the rule drops the exceptions that are no longer occurrences of the new series. Why: no orphan exceptions.
3. **Bounds.** Ruling: a block lasts from 1 minute to 24 hours; at most 366 exceptions (`PLAN_LIMITS.timeBlockExceptionsMax`). Why: keeps expansion and storage bounded.
4. **Series in date ranges.**
   - Found in code: the calendar block's default query (`dateRange: '$page.range'`, `dateField: 'any'`, `server/src/builder/catalog.ts:304`) matches only a `startAt` inside the range. So a series whose first occurrence is before the visible week is never read, and that holds for Google masters too.
   - Ruling: on `startAt`/`any` ranges, a series row (`props.recurrence.0` is a string) with `startAt < range.to` also matches, and expansion trims it. Why: semester series must show every week. The over-read is bounded by the number of series.
5. **Task-shaped vs time-shaped results.**
   - Ruling: time-shaped block types are `calendar`, `clock`, `timeline`, `agenda` and `workload`. Everything else, and queries with no block type, are task-shaped and exclude `block` and `travel`.
   - "Names the kinds explicitly" means any rule on field `kind` in the where-group, or the REST/MCP `kind` parameter.
   - Why: this is the spec's split, made checkable.
6. **MCP time tools.**
   - Ruling: `get_calendar` returns one entry per occurrence of a series (Google series included), each with `occurrence: { seriesId, originalStart }` and `busy`. `list_today` gains `scheduled[]` (blocks, areas, travel) with `layer` and `busy` (false for areas).
   - Why: the spec says MCP agrees on every occurrence, and every added field is optional.
7. **Wrong actions on scheduled items.** Ruling:
   - completing a scheduled item: 409 `not_completable`;
   - deleting a leg: 409 `not_deletable` (skip it instead);
   - a generic `PATCH /items/:id` on a block is an "All" edit of title, note, topic, start and end; on a leg it is a hand edit of start and end; any other field is 400.
8. **Leg privacy.** Ruling: legs are stored `visibility: 'private'` and owned by the member, and `ItemPolicy` adds a kind branch on top. Why: belt and braces, as the spec asks.
9. **Leg key.**
   - Ruling: the key is `ownerUserId|anchorItemId|occurrence|direction`:
     - occurrence = the original start as ISO, or `single`;
     - a moved Google occurrence anchors on its series master.
   - Why: two members can share one lecture.
10. **Links.** Ruling: computed on read, served by REST to the owner only, never stored and never sent over MCP. Why: they carry coordinates.
11. **Travel rules.** Ruling: one `TravelRule` model with three scopes, `where`, `series` and `item`. Manual travel and "every occurrence" are both rules. Precedence: item, then series, then where-rules oldest first. Why: the spec already makes series marking a rule.
12. **Regeneration.**
    - Ruling: the unit is one member's whole 14-day horizon. Why: an anchor moved to another day becomes an update, not a removal plus a create.
    - Ruling: "once a day per workspace" runs per member, since travel is per member, which gives the same bound.
    - Ruling: the pass gets 120 s per tick, and members it doesn't reach run in the next hour.
13. **Lengths.**
    - Ruling: factor and buffer apply to computed lengths (OpenRouteService and straight line), never to his own entries (remembered or manual).
    - Ruling: the straight-line speed for public transport is 25 km/h × 1.3, which the spec doesn't give. Why: the Status section says rough values are fine.
14. **Geocoding.** Ruling:
    - OpenRouteService's geocoder when the key exists, else Nominatim;
    - at most 10 new lookups per regeneration, cached per member;
    - "lat, lon" typed in the address field is taken as coordinates, with no lookup.
15. **Audit.** Ruling: places are not audited; rule changes are audited with `mode`, `direction` and `scopeKind` only.
16. **Access.**
    - Ruling: travel is for editors and owners (`requireWorkspace('editor')`, MCP `minRole: 'editor'`). Why: legs are items TodoList creates for the member.
    - Ruling: MCP travel tools join the `items` toolset. Why: no change to `TOOLSETS` or the order in MCP.md §7.
17. **Item changes.** Ruling: travel hears about item writes through an `ItemChanges` observer, and a travel failure never fails the item write. Why: no import cycle from `Todo` to travel.
18. **Timeline.** Ruling: it has no time grid, so it gets a "+" per day instead of drag.
19. **Day panel.** Ruling: titles are stored from English templates (for MCP and the push); the UI renders legs from `props.travel` through i18n. The day panel opens from a leg's sheet, from Settings → Travel's 14-day list, and from an agenda chip on days with changes.
20. **Skip.** Ruling: a skipped leg is a tombstone with reason `skipped`. Regeneration never restores it; Reset does.
21. **One rrule copy.** Ruling: the shared module imports `rrule`; the server adds it, and the client's Vite config adds `resolve.dedupe: ['rrule']` so it bundles one copy.
22. **New error codes:** `not_completable`, `not_deletable`, `not_an_occurrence`, `place_not_found`, `travel_home_missing`, `travel_limit`.
23. **Limits:** 30 places and 50 travel rules per member (`PLAN_LIMITS.placesPerMember`, `travelRulesPerMember`).
24. **No Home, no legs.** Ruling: marking travel without a Home answers 409 `travel_home_missing`.
25. **Leaving.** Ruling:
    - when a membership ends, the member's places, rules and profile are hard-deleted and their legs soft-deleted at once;
    - deleting a workspace removes all its travel documents.
26. **Calendar push.** Ruling: the workspace-calendar push leaves out blocks and travel in this version. Why: the spec makes including them optional and off by default, so no setting is added.
27. **Task order** differs from the brief's 10 steps, for size and because of the series-range finding (Ruling 4):
    - kinds (3) and query shapes (4) are split;
    - the client work is split into three tasks (6–8);
    - travel's pure core is split into planner (9) and routing (10);
    - persistence is split into storage (11) and generation (12);
    - the API is split into REST (13) and MCP (14);
    - the travel UI is split into three tasks (15–17).

## Review Focus

1. **A series whose first occurrence is weeks before the visible range** (the semester case) must appear in every week: in the calendar, the clock, MCP `get_calendar` and the travel horizon. Test: Task 4 `series started eight weeks ago is read for this week`.
2. **The DST change day in Asia/Jerusalem:**
   - a weekly 13:00 block stays at 13:00 wall clock (2026-10-25);
   - a 40-minute leg before it starts at 12:20 wall clock.
   - Tests: Task 2 cases `dst-end-weekly-block` and `dst-start-friday`, and Task 9 `leg on the DST end day keeps wall-clock arrival`.
3. **Two members of one workspace with travel to the same shared lecture** each get their own legs, and neither sees the other's. Tests:
   - Task 11 `two owners, one anchor: two legs`;
   - Task 13 `member B never reads A's legs or places`.
4. **An "All" edit on a series that has exceptions, skips and legs** must drop the exceptions that are no longer occurrences, without a crash. The legs keyed on them are removed with reason `moved` or `cancelled`. Tests:
   - Task 5 `edit all at a new time drops stale exceptions`;
   - Task 12 `all-edit of an anchor series reconciles its legs`.
5. **Each of these must still make legs**, labelled `estimate` or `remembered`:
   - no OpenRouteService key;
   - OpenRouteService down;
   - the 100-call quota used up;
   - an address the geocoder can't find. Creating a place with that address answers 400 `place_not_found`, never 500.

   Tests: Task 10 `chain falls back when ORS fails or quota is spent`, and Task 13 `unknown address is 400 place_not_found`.

---

### Task 1: Audit every place that assumes "local = to-do" (S, ~150 lines, docs only)

**Files:**

- Create: `docs/design/LOCAL-IS-TODO.md`

**Interfaces:**

- Produces: a checklist. Later tasks tick its rows, with the commit that fixed each one.

- [ ] **Step 1: Run the sweeps and keep every hit**

```bash
cd server && git grep -n -E "provider === 'local'|provider !== 'local'|instanceof Todo|isLocal|integrationId: null|OPEN_STATUSES|'complete'|status: 'open'" -- src ':!*.test.ts' ':!src/testing/**'
cd ../client && git grep -n -E "provider === 'local'|origin === 'local'|useCompleteItem|completeItem|setItemStatus|NewTodoSheet|kinds\." -- src ':!*.test.ts'
cd .. && git grep -n -E "complete_todo|update_todo|delete_todo|create_todo" -- server/src/mcp agent-plugin
```

- [ ] **Step 2: Write the checklist.**
  - Columns: `#`, `Where (path:line)`, `Assumption`, `What a block/area/travel item would do`, `Fixed in task`, `Done (commit)`.
  - Every hit from Step 1 is either a row or listed under "Checked, no change" with one line why.
  - Seed rows, which you verify and complete:
    - `server/src/classes/item/Item.ts:73` `classOf`: local is a Todo. Task 3.
    - `server/src/controllers/items.ts` `remove` and `complete`: `instanceof Todo`, else a 409 "mirrored" error. Task 3.
    - `Todo.findOwn` (`Todo.ts:211`) and `TodoCopy.ts:376`: any local item is a to-do. Task 3.
    - `ItemPolicy.canEdit`/`refusal` (`ItemPolicy.ts:190`, `:221`) and `ItemAccessFilter#baseItems` (`:133-134`): the workspace-visible local branch would show travel. Task 3.
    - Workspace-calendar push: `classes/calendar/Calendar.ts` `pushItems` scope and `PushCommit.ts:125`. Local items get pushed. Task 3.
    - `countPrivateLocalOfFormerMembers` in `models/mongoose/Item.ts`: counts legs as private to-dos. Task 3.
    - `builder/compile.ts` `compileQuery` and `ItemQuery.list`: no kind default. Task 4.
    - MCP:
      - `list_today` only reads `kind = event` for timed items, so blocks are missing;
      - `get_calendar` doesn't expand series;
      - `list_deadlines`, `query_items` and `search_items` are task-shaped.

      Task 4.

    - MCP `complete_todo`, `update_todo` and `delete_todo`. Task 3.
    - `Todo.create` defaults to the `personal` topic; blocks must not. Task 5.
    - Client:
      - `ItemSheet.tsx:126` `isLocal` → to-do controls (Tasks 3 and 7);
      - `ListBlock.tsx:57` checkbox (Task 3);
      - `kanbanDrag.ts:10` draggable status (Task 3);
      - `NewTodoSheet.tsx` creates to-dos only (Task 6);
      - `items.kinds.*` labels (Task 3).
    - Checked, no change:
      - `ItemQuery.facets` (kinds listed for explicit filters);
      - `SourceLink.tsx:95` (an app link works for any local item);
      - `testing/**`.

- [ ] **Step 3: Verify** that each hit of Step 1 appears in the file: `git grep -c` per path, compared by eye with the table.
- [ ] **Step 4: Commit:** `git add docs/design/LOCAL-IS-TODO.md && git commit -m "Audit: every place that assumes a local item is a to-do"`

---

### Task 2: One occurrence expansion for server and client (M, ~600 lines)

**Files:**

- Create:
  - `server/src/types/recurrence/zoned.ts`
  - `server/src/types/recurrence/occurrences.ts`
  - `server/src/types/recurrence/cases.ts` (parity cases, pure data)
  - `server/src/types/recurrence/occurrences.test.ts`
- Modify:
  - `server/package.json` and `server/package-lock.json` (`"rrule": "^2.8.1"`, the client's version);
  - `client/src/features/dashboards/blocks/time/occurrences.ts`: becomes a re-export of the shared module, so callers keep their imports;
  - `client/src/features/dashboards/blocks/clock/ClockRing.math.ts`: re-export `zonedParts`, `zonedTime`, `startOfZonedDay` and `endOfZonedDay` from the shared module, keeping its other functions;
  - `client/src/features/dashboards/blocks/time/occurrences.test.ts`: also runs every parity case;
  - `client/vite.config.ts`: `resolve.dedupe: ['rrule']`.

**Interfaces:**

- Produces, in `server/src/types/recurrence/zoned.ts` (pure, `Intl` only): `zonedParts(date, timeZone)`, `zonedTime(y, m, d, h, min, timeZone): Date`, `startOfZonedDay(date, tz)`, `endOfZonedDay(date, tz)`, `addLocalDays(date, days, tz)`, `wallString(date, tz)`, `wallDate(date, tz)`, and the new `fromWallString(wall: string, timeZone: string): Date` (the inverse of `wallString`).
- Produces, in `server/src/types/recurrence/occurrences.ts`:
  - `TimeRow`, `Range` and `WeekStart`: unchanged from today's client file;
  - `interface LocalException { originalStart: string; startAt?: string; endAt?: string; skipped?: boolean }`;
  - `interface Occurrence { key: string; row: TimeRow; start: Date; end: Date | null; allDay: boolean; dueOnly: boolean; originalStart: Date | null; seriesRowId: string | null }`:
    - `originalStart`: a series occurrence's slot. For a Google moved or cancelled exception row it comes from `props.originalStartAt`.
    - `seriesRowId`: the series row's id. For a Google exception row, the master's id when the master is among the rows.
    - `key`: `${seriesRowId ?? row.id}@${originalStartMs}` for occurrences, `row.id` otherwise.
  - `expandOccurrences(rows: readonly TimeRow[], range: Range, timeZone: string): Occurrence[]`;
  - `localExceptionsOf(props: Readonly<Record<string, unknown>>): LocalException[]`;
  - `isSeriesRow(row: Pick<TimeRow, 'props'>): boolean`;
  - re-exports `wallString` and `wallDate` from `zoned.ts`, so today's `../time/occurrences` imports keep working;
  - unchanged: `toDate`, `weekRange`, `monthGridRange`, `visibleRange` and `MAX_OCCURRENCES_PER_SERIES = 400`.
- Produces, in `cases.ts`: `export const PARITY_CASES: readonly { name: string; rows: TimeRow[]; range: { from: string; to: string }; timeZone: string; expected: { key: string; start: string; end: string | null }[] }[]`.

- [ ] **Step 1: Write the parity cases and the failing server test.** All cases use `Asia/Jerusalem`.
  - `single-timed`, `due-only`: today's behaviour.
  - `google-cancelled-occurrence`, `google-moved-occurrence`: today's behaviour. The moved one also asserts `originalStart` and `seriesRowId` equal to the master's id.
  - `local-weekly-block`: Sunday 13:00–17:00 local, `RRULE:FREQ=WEEKLY;BYDAY=SU`.
  - `dst-end-weekly-block`: the same rule over 2026-10-18…2026-11-02. Expect starts `2026-10-18T10:00:00.000Z`, `2026-10-25T11:00:00.000Z` and `2026-11-01T11:00:00.000Z`.
  - `dst-start-friday`: weekly Friday 10:00. Expect `2027-03-19T08:00:00.000Z` and `2027-03-26T07:00:00.000Z`.
  - `local-skipped`: an exception `{ originalStart, skipped: true }`, so no occurrence.
  - `local-moved`: an exception moving it to 14:00–17:00. Its key and `originalStart` stay the original slot's.
  - `local-moved-into-range`: the original slot is outside the range and the new time is inside it, so it is included.
  - `series-started-eight-weeks-ago`: only this week's occurrence.
  - `until-before-range`: nothing.
  - `unreadable-rule`: the first occurrence alone.

```ts
for (const c of PARITY_CASES) {
  it(c.name, () => {
    const got = expandOccurrences(
      c.rows,
      { from: new Date(c.range.from), to: new Date(c.range.to) },
      c.timeZone,
    );
    assert.deepEqual(
      got.map((o) => ({
        key: o.key,
        start: o.start.toISOString(),
        end: o.end?.toISOString() ?? null,
      })),
      c.expected,
    );
  });
}
```

- [ ] **Step 2: Run the server test to verify it fails.** Run `cd server && node --import tsx --test src/types/recurrence/occurrences.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3: Implement.**
  - Move the client's `occurrences.ts` body and the four zone helpers into the shared files, with relative imports ending in `.js`.
  - Keep the CJS/ESM `rrulestr` pick.
  - A local row (`source.provider === 'local'`) with an RRULE line is a series, expanded on the workspace's wall clock like a Google master.
  - Its `props.exceptions` remove skipped slots and replace moved ones. Moved occurrences whose new time overlaps the range are added even when their original slot is outside it.
- [ ] **Step 4: Run the server test again.** Expect PASS.
- [ ] **Step 5: Make the client a thin caller.**
  - `client/src/features/dashboards/blocks/time/occurrences.ts` becomes `export * from '@api-types/recurrence/occurrences.ts';`.
  - In the client test, add a loop over `PARITY_CASES` (imported from `@api-types/recurrence/cases.ts`) through the client import path.
  - Run `cd client && node --import tsx --test src/features/dashboards/blocks/time/occurrences.test.ts src/features/dashboards/blocks/clock/ClockRing.math.test.ts`. Expect PASS, with the old tests unchanged.
- [ ] **Step 6: Check the layer and the build.** Run `cd server && npm run build && npm run build:layers`, then `cd client && npm run build`. Expect both to exit 0, and the deps layer to list `rrule`.
- [ ] **Step 7: Commit:** `git commit -m "Recurrence: one occurrence expansion shared by server and client, with local series exceptions"` (include `server/package-lock.json`).

---

### Task 3: Kinds `block` and `travel`, the `ScheduledItem` classes, and the guards (L, ~750 lines)

**Files:**

- Modify: `server/src/types/domain.ts`
  - `ITEM_KINDS` adds `'block', 'travel'`;
  - new `SCHEDULED_KINDS = ['block', 'travel'] as const`.
- Modify: `server/src/types/items.ts` (`ItemSummary.layer?: BlockLayer`).
- Create: `server/src/types/scheduled.ts`
  - `BLOCK_LAYERS = ['block', 'area'] as const`, `type BlockLayer`;
  - `layerOf(row: { kind: string; props: Readonly<Record<string, unknown>> }): BlockLayer | null`;
  - `isScheduledKind(kind: string): boolean`.
- Create: `server/src/types/travel.ts`
  - `TRAVEL_MODES = ['walk', 'drive', 'transit']`, `TRAVEL_DIRECTIONS = ['there', 'back', 'between']`;
  - `LEG_SOURCES = ['ors', 'remembered', 'manual', 'estimate']`;
  - `REMOVAL_REASONS = ['cancelled', 'moved', 'no_longer_matches', 'no_place', 'replaced', 'skipped']`;
  - `interface TravelLegProps`, `travelPropsOf(props): TravelLegProps | null`.
- Create in `server/src/classes/item/`: `ScheduledItem.ts`, `TimeBlock.ts`, `TimeArea.ts`, `TravelLeg.ts`, `scheduled.test.ts`.
- Modify in `server/src/classes/item/`:
  - `Item.ts`: `ItemClassName`, `classOf`, `facts`;
  - `contracts.ts`: `Recurring`, `isCompletable`, `isDeletable`;
  - `CalendarEvent.ts`: implements `Recurring`;
  - `index.ts` and `ItemQuery.ts`: import the new classes so they register;
  - `Todo.ts` (`findOwn`) and `TodoCopy.ts:376`: refuse non-todo kinds with 404.
- Modify:
  - `server/src/classes/policies/ItemPolicy.ts` (`ItemFacts.kind`, travel branch in `canRead`);
  - `server/src/classes/policies/ItemAccessFilter.ts`;
  - `server/src/classes/policies/itemPolicy.agreement.test.ts`;
  - `server/src/controllers/items.ts` (`remove`, `complete`);
  - `server/src/mcp/tools/items/{completeTodo,updateTodo,deleteTodo}.ts`;
  - `server/src/classes/calendar/Calendar.ts`: the push scope excludes `SCHEDULED_KINDS`;
  - `server/src/models/mongoose/Item.ts`: `countPrivateLocalOfFormerMembers` adds `kind: { $ne: 'travel' }`;
  - `server/src/types/errorCodes.ts` (`not_completable`, `not_deletable`), `client/src/api/errors.ts`, and `client/src/i18n/translations/{en,he}/errors.ts`;
  - `server/src/routes/private/items.http.test.ts`, `server/src/gcal/plan.test.ts`.
- Modify (client):
  - `client/src/i18n/translations/{en,he}/items.ts`: `kinds.block` "Time block" / "בלוק זמן" and `kinds.travel` "Travel" / "נסיעה";
  - `client/src/features/dashboards/blocks/data/kanbanDrag.ts`: scheduled kinds aren't draggable;
  - `client/src/features/dashboards/blocks/ListBlock.tsx`: no checkbox for scheduled kinds;
  - `client/src/features/items/ItemSheet.tsx`: no completion control for scheduled kinds.
- Modify: `docs/design/CLASSES.md`: the spec's class diagram plus `TimeArea`, in §4; tick the audit rows.

**Interfaces:**

- Consumes:
  - Task 2's `expandOccurrences`, `Occurrence`, `Range` and `LocalException`;
  - C1's storage contract (`props.layer`).
- Produces:
  - `Item.classOf(data: Pick<ItemData, 'kind' | 'source' | 'props'>): ItemClassName`, where `ItemClassName = 'todo' | 'task' | 'pr' | 'event' | 'block' | 'area' | 'travel'`.
    - Local items: `travel` → `'travel'`; `block` → `'area'` when `props.layer === 'area'`, else `'block'`; anything else → `'todo'`.
    - Mirrored items: unchanged.
  - `ItemFacts.kind: ItemKind`.
  - `interface Recurring { readonly isRecurring: boolean; readonly recurrenceLines: readonly string[] }`.
  - `isCompletable(item: Item): item is Item & Completable<Item>` and `isDeletable(item: Item): item is Item & Deletable`.
  - `abstract class ScheduledItem extends Item implements Schedulable`:
    - `readonly isLocal = true`;
    - `get timeRange(): TimeRange | null`;
    - `editing()` → `ItemEditing.local()`; `providerChanges()` → `{}`;
    - `toSummary()` adds `layer`.
  - `class TimeBlock extends ScheduledItem implements Recurring, Deletable`:
    - getters `layer: BlockLayer`, `subject: string | null` (reads `overlay.attrs.subject`), `exceptions: readonly LocalException[]`;
    - `occurrences(range: Range, timeZone: string): Occurrence[]`;
    - `delete(caller)`: a soft delete through `ItemPolicy` `manage`;
    - `edit()` throws `ValidationError('edit: use PATCH /time-blocks/:id')` until Task 5.
  - `class TimeArea extends TimeBlock`: `layer` is `'area'`.
  - `class TravelLeg extends ScheduledItem`:
    - `get travel(): TravelLegProps`;
    - `edit()` throws `ValidationError('edit: use PATCH /travel/legs/:id')` until Task 11.

- [ ] **Step 1: Write the failing tests.**
  - `scheduled.test.ts`, using repository `createLocal` with `kind: 'block'` and `props.layer`:
    - `classOf maps local block, area and travel` (and a local todo stays `'todo'`);
    - `Item.from gives TimeBlock, TimeArea and TravelLeg instances` (`TimeArea instanceof TimeBlock`);
    - `a scheduled item is not completable`: `assert.equal(isCompletable(block), false)`;
    - `weekly block yields its occurrences in the workspace zone`.
  - `itemPolicy.agreement.test.ts`:
    - `travel is readable by its owner only, even if stored workspace-visible`: `canRead` and the filter agree.
  - `items.http.test.ts`:
    - `POST /items/:id/complete on a block → 409 not_completable`;
    - `DELETE a travel leg → 409 not_deletable`;
    - `DELETE a block → 204`.
  - `plan.test.ts`:
    - `blocks and travel are never in the workspace calendar push set`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/classes/item/scheduled.test.ts src/classes/policies/itemPolicy.agreement.test.ts src/routes/private/items.http.test.ts src/gcal/plan.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement the classes, `classOf`, the policy and filter branch, and the guards.**
  - The filter: the `{ integrationId: null, visibility: 'workspace' }` branch gains `kind: { $ne: 'travel' }`.
  - The controllers and the MCP item tools use `isCompletable` and `isDeletable`:
    - completing a non-completable item: `AppError(409, 'A time block or travel has no status', { code: 'not_completable' })`;
    - deleting a non-deletable `TravelLeg`: `AppError(409, 'Travel is skipped, not deleted', { code: 'not_deletable' })`;
    - a mirrored item keeps `MirroredItemError` as today.
  - `update_todo` on a block, an area or a leg: 400 naming `edit_time_block` or `travel_edit_leg`.
  - `delete_todo` also deletes blocks and areas; update its description.
- [ ] **Step 4: Run the tests again.** Expect PASS. Then run the full `npm run test:unit` in `server`, plus the client `lint`, `build` and `test:unit`. Expect green.
- [ ] **Step 5: Update `CLASSES.md`** (the diagram and a short "Scheduled items" section) and tick the audit rows.
- [ ] **Step 6: Commit:** `git commit -m "Items: block and travel kinds, ScheduledItem classes that cannot be completed, travel private to its member"`

---

### Task 4: Task-shaped and time-shaped results, series in date ranges, MCP time tools (M–L, ~650 lines)

**Files:**

- Modify:
  - `server/src/builder/compile.ts`:
    - `TIME_SHAPED_BLOCKS`, `namesKind`;
    - `compileQuery` adds the default exclusion;
    - `Compilation.dateRange` adds the series branch;
  - `server/src/classes/item/ItemQuery.ts` (`list`: a `kind` of `undefined` gets `{ $nin: [...SCHEDULED_KINDS] }`);
  - `server/src/mcp/tools/itemViews.ts`: `ItemSummaryView` gains optional `layer`, `occurrence: { seriesId: string; originalStart: string } | null` and `busy: boolean`, plus `toOccurrenceView(summary, occurrence)`;
  - `server/src/mcp/tools/read/bridge.ts`: `findItems(ctx, draft, now?, options?: { blockType?: BlockType })` now returns `{ items, rows, total }`;
  - `server/src/mcp/tools/read/listToday.ts`, `server/src/mcp/tools/read/getCalendar.ts`.
- Test:
  - `server/src/builder/compile.test.ts` (modify);
  - `server/src/services/workspaceQuery.scheduled.test.ts` (create; memory DB);
  - `server/src/mcp/__tests__/readTools.test.ts` (modify).

**Interfaces:**

- Consumes: Task 3's kinds and `layerOf`, Task 2's `expandOccurrences`.
- Produces:
  - `export const TIME_SHAPED_BLOCKS: ReadonlySet<BlockType>`, with `calendar`, `clock`, `timeline`, `agenda` and `workload`;
  - `export function namesKind(group: RuleGroup | undefined): boolean`, true for any rule on `kind` at any depth.
  - Task 12 calls `findItems`-style drafts with `blockType: 'calendar'` to get time-shaped results.

- [ ] **Step 1: Write the failing tests.**
  - `compile.test.ts`:
    - `task-shaped query excludes block and travel`: no `blockType`, and `list`, `counter`, `chart` and `deadlines` all have `{ kind: { $nin: ['block', 'travel'] } }` in the pipeline;
    - `time-shaped block types include them`: `calendar`, `clock`, `timeline`, `agenda` and `workload` don't;
    - `a where rule on kind lifts the default` (`{ field: 'kind', operator: '=', value: 'block' }`);
    - `startAt range also matches a series row that started before it`: the `$or` holds `{ 'props.recurrence.0': { $type: 'string' }, startAt: { $lt: to } }`.
  - `workspaceQuery.scheduled.test.ts`:
    - `series started eight weeks ago is read for this week` (calendar draft over `$page.range`) — **Review Focus 1**;
    - `blocks hidden from a list draft, shown in a calendar draft`;
    - `GET-style ItemQuery.list hides blocks unless kind=block`.
  - `readTools.test.ts`:
    - `list_today.scheduled holds today's block, area (layer area, busy false) and travel (busy true)`;
    - `get_calendar returns one entry per occurrence of a weekly series begun before the range, with occurrence.originalStart`;
    - `query_items, search_items and list_deadlines leave out blocks unless kind is given`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/builder/compile.test.ts src/services/workspaceQuery.scheduled.test.ts src/mcp/__tests__/readTools.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `compileQuery` pushes the exclusion when `source === 'items' && !TIME_SHAPED_BLOCKS.has(ctx.blockType) && !namesKind(parsed.where)`.
  - `dateRange` with `startAt` or `any` adds the series branch.
  - `list_today` runs one more `findItems` with `blockType: 'agenda'`, `where: kind in SCHEDULED_KINDS`, over today's range. It expands the rows and maps each occurrence through `toOccurrenceView`.
  - `get_calendar` uses `blockType: 'calendar'`, expands `rows`, maps occurrences, then cuts to `limit`.
  - Update both tools' descriptions to mention blocks, areas (`layer`) and travel as busy time, with areas not busy.
- [ ] **Step 4: Run the tests again** (Expect PASS), then the full server `npm run test:unit`. Fix `contract.test.ts` only if an output schema snapshot changed.
- [ ] **Step 5: Commit:** `git commit -m "Queries: task views leave out blocks and travel, time views and MCP time tools include them, series show in every week"`

---

### Task 5: Time block API, MCP `create_time_block` and `edit_time_block`, subject on first use (L, ~750 lines)

**Files:**

- Modify:
  - `server/src/classes/item/TimeBlock.ts` and `TimeArea.ts` (the mutations);
  - `server/src/types/limits.ts` (`timeBlockExceptionsMax: 366`);
  - `server/src/types/errorCodes.ts` (`not_an_occurrence`), plus the client errors file and the en/he i18n `errors.ts` files;
  - `server/src/controllers/index.ts`, `server/src/routes/private/index.ts`;
  - `server/src/mcp/tools/items/index.ts`;
  - `server/src/mcp/__tests__/contract.test.ts` (catalog rows), `server/src/mcp/__tests__/itemTools.test.ts`.
- Create:
  - `server/src/types/timeBlocks.ts` (API types, shared);
  - `server/src/services/timeBlockSchemas.ts` (zod, strict);
  - `server/src/controllers/timeBlocks.ts`, `server/src/routes/private/timeBlocks.ts`;
  - `server/src/mcp/tools/items/createTimeBlock.ts`, `server/src/mcp/tools/items/editTimeBlock.ts`;
  - `server/src/classes/item/TimeBlock.test.ts`, `server/src/routes/private/timeBlocks.http.test.ts`.

**Interfaces:**

- Consumes:
  - C2 `Subjects.ensure`;
  - `RecurrenceRule.fromLines(lines).fits(false)` (`server/src/classes/integration/RecurrenceRule.ts`);
  - `TimeRange.of`, `Topic.assertOf`;
  - Task 2 `expandOccurrences`.
- Produces on `TimeBlock`:
  - `static create(caller: Caller, input: NewTimeBlock): Promise<{ block: TimeBlock; created: boolean }>`;
  - `editSeries(caller: Caller, change: SeriesChange): Promise<TimeBlock>`;
  - `editOccurrence(caller: Caller, originalStart: Date, change: { startAt: Date; endAt: Date }): Promise<TimeBlock>`;
  - `skipOccurrence(caller: Caller, originalStart: Date): Promise<TimeBlock>`;
  - `edit(caller, edit: ItemEdit)`: `editSeries` for title, note, topic, start and end; 400 for any other field;
  - `static lastTopicForSubject(caller: Caller, subject: string): Promise<string | null>`.
- Input types:
  - `NewTimeBlock { layer: BlockLayer; title?: string; subject?: string; note?: string; topicId?: string | null; startAt: Date; endAt: Date; recurrence?: readonly string[]; idempotencyKey?: string }`;
  - `SeriesChange { title?: string; note?: string | null; topicId?: string | null; subject?: string | null; startAt?: Date; endAt?: Date; recurrence?: readonly string[] | null }`.
- Produces in `server/src/types/timeBlocks.ts`:
  - `CreateTimeBlockRequest { layer?: BlockLayer; title?: string; subject?: string; note?: string; topicId?: string | null; startAt: string; endAt: string; recurrence?: string[]; idempotencyKey?: string }`;
  - `EditTimeBlockRequest { scope: 'all' | 'this'; originalStart?: string; title?: string; note?: string | null; subject?: string | null; topicId?: string | null; startAt?: string; endAt?: string; recurrence?: string[] | null }`;
  - `SkipOccurrenceRequest { originalStart: string }`.
- Routes (all `requireWorkspace('editor')`, answers `ItemDetail`):

  | Method and path                                      | Answer                                      |
  | ---------------------------------------------------- | ------------------------------------------- |
  | `POST /api/private/workspaces/:wid/time-blocks`      | 201, or 200 for a repeated `idempotencyKey` |
  | `PATCH /api/private/workspaces/:wid/time-blocks/:id` | 200                                         |
  | `POST …/time-blocks/:id/skip`                        | 200                                         |
  - Deleting stays `DELETE /items/:id` (Task 3).

- MCP:
  - `create_time_block`: input `{ layer?: 'block' | 'area', title?, subject?, topic?: TopicRef, startAt, endAt, recurrence?: string[], note?, idempotencyKey? }`. Output `{ item: ItemDetailView, created: boolean }`.
  - `edit_time_block`: input `{ id, scope: 'this' | 'all', originalStart?, title?, subject?, topic?, startAt?, endAt?, recurrence?: string[] | null, skip?: boolean }`. Output `{ item: ItemDetailView }`.
  - Both: `scopes: ['items:write']`, `minRole: 'editor'`, `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`. Add both to the `items` toolset after `create_todo` and `update_todo`, and as rows in `contract.test.ts`.

- [ ] **Step 1: Write the failing class tests** in `TimeBlock.test.ts` (memory DB, as `Todo.createAll.test.ts` sets up):
  - `title defaults to the subject`;
  - `subject is created on first use`: the Subject attribute exists afterwards with option "Math";
  - `topic: preset, else last used with the subject, else null; never the personal topic`;
  - `an area needs a title` (400);
  - `recurrence is checked`: `RRULE:FREQ=HOURLY` → 400, and a date-only UNTIL on a timed block → 400;
  - `duration 1 min to 24 h` (400 outside);
  - `this-one edit stores an exception keyed by originalStart`;
  - `originalStart that is not an occurrence → 400 not_an_occurrence`;
  - `skip stores a skipped exception and expansion leaves it out`;
  - `edit all at a new time drops stale exceptions` — **Review Focus 4**;
  - `exceptions cap at 366`;
  - `viewer → 403`, and `another member's private block → 404`.
- [ ] **Step 2: Write the failing HTTP and MCP tests.**
  - `timeBlocks.http.test.ts`: status codes, the envelope, idempotency 201 then 200, 400 for unknown keys (strict schema).
  - `itemTools.test.ts`:
    - `create_time_block with weekly recurrence and subject`;
    - `create_time_block layer area`;
    - `edit_time_block this, all and skip`;
    - a viewer key is refused by the role matrix.
- [ ] **Step 3: Run them to verify they fail.** Run `cd server && node --import tsx --test src/classes/item/TimeBlock.test.ts src/routes/private/timeBlocks.http.test.ts src/mcp/__tests__/itemTools.test.ts src/mcp/__tests__/contract.test.ts`. Expect FAIL.
- [ ] **Step 4: Implement** the class methods, schemas, controller, routes and tools.
  - `create` stores `kind: 'block'`, `props: { layer, recurrence?, exceptions: [] }` and `overlay.attrs.subject`, through `createLocal` plus `setOverlay`, in one class method.
  - Occurrence validation expands one millisecond around `originalStart` (Task 2).
- [ ] **Step 5: Run the tests again** (Expect PASS), then the full server `npm run test:unit`.
- [ ] **Step 6: Commit:** `git commit -m "Time blocks: create, edit this one or all, skip; MCP create_time_block and edit_time_block"`

---

### Task 6: Client create form with three kinds, and the time block form (L, ~650 lines)

**Files:**

- Create:
  - `server/src/types/timeSpan.ts` and `server/src/types/timeSpan.test.ts` (shared "any two of start, end and length");
  - in `client/src/features/items/create/`: `KindChoice.tsx`, `TimeBlockForm.tsx`, `timeBlockForm.ts`, `timeBlockForm.test.ts`;
  - `client/src/api/services/timeBlockService.ts`, `client/src/api/queries/timeBlocks.ts`;
  - `client/src/i18n/translations/{en,he}/scheduled.ts`;
  - `client/tests/helpers/scheduled.py`, `client/tests/e2e/time_blocks/__init__.py`, `client/tests/e2e/time_blocks/test_create_block.py`.
- Modify:
  - `client/src/features/items/create/NewTodoSheet.tsx`: `KindChoice` at the top; block and area render `TimeBlockForm`;
  - `client/src/features/shell/shellUi.ts` and `AppShellLayout.tsx`: `openNewItem(preset)`;
  - `client/src/i18n/translations/{en,he}/index.ts`.

**Interfaces:**

- Consumes:
  - Task 5's routes and `@api-types/timeBlocks.ts`;
  - C2 `subjectOptions(settings)`;
  - `RepeatControl` and `buildRecurrence` (`client/src/features/items/create/recurrence.ts`), limited to the presets `none`, `weekly` and `custom`.
- Produces:
  - `type SpanField = 'start' | 'end' | 'minutes'`;
  - `solveSpan(fields: { start: Date | null; end: Date | null; minutes: number | null }, edited: readonly SpanField[]): { start: Date; end: Date; minutes: number } | null` (`server/src/types/timeSpan.ts`). The third field comes from the two most recently edited (`edited[0]`, `edited[1]`). It returns null when the length isn't positive.
  - `type NewItemKind = 'todo' | 'block' | 'area'`;
  - `interface NewItemPreset { kind: NewItemKind; topicId?: string; start?: Date; end?: Date }`;
  - `ShellUi.openNewItem(preset: NewItemPreset): void`.
  - `blockRequestOf(state: TimeBlockFormState, timeZone: string): CreateTimeBlockRequest | null` (`timeBlockForm.ts`).
  - Hooks: `useCreateTimeBlock(workspaceId)`, `useEditTimeBlock(workspaceId, id)`, `useSkipOccurrence(workspaceId, id)`. Each invalidates the item and block-data queries.
  - The kind labels, as the spec words them:
    - en: "To-do (I'll tick it off)", "Time block (reserve the time)", "Area (paint time for a part of life)";
    - he: "משימה (אסמן כשתסתיים)", "בלוק זמן (שמירת הזמן)", "אזור (צביעת זמן לתחום בחיים)".

- [ ] **Step 1: Write the failing unit tests.**
  - `timeSpan.test.ts`: `start+minutes → end`, `end+minutes → start`, `start+end → minutes`, `non-positive minutes → null`, `the oldest edit is the one recomputed`.
  - `timeBlockForm.test.ts`:
    - `request carries the RRULE for weekly Sun and Tue with UNTIL in UTC`;
    - `title falls back to subject`;
    - `area without title → null`;
    - `topic preset is sent`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/types/timeSpan.test.ts`, then `cd client && node --import tsx --test src/features/items/create/timeBlockForm.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the pure modules, then the components.
  - Subject is a combobox: existing names, or a typed new one.
  - Repeat reuses `RepeatControl` with the presets narrowed, and an end date that defaults to none.
  - The shell preset opens the sheet on that kind with times filled in.
- [ ] **Step 4: Run the unit tests again** (Expect PASS), then the client `lint`, `build` and `test:unit`.
- [ ] **Step 5: Write the e2e** in `test_create_block.py`, with the `fresh_owner` fixture and a dashboard from `create_dashboard`:
  - `test_block_form_computes_the_third_field`;
  - `test_weekly_block_shows_this_week_and_next`: create Sunday 13:00–17:00 weekly, see it in the calendar, click next week, see it again;
  - `test_area_is_the_third_kind`;
  - `test_form_in_hebrew_is_rtl` (`/he/…`, the form has `dir="rtl"`, the three kind labels are in Hebrew).
- [ ] **Step 6: Run the e2e locally** (the commands in Global Constraints) on `tests/e2e/time_blocks/test_create_block.py`. Expect 4 passed. Take the before and after screenshots.
- [ ] **Step 7: Commit:** `git commit -m "Create form: to-do, time block or area; the block form with any two of start, end and length"`

---

### Task 7: Client item sheet for blocks, "this one / all", week-view drag (M–L, ~600 lines)

**Files:**

- Create in `client/src/features/items/scheduled/`: `TimeBlockSection.tsx`, `EditScopeDialog.tsx`, `dragPreset.ts`, `dragPreset.test.ts`.
- Create: `client/tests/e2e/time_blocks/test_edit_block.py`.
- Modify:
  - `client/src/features/items/ItemSheet.tsx`: kind `block` renders `TimeBlockSection`;
  - `client/src/features/items/useItemParam.ts`: `openItem(id: string, occurrence?: Date)`, plus `occurrence: Date | null` read from `?occurrence=<epoch ms>`;
  - `client/src/features/dashboards/variables/urlVars.ts`: `RESERVED_PARAMS` gains `'occurrence'`, and its test is updated;
  - `client/src/features/dashboards/blocks/calendar/CalendarBlock.tsx`:
    - `selectable` for editors on the week grid, not on a phone;
    - `select` → `openNewItem(presetFromSelection(...))`;
    - clicking an occurrence passes `occurrence.originalStart`;
  - `client/src/features/dashboards/blocks/timeline/TimelineBlock.tsx`: a "+" per day → `openNewItem({ kind: 'block', start: day 09:00, end: 10:00 })`.

**Interfaces:**

- Consumes:
  - Task 6 `openNewItem` and the hooks;
  - Task 2 `fromWallString` (FullCalendar's times are wall clock in its `UTC` zone);
  - Task 3 `layerOf`.
- Produces:
  - `presetFromSelection(selection: { startWall: string; endWall: string }, shown: readonly Occurrence[], timeZone: string): NewItemPreset`. The kind is `'block'`. The topic is that of the earliest area (`layerOf(row) === 'area'`) overlapping the selection.

- [ ] **Step 1: Write the failing unit tests** in `dragPreset.test.ts`:
  - `selection becomes instants in the workspace zone`;
  - `inside an area takes its topic`;
  - `outside any area has no topic`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd client && node --import tsx --test src/features/items/scheduled/dragPreset.test.ts src/features/dashboards/variables/urlVars.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The section shows the time, a repeat summary, the subject and the topic, with the actions Edit, Skip this one, and Delete (with confirm).
  - Edit on a repeating block asks `EditScopeDialog` ("This one" / "All") when the time changes. Title, subject and topic always save to the whole series (Ruling 2).
- [ ] **Step 4: Run the unit tests again** (Expect PASS), then the client `lint`, `build` and `test:unit`.
- [ ] **Step 5: Write and run the e2e** in `test_edit_block.py`:
  - `test_this_one_moves_only_that_occurrence`;
  - `test_skip_hides_one_occurrence`;
  - `test_drag_in_week_opens_form_with_time`;
  - `test_drag_inside_area_prefills_its_topic`.

  Seed with `client/tests/helpers/scheduled.py` `create_time_block(api_base_url, user, workspace_id, **fields)`. Expect 4 passed, and take the screenshots.

- [ ] **Step 6: Commit:** `git commit -m "Blocks: item sheet with this one or all, skip and delete; drag in the week to create"`

---

### Task 8: Blocks and areas in the time views (M, ~500 lines)

**Files:**

- Modify:
  - `client/src/features/dashboards/blocks/calendar/calendarEvents.ts`: `CalendarEventProps` gains `kind`, `layer` and `originalStart`;
  - `client/src/features/dashboards/blocks/clock/clockModel.ts`: `ClockModel.areas: { start: Date; end: Date; title: string; topicId: string | null }[]`; areas are not arcs;
  - `client/src/features/dashboards/blocks/agenda/agendaModel.ts`: make sure area and block occurrences reach the agenda rows (expanded, carrying `props.layer`); grouping is the colours plan's `nestInAreas` (no `AgendaModel.sections`).
  - `client/src/features/dashboards/blocks/workload/workloadModel.ts`: areas don't count as busy;
  - `client/src/features/dashboards/blocks/timeline/TimelineBlock.tsx`;
  - `AgendaBlock.tsx`, `ClockBlock.tsx`: pass the model's areas to the C3 primitives.
- Test:
  - `calendarEvents.test.ts`, `clockModel.test.ts`, `agendaModel.test.ts`, `workloadModel.test.ts` (all modify);
  - `client/tests/e2e/time_blocks/test_block_views.py` (create).

**Interfaces:**

- Consumes: C1 `roleOf`, C3 primitives, Task 3 `layerOf`.
- Produces: `ClockModel.areas`, `CalendarEventProps.layer` (the agenda uses C3 `nestInAreas`; no `AgendaModel.sections`). Task 17 adds the conflict and past marks on top.

- [ ] **Step 1: Write the failing unit tests:**
  - `area row becomes a background event with its title` (calendar; through C3's mapping);
  - `clock: area goes to areas, block to arcs`;
  - `agenda: a block inside Studying 13–17 is listed under it`;
  - `workload: area hours are not counted`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd client && node --import tsx --test src/features/dashboards/blocks/calendar/calendarEvents.test.ts src/features/dashboards/blocks/clock/clockModel.test.ts src/features/dashboards/blocks/agenda/agendaModel.test.ts src/features/dashboards/blocks/workload/workloadModel.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement the models.** Wire them to C3's primitives.
- [ ] **Step 4: Run the unit tests again** (Expect PASS), then the client `lint`, `build` and `test:unit`.
- [ ] **Step 5: Write and run the e2e** in `test_block_views.py`:
  - `test_area_draws_behind_events_in_calendar` (the `.fc-bg-event` with the area title);
  - `test_clock_summary_names_the_block`;
  - `test_agenda_groups_blocks_under_area`;
  - `test_blocks_hidden_from_list_block`.

  Expect 4 passed, and take the screenshots (Hebrew on the clock).

- [ ] **Step 6: Commit:** `git commit -m "Time views: areas behind, blocks in their topic's Work shade, agenda grouped under areas"`

---

### Task 9: Travel core, part 1: the day planner and the reconciler (L, ~800 lines with tests)

**Files:**

- Modify: `server/src/types/travel.ts`. Add:
  - `RULE_DIRECTIONS = ['there', 'back', 'both']`;
  - `interface TravelSettings`, `DEFAULT_TRAVEL_SETTINGS`, `TravelSettingsSchema` (zod);
  - `TRAVEL_HORIZON_DAYS = 14`, `ROUTING_CALLS_PER_DAY = 100`, `PLACE_MATCH_RADIUS_M = 300`;
  - `STRAIGHT_LINE = { walk: { kmh: 4.5, detour: 1.3 }, drive: { kmh: 40, detour: 1 }, transit: { kmh: 25, detour: 1.3 } }`.
- Create in `server/src/classes/travel/`: `LegKey.ts`, `DayPlanner.ts`, `LegReconciler.ts`, `LegKey.test.ts`, `DayPlanner.test.ts`, `LegReconciler.test.ts`.

**Interfaces:**

- Produces (all pure, no I/O):
  - `TravelSettings { factors: Record<TravelMode, number>; buffers: Record<TravelMode, number>; goHome: { enabled: boolean; minWindowMinutes: number; minAtHomeMinutes: number }; defaultMode: TravelMode }`.
  - `DEFAULT_TRAVEL_SETTINGS = { factors: { walk: 1, drive: 1.15, transit: 1 }, buffers: { walk: 0, drive: 10, transit: 5 }, goHome: { enabled: false, minWindowMinutes: 180, minAtHomeMinutes: 60 }, defaultMode: 'transit' }`.
  - The schema's bounds: factor 0.5–3, buffer 0–120 minutes, `minWindowMinutes` ≥ 180, `minAtHomeMinutes` ≥ 60.
  - `class LegKey`:
    - `static of(p: { ownerUserId: string; anchorItemId: string; occurrence: string; direction: TravelDirection }): LegKey`;
    - `static parse(text: string): LegKey`;
    - `get anchorKey(): string` (`anchorItemId|occurrence`);
    - `toString()`, `equals(other)`.
  - `interface Anchor { itemId: string; occurrence: string; title: string; topicId: string | null; start: Date; end: Date; placeId: string | null; mode: TravelMode; there: boolean; back: boolean }`.
  - `interface DayPlanInput { ownerUserId: string; day: string; timeZone: string; now: Date; homeId: string | null; settings: TravelSettings; anchors: readonly Anchor[] }`.
  - `type TripKey = string` (`from|to|mode`); `interface Estimate { minutes: number; source: 'ors' | 'remembered' | 'estimate' }`.
  - `interface PlannedLeg { key: LegKey; anchorStart: Date; fromPlaceId: string; toPlaceId: string; mode: TravelMode; startAt: Date; endAt: Date; minutes: number; source: Estimate['source']; conflict: boolean; past: boolean; topicId: string | null; title: string }`.
  - `class DayPlanner`:
    - `static tripKey(from: string, to: string, mode: TravelMode): TripKey`;
    - `static trips(input: DayPlanInput): TripKey[]`;
    - `static plan(input: DayPlanInput, estimates: ReadonlyMap<TripKey, Estimate>): PlannedLeg[]`.
  - `type AnchorFate = 'present' | 'cancelled' | 'moved' | 'no_longer_matches' | 'no_place'`.
  - `interface StoredLegFacts { id: string; key: string; startAt: Date; anchorStart: Date; edited: boolean; removedReason: RemovalReason | null }`.
  - `interface Reconciliation { create: PlannedLeg[]; update: { id: string; leg: PlannedLeg; keepTimes: boolean; anchorMoved: boolean; restore: boolean }[]; remove: { id: string; reason: RemovalReason }[] }`.
  - `class LegReconciler`: `static reconcile(stored: readonly StoredLegFacts[], planned: readonly PlannedLeg[], fates: ReadonlyMap<string, AnchorFate>, now: Date): Reconciliation`.
  - Leg titles (English templates, Ruling 19): `Bus to {to}`, `Drive to {to}`, `Walk to {to}`; to Home: `Bus home`, `Drive home`, `Walk home`.

**The DayPlanner algorithm** (the tests below pin its outputs; the outline pins the choices they don't):

```text
plan(input, est):
  if homeId is null → []
  [dayStart, dayEnd) = zonedTime(day 00:00) .. zonedTime(next day 00:00)   (23 h or 25 h on DST days)
  A = anchors with placeId ≠ null and dayStart ≤ start < dayEnd, sorted by (start, end, itemId, occurrence)
  stays = fold A: same placeId as the open stay → extend it (end = max), else open a new stay
  if settings.goHome.enabled: for each stay not at Home, each gap g between consecutive anchors a, b in it:
      need = L(place→Home, a.mode) + L(Home→place, b.mode)
      if g ≥ minWindowMinutes and g − need ≥ minAtHomeMinutes → split the stay at the gap, with a virtual Home stay between
  first stay, if not at Home and its first anchor has `there` → leg 'there' Home→stay, arriveBy stay.start, mode = that anchor's mode
  each consecutive pair (p, n) with different places:
      n virtual Home → 'back' p→Home, anchor = p's last anchor, departAt p.end, mode = p's last anchor's mode
      p virtual Home → 'there' Home→n, anchor = n's first anchor, arriveBy n.start, mode = n's first anchor's mode
      otherwise      → 'between' p→n, anchor = n's first anchor (the destination decides the mode), departAt p.end, arriveBy n.start
  last stay, if not at Home and its last anchor has `back` → leg 'back' stay→Home, departAt stay.end
  times, L = est[tripKey].minutes:
      there: [arriveBy − L, arriveBy];  back: [departAt, departAt + L]
      between: arriveBy − L ≥ departAt ? [arriveBy − L, arriveBy] : [departAt, departAt + L] with conflict = true
  past = startAt < now; topicId = the anchor's topic; occurrence and anchorStart come from the anchor
trips(input) = every trip the legs above can ask for, plus both go-home trips of each gap ≥ minWindowMinutes
```

**The reconciler's rules:**

- A planned leg with no stored leg is created, unless it is `past`.
- A planned leg with a stored live leg is updated:
  - `keepTimes = stored.edited`;
  - `anchorMoved = stored.edited && stored.anchorStart ≠ leg.anchorStart`.
- A planned leg with a stored tombstone is restored, unless the tombstone's reason is `skipped` or the leg is `past`.
- A stored live leg that is not planned and not past is removed. Its reason comes from the fate of its `anchorKey`:
  - `present` → `replaced`;
  - `cancelled`, `moved`, `no_longer_matches` and `no_place` keep their own name;
  - a missing fate → `cancelled`.

- [ ] **Step 1: Write the failing tests.**
  - `DayPlanner.test.ts`:
    - `lectures 10–12 and 14–16 at Braude: one stay, legs there and back only`;
    - `Braude then TLVTech: between leg drives (destination mode)`;
    - `there/back flags control only the day's first and last legs`;
    - `go-home: a 4 h window splits when ≥ 60 min remain at home; a 3 h window with 2×70 min travel does not`;
    - `conflict: A ends 12:00, B starts 12:15, 40 min → [12:00, 12:40], conflict true`;
    - `anchor at 23:30 ending 00:45: back leg starts 00:45 next day, belongs to this day`;
    - `leg on the DST end day keeps wall-clock arrival` (2026-10-25: 13:00 local, 40 min → 12:20 local) — **Review Focus 2**;
    - `repeating occurrences carry their originalStart in the key`;
    - `no Home → no legs`;
    - `anchor without place → no leg`;
    - `trips() lists what plan() reads`.
  - `LegReconciler.test.ts`:
    - `create`;
    - `update keeps edited times and flags anchorMoved`;
    - `skipped tombstone is never restored`;
    - `cancelled anchor removes with reason cancelled`;
    - `past legs are left alone`;
    - `running reconcile twice on its own output changes nothing`.
  - `LegKey.test.ts`: round trip; the owner is part of the key.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/classes/travel/DayPlanner.test.ts src/classes/travel/LegReconciler.test.ts src/classes/travel/LegKey.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement**, using Task 2's `zonedTime`.
- [ ] **Step 4: Run the tests again.** Expect PASS.
- [ ] **Step 5: Commit:** `git commit -m "Travel: the day planner and the leg reconciler (pure)"`

---

### Task 10: Travel core, part 2: routes, links, geocoding, place matching (M, ~600 lines)

**Files:**

- Create in `server/src/classes/travel/routing/`: `RouteProvider.ts`, `StraightLine.ts`, `RememberedLength.ts`, `OpenRouteService.ts`, `RouteChain.ts`, `routing.test.ts`.
- Create in `server/src/classes/travel/`: `TravelLinks.ts`, `TravelLinks.test.ts`, `geo.ts`, `PlaceMatcher.ts`, `PlaceMatcher.test.ts`.
- Create in `server/src/classes/travel/geocoding/`: `Geocoder.ts`, `OrsGeocoder.ts`, `NominatimGeocoder.ts`, `geocoding.test.ts`.
- Create: `server/src/classes/travel/travelHttp.ts` (`travelClient(provider: 'openrouteservice' | 'nominatim'): ReadOnlyClient`).
- Modify:
  - `server/src/services/appSecrets.ts`: `openrouteservice: { required: { apiKey: 'OPENROUTESERVICE_API_KEY' } }`;
  - `server/src/config/testSwitches.ts`: `setTravelTransportForTests(transport: Transport | null)` and `travelTransportForTests()`.

**Interfaces:**

- Consumes: Task 9 `Estimate`, `TripKey`, `TravelSettings`, `STRAIGHT_LINE`; `createReadOnlyClient` and `liveTransport`.
- Produces:
  - `interface LatLon { lat: number; lon: number }`; `interface RoutePlace extends LatLon { id: string }`; `interface Trip { from: RoutePlace; to: RoutePlace; mode: TravelMode }`.
  - `interface RouteProvider { readonly modes: readonly TravelMode[]; estimate(trip: Trip): Promise<Estimate | null> }`.
  - `interface RoutingBudget { cachedSeconds(key: TripKey): Promise<number | null>; rememberSeconds(key: TripKey, seconds: number): Promise<void>; reserve(): Promise<boolean> }`. Task 11's `RoutingQuota` implements it.
  - `class StraightLine implements RouteProvider` (`constructor(settings: TravelSettings)`): all modes, `minutes = ceil(km × detour / kmh × 60 × factor) + buffer`, source `estimate`.
  - `class RememberedLength implements RouteProvider` (`constructor(lookup: (fromId: string, toId: string, mode: TravelMode) => number | null)`): all modes, source `remembered`.
  - `class OpenRouteService implements RouteProvider` (`constructor(deps: { apiKey: string; client: ReadOnlyClient; budget: RoutingBudget; settings: TravelSettings })`):
    - modes `walk` (`foot-walking`) and `drive` (`driving-car`);
    - `GET https://api.openrouteservice.org/v2/directions/{profile}?start={lon},{lat}&end={lon},{lat}` with header `Authorization: <key>`, reading `features[0].properties.summary.duration` in seconds;
    - the budget's cache first, then `reserve()`;
    - any failure → null;
    - `minutes = ceil(sec / 60 × factor) + buffer`, source `ors`.
  - `class RouteChain implements RouteProvider` (`constructor(providers: readonly RouteProvider[])`): the first non-null answer among the providers that take the mode.
  - `class TravelLinks`: `static for(leg: { mode: TravelMode; from: LatLon | null; to: LatLon | null; arriveBy: Date }): TravelLink[]`. `TravelLink = { app: 'google_maps' | 'waze' | 'moovit'; url: string; fallbackUrl?: string }` lives in `server/src/types/travel.ts`, since the client reads it.
    - `walk`: Google Maps `https://www.google.com/maps/dir/?api=1&origin=LAT,LON&destination=LAT,LON&travelmode=walking`.
    - `drive`: Waze `https://waze.com/ul?ll=LAT,LON&navigate=yes`, then Google Maps with `travelmode=driving`.
    - `transit`:
      - Moovit `moovit://directions?orig_lat=…&orig_lon=…&dest_lat=…&dest_lon=…&date=<arriveBy ISO>&auto_run=true`, with `fallbackUrl` = `https://moovitapp.com/` (check the link with one HEAD request before committing);
      - then Google Maps with `travelmode=transit`.
    - No `from`: Waze is unaffected; Google Maps leaves out `origin`.
    - No `to`: no links.
  - `interface Geocoder { geocode(text: string): Promise<LatLon | null> }`:
    - `OrsGeocoder`: `GET https://api.openrouteservice.org/geocode/search?text=…&size=1` with the `Authorization` header.
    - `NominatimGeocoder`: `GET https://nominatim.openstreetmap.org/search?q=…&format=jsonv2&limit=1`, with `User-Agent: TodoList/1.0 (+https://${environment.domainName})`, through a `ReadOnlyClient` with `minIntervalMs: 1100`.
    - `parseCoordinates(text: string): LatLon | null` accepts `"lat, lon"` (Ruling 14).
  - In `geo.ts`: `distanceMeters(a: LatLon, b: LatLon): number` (haversine) and `nearestWithin<T extends LatLon>(point: LatLon, places: readonly T[], radiusM: number): T | null`.
  - `class PlaceMatcher`:
    - `static normalize(text: string): string`: NFKC, lower case, `״` → `"`, `׳` → `'`, punctuation except quotes removed, spaces collapsed;
    - `static byName<T extends { name: string; aliases: readonly string[] }>(location: string, places: readonly T[]): T | null`: the normalized location contains a normalized name or alias, longest match first.
- Errors never carry a URL, an address or coordinates: `ProviderHttpError` already carries none.

- [ ] **Step 1: Write the failing tests** (fake `Transport`, no network):
  - `routing.test.ts`:
    - `ORS answer becomes minutes × factor + buffer`;
    - `chain falls back when ORS fails or quota is spent` (→ `remembered`, then `estimate`) — **Review Focus 5**;
    - `no key → chain without ORS`;
    - `same trip twice in a day calls ORS once` (budget cache);
    - `transit never calls ORS`.
  - `TravelLinks.test.ts`: the three modes' exact URLs; no links without `to`.
  - `geocoding.test.ts`:
    - `"32.91, 35.29" needs no lookup`;
    - `Nominatim spacing ≥ 1.1 s between calls (fake clock)`;
    - `not found → null`.
  - `PlaceMatcher.test.ts`:
    - `"ORT Braude, room 101" matches alias`;
    - `"מכללת בראודה" matches alias בראודה`;
    - `חדו״א and חדו"א normalize alike`;
    - `nearest within 300 m wins, 301 m does not`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/classes/travel/routing/routing.test.ts src/classes/travel/TravelLinks.test.ts src/classes/travel/geocoding/geocoding.test.ts src/classes/travel/PlaceMatcher.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again** (Expect PASS), then `cd server && npm run lint && npm run build`.
- [ ] **Step 5: Commit:** `git commit -m "Travel: OpenRouteService, remembered and straight-line lengths, app links, free geocoding"`

---

### Task 11: Travel storage: places, rules, profile, quota, legs (L, ~800 lines)

**Files:**

- Create in `server/src/models/definitions/`, each with its `models/mongoose/` twin:
  - `Place.ts` (`PLACE_TABLE_NAME = 'Places'`);
  - `TravelRule.ts` (`'TravelRules'`);
  - `TravelProfile.ts` (`'TravelProfiles'`);
  - `RoutingQuota.ts` (`'RoutingQuotas'`, TTL as in `CreateQuota`).
- Modify: `server/src/models/index.ts` (four `mongoOnly` getters).
- Modify the Item repository (`server/src/models/definitions/Item.ts`, `models/mongoose/Item.ts`):
  - methods `upsertTravelLeg`, `listTravelLegs`, `removeTravelLeg`;
  - unique index `{ workspaceId: 1, 'props.travelKey': 1 }` with `partialFilterExpression: { 'props.travelKey': { $type: 'string' } }`.
- Create in `server/src/classes/travel/`: `Place.ts`, `TravelRule.ts`, `TravelProfile.ts`, `RoutingQuota.ts`, `TravelData.ts`, `index.ts`, `storage.test.ts`, `TravelLeg.test.ts`.
- Modify:
  - `server/src/classes/item/TravelLeg.ts` (the mutations);
  - `server/src/classes/index.ts` (export travel);
  - `server/src/classes/workspace/Member.ts` (`endMembership` → `TravelData.forgetMember`);
  - `server/src/classes/workspace/cascade.ts` (→ `TravelData.forgetWorkspace`);
  - `server/src/types/limits.ts` (`placesPerMember: 30`, `travelRulesPerMember: 50`);
  - `errorCodes.ts` (`place_not_found`, `travel_home_missing`, `travel_limit`), plus the client errors file and the en/he i18n errors.

**Interfaces:**

- Consumes: Tasks 9 and 10, and Task 6's `solveSpan`.
- Shared with the client, in `server/src/types/travel.ts`: `TravelRuleScope`, `PlaceView` and `PlaceAgentView`.
- Produces, as data:
  - `PlaceData { id; workspaceId; ownerUserId; name; aliases: string[]; address: string | null; lat: number; lon: number; home: boolean; createdAt; updatedAt }`;
  - `TravelRuleScope = { kind: 'where'; where: RuleGroup } | { kind: 'series'; itemId: string } | { kind: 'item'; itemId: string; occurrence: string }`;
  - `TravelRuleData { id; workspaceId; ownerUserId; scope: TravelRuleScope; mode: TravelMode; direction: RuleDirection; placeId: string | null; createdAt; updatedAt }`;
  - `TravelProfileData`:
    - `id`: `${workspaceId}|${userId}`; `workspaceId`; `ownerUserId`;
    - `settings: TravelSettings`;
    - `remembered: Record<TripKey, number>` (minutes);
    - `geocodes: Record<string, LatLon | null>` (key: sha256 of the normalized text; at most 500 entries, oldest dropped);
    - `itemPlaces: Record<string, string>`, `containerPlaces: Record<string, string>`;
    - `hasTravel: boolean`, `lastPassDay: string | null`, `updatedAt`.
  - `RoutingQuota` document: `{ _id: '<workspaceId>|<YYYY-MM-DD>', count, routes: Record<TripKey, number /* seconds */>, expireAt }`.
- Produces, as classes:
  - `class Place extends WorkspaceEntity<PlaceData> implements Owned, Viewable<PlaceView>`:
    - `static listOwn(caller): Promise<Place[]>`;
    - `static create(caller, input: NewPlace): Promise<Place>`. `NewPlace = { name: string; address?: string; coords?: LatLon; aliases?: string[]; home?: boolean }`. It geocodes `address` through `parseCoordinates`, then the geocoder chain; nothing found → `AppError(400, 'address: not found', { code: 'place_not_found' })`.
    - `update(caller, patch: Partial<NewPlace>)`, `remove(caller)`;
    - `static homeOf(caller): Promise<Place | null>`; setting a new Home clears the old one;
    - `toView(): PlaceView` (`{ id, name, aliases, home, address }`, REST and owner only);
    - `toAgentView(): PlaceAgentView` (`{ id, name, aliases, home }`).
  - `class TravelRule extends WorkspaceEntity<TravelRuleData> implements Owned, Auditable`:
    - `static listOwn(caller)`;
    - `static create(caller, input: NewTravelRule)`. It checks `where` with `parseQuery({ source: 'items', where })` and maps a `QueryValidationError` to 400.
    - `update`, `remove`. Each audits `travel_rule.create`, `.update` or `.delete` with meta `{ mode, direction, scopeKind }`.
    - `NewTravelRule = { scope: TravelRuleScope; mode: TravelMode; direction: RuleDirection; placeId?: string | null }`.
  - `class TravelProfile extends WorkspaceEntity<TravelProfileData> implements Owned`:
    - `static of(caller): Promise<TravelProfile>` (made on first read);
    - `static listWithTravel(): Promise<{ workspaceId: string; userId: string; lastPassDay: string | null }[]>` (global, for the pass);
    - `settings`, `updateSettings(caller, patch)`;
    - `rememberedMinutes(key: TripKey): number | null`, `remember(caller, key, minutes)`;
    - `pinItemPlace(caller, itemId, placeId | null)`, `setContainerPlace(caller, containerId, placeId | null)`;
    - `cachedGeocode(text)`, `storeGeocode(text, result)`, `markPassed(day)`.
  - `class RoutingQuota implements RoutingBudget`: `static for(workspaceId: string, day: string): RoutingQuota`.
  - `TravelLeg`:
    - `static applyPlan(caller: Caller, recon: Reconciliation, now: Date): Promise<{ created: number; updated: number; removed: number }>`;
    - `static storedFacts(caller, from: Date, to: Date): Promise<StoredLegFacts[]>`;
    - `editTimes(caller, change: { startAt?: Date; endAt?: Date; minutes?: number }): Promise<TravelLeg>`: through `solveSpan`; sets `edited` and source `manual`; with both places, `TravelProfile.remember`;
    - `skip(caller)` (a tombstone with reason `skipped`), `reset(caller)` (clears `edited`, `anchorMoved` and the skip; the next regeneration recomputes);
    - `edit(caller, edit)` → `editTimes` for start and end, 400 for anything else;
    - `static listDays(caller, from: Date, to: Date): Promise<{ live: TravelLeg[]; removed: TravelLeg[] }>`.
  - Leg writes:
    - `kind: 'travel'`, `visibility: 'private'`, `ownerUserId` = the member, `topicId` = the anchor's;
    - `title` from Task 9's templates;
    - `props: { travel: TravelLegProps, travelKey: key.toString() }`.
  - `class TravelData`: `static forgetMember(workspaceId, userId): Promise<void>` and `static forgetWorkspace(workspaceId): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (memory DB).
  - `storage.test.ts`:
    - `one Home per member`;
    - `place cap 30 → 409 travel_limit`;
    - `coords typed as text skip the geocoder`;
    - `unknown address → 400 place_not_found` (fake geocoder);
    - `rule with an invalid where → 400`;
    - `rule audit meta has no place, address or coordinates`;
    - `quota reserves 100 then refuses`;
    - `profile defaults equal DEFAULT_TRAVEL_SETTINGS`;
    - `forgetMember removes places, rules, profile and soft-deletes legs`.
  - `TravelLeg.test.ts`:
    - `applyPlan creates, updates, tombstones by key`;
    - `two owners, one anchor: two legs` — **Review Focus 3**;
    - `editTimes any two, remembers the trip`;
    - `skip then regeneration keeps it skipped`;
    - `reset restores`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/classes/travel/storage.test.ts src/classes/travel/TravelLeg.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the repositories, classes and cleanup hooks.
- [ ] **Step 4: Run the tests again** (Expect PASS), then the full server `npm run test:unit`. `classBoundary.test.ts` must stay green.
- [ ] **Step 5: Commit:** `git commit -m "Travel: places, rules, profile, routing quota and leg storage through classes"`

---

### Task 12: Travel generation, triggers and the daily pass (L, ~800 lines)

**Files:**

- Create:
  - in `server/src/classes/travel/`: `TravelAnchors.ts`, `TravelPlanner.ts`, `TravelAnchors.test.ts`, `TravelPlanner.test.ts`, `readOnly.test.ts`;
  - `server/src/classes/item/ItemChanges.ts`, `server/src/classes/item/ItemChanges.test.ts`;
  - `server/src/jobs/TravelHorizonPass.ts`, `server/src/jobs/TravelHorizonPass.test.ts`.
- Modify:
  - `server/src/classes/item/ItemQuery.ts`: `runDraft`;
  - `server/src/classes/item/Todo.ts` and `TimeBlock.ts`: `ItemChanges.notify` after create, update and delete;
  - `server/src/classes/travel/index.ts`: subscribes `TravelPlanner.onItemChange`;
  - `server/src/sync/worker.ts`: after a run that isn't `failed`, and after a gcal run, `await TravelPlanner.afterSync(job.integrationId)` in try/catch with a log;
  - `server/src/sync/worker.test.ts`;
  - C4: add `new TravelHorizonPass()` to `AFTER_DISPATCH_PASSES`.

**Interfaces:**

- Consumes: Tasks 2, 9, 10 and 11; Task 4 (time-shaped drafts with `blockType: 'calendar'`); C4.
- Produces:
  - `ItemQuery#runDraft(draft: Query, options: { now: Date; blockType?: BlockType }): Promise<QueryResult>`: the caller's access, `ws` from `caller.context`, the workspace's attributes, no connectors, no vars. It matches `runWorkspaceQuery`'s context minus the request parts.
  - `class ItemChanges`:
    - `static subscribe(listener: (caller: Caller, change: { itemId: string; kind: ItemKind }) => Promise<void>): void`;
    - `static notify(caller, change): Promise<void>`: awaits every listener and logs and swallows their errors.
  - `class TravelAnchors`: `static gather(caller: Caller, input: { profile: TravelProfile; rules: readonly TravelRule[]; places: readonly Place[]; range: Range; now: Date; geocoder: Geocoder }): Promise<{ anchors: Anchor[]; fates: Map<string, AnchorFate> }>`.
    - Rows come from `runDraft`, with `blockType: 'calendar'`, `startAt` not null, `kind ≠ travel`, the horizon range and `limit: 1000`.
    - Expanded; all-day and due-only occurrences are dropped.
    - Each where-rule runs its own `runDraft`, ANDed with the range.
    - Precedence: item, then series, then where (Ruling 11).
    - Place, in order:
      1. `itemPlaces` pin;
      2. a rule's `placeId`;
      3. `PlaceMatcher.byName(props.location)`;
      4. a cached or new geocode (at most 10 new) and `nearestWithin(PLACE_MATCH_RADIUS_M)`;
      5. `containerPlaces`.
    - The anchor id is `occurrence.seriesRowId ?? row.id`.
  - `class TravelPlanner`:
    - `static regenerate(caller: Caller, now?: Date): Promise<{ created: number; updated: number; removed: number }>`: the whole horizon, `[startOfZonedDay(now), +14 days)`. It runs gather, `DayPlanner.trips` and `plan` per day, estimates through `RouteChain([ORS?, RememberedLength, StraightLine])`, then `LegReconciler.reconcile` and `TravelLeg.applyPlan`.
    - `static regenerateFor(workspaceId: string, userId: string, now?: Date)`: `Caller.enter` as a system actor. A former member → `TravelData.forgetMember`.
    - `static onItemChange(caller, change)`: regenerate when `TravelProfile.hasTravel`.
    - `static afterSync(integrationId: string, now?: Date)`: every member with travel in that workspace.
    - `static runDailyPass(now: Date, budget: TimeBudget): Promise<{ done: number; left: number }>`: members whose `lastPassDay` isn't today in the workspace zone; it stops when `!budget.canStart()`.
  - `jobs/TravelHorizonPass.ts`: `export class TravelHorizonPass implements AfterDispatchPass { readonly name = 'travel-pass'; run(now) { return TravelPlanner.runDailyPass(now, TimeBudget.start(120_000)); } }` (returns counts).

- [ ] **Step 1: Write the failing tests** (memory DB, fake routing transport).
  - `TravelAnchors.test.ts`:
    - `where-rule "calendar braude" matches lectures, series expanded`;
    - `item rule beats series beats where`;
    - `pin > rule place > alias > geocode within 300 m > container place`;
    - `all-day and due-only never anchor`;
    - `a moved Google occurrence anchors on its master with the original start`.
  - `TravelPlanner.test.ts`:
    - `regenerate twice changes nothing`;
    - `cancelled occurrence removes its legs with reason cancelled`;
    - `all-edit of an anchor series reconciles its legs` — **Review Focus 4**;
    - `edited leg keeps times and is flagged when its anchor moves`;
    - `no ORS key still makes legs labelled estimate`;
    - `a to-do with travel edited → its legs move (ItemChanges)`.
  - `readOnly.test.ts`:
    - `regeneration writes only travel items of the member`: anchor docs are byte-equal before and after; no provider write path is called (spy on `Integration` write methods); the outbound guard sees only the fake ORS host.
  - `TravelHorizonPass.test.ts`:
    - `runs once per member per local day`;
    - `stops at the budget and resumes next tick`.
  - `worker.test.ts`:
    - `a sync that changed items triggers travel; a travel failure never fails the job`.
  - `ItemChanges.test.ts`:
    - `importing classes/index.js subscribes travel`;
    - `a throwing listener does not fail the write`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/classes/travel/TravelAnchors.test.ts src/classes/travel/TravelPlanner.test.ts src/classes/travel/readOnly.test.ts src/jobs/TravelHorizonPass.test.ts src/sync/worker.test.ts src/classes/item/ItemChanges.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again** (Expect PASS), then the full server `npm run test:unit` and `npm run build`.
- [ ] **Step 5: Commit:** `git commit -m "Travel: the 14-day plan, regenerated on item changes, after syncs and once a day from the hourly tick"`

---

### Task 13: Travel REST API and its privacy tests (L, ~750 lines)

**Files:**

- Create:
  - `server/src/services/travelSchemas.ts`;
  - `server/src/controllers/travel.ts`, `server/src/routes/private/travel.ts`;
  - `server/src/routes/private/travel.http.test.ts`, `server/src/routes/private/travel.privacy.http.test.ts`.
- Modify:
  - `server/src/types/travel.ts` (request and response types);
  - `server/src/controllers/index.ts`, `server/src/routes/private/index.ts`;
  - `server/src/classes/travel/TravelRule.ts` (`markItem`, `unmarkItem`);
  - `server/src/classes/travel/TravelPlanner.ts` (`preview`);
  - `server/src/services/itemSchemas.ts` and `server/src/classes/item/Todo.ts`: `CreateItemBody` and `NewTodo` take optional `startAt` and `endAt` (a to-do needs a start for travel).

**Interfaces:**

- Consumes: Tasks 11 and 12.
- Produces, in `server/src/types/travel.ts` (shared): `TravelRuleView`, `MarkItemRequest`, `MarkItemResponse`, `TravelSettingsResponse`, `TravelPreviewRequest`, `TravelPreviewResponse`, `LegEditRequest`, `TravelDaysResponse`, `SpanInput`.
- Produces:
  - `TravelRule.markItem(caller, input: { itemId: string; occurrence?: Date; every: boolean; mode: TravelMode; direction: RuleDirection; placeId?: string | null; there?: SpanInput; back?: SpanInput }): Promise<{ rule: TravelRule; legs: TravelLeg[] }>`.
    - No Home → 409 `travel_home_missing`.
    - `every` makes a `series` rule; otherwise an `item` rule for that occurrence, or `single`.
    - It regenerates, then applies `there` and `back` as hand edits.
    - `SpanInput = { startAt?: string; endAt?: string; minutes?: number; fromPlaceId?: string | null }`.
  - `TravelPlanner.preview(caller, input: { mode: TravelMode; fromPlaceId?: string; toPlaceId?: string; arriveBy?: Date; departAt?: Date }): Promise<{ minutes: number | null; source: LegSource | null; startAt: string | null; endAt: string | null }>`.
- Routes, all under `/api/private/workspaces/:wid/travel` with `requireWorkspace('editor')`, all scoped to the caller's own data:

  | Method and path                            | Body                                           | Answer                                                                                   |
  | ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | `GET /places`                              |                                                | `PlaceView[]`                                                                            |
  | `POST /places`                             | `{ name, address?, coords?, aliases?, home? }` | 201 `PlaceView`                                                                          |
  | `PATCH /places/:id`                        | partial                                        | `PlaceView`                                                                              |
  | `DELETE /places/:id`                       |                                                | 204                                                                                      |
  | `GET /rules`                               |                                                | `TravelRuleView[]`                                                                       |
  | `POST /rules`                              | `{ scope, mode, direction, placeId? }`         | 201                                                                                      |
  | `PATCH /rules/:id`                         | partial                                        | `TravelRuleView`                                                                         |
  | `DELETE /rules/:id`                        |                                                | 204                                                                                      |
  | `GET /settings`                            |                                                | `{ settings, containerPlaces: { containerId, placeId }[], orsAvailable: boolean }`       |
  | `PATCH /settings`                          | partial `TravelSettings`                       | same as `GET /settings`                                                                  |
  | `PUT /container-places/:containerId`       | `{ placeId: string \| null }`                  | 204                                                                                      |
  | `PUT /item-places/:itemId`                 | `{ placeId: string \| null }`                  | 204                                                                                      |
  | `POST /items/:itemId`                      | `markItem` input                               | `{ rule: TravelRuleView, legs: ItemDetail[] }`                                           |
  | `DELETE /items/:itemId?occurrence=&every=` |                                                | 204                                                                                      |
  | `POST /preview`                            | `preview` input                                | the `preview` answer                                                                     |
  | `PATCH /legs/:id`                          | `{ startAt?, endAt?, minutes? }`               | `ItemDetail`                                                                             |
  | `POST /legs/:id/skip`                      |                                                | 204                                                                                      |
  | `POST /legs/:id/reset`                     |                                                | `ItemDetail`                                                                             |
  | `GET /legs/:id/links`                      |                                                | `{ links: TravelLink[] }`                                                                |
  | `GET /days?from=YYYY-MM-DD&to=YYYY-MM-DD`  | at most 14 days                                | `{ days: { date, legs: ItemSummary[], removed: { id, title, reason, removedAt }[] }[] }` |

  `orsAvailable` is whether the key is set.

- [ ] **Step 1: Write the failing tests.**
  - `travel.http.test.ts`:
    - the role matrix: viewer 403, editor 200;
    - strict bodies → 400;
    - `unknown address is 400 place_not_found` — **Review Focus 5**;
    - `mark item without Home → 409 travel_home_missing`;
    - `mark a series every occurrence → series rule and legs on each occurrence in 14 days`;
    - `leg PATCH any two`;
    - `skip then GET /days lists it under removed with reason skipped`;
    - `links for a transit leg include moovit`;
    - `POST /items (to-do) accepts startAt and endAt`.
  - `travel.privacy.http.test.ts` (members A and B, editors in one workspace):
    - `member B never reads A's legs or places`, through all of: `/travel/places`, `/items`, `/query` (calendar draft), `/items/:legId` (404), `/travel/legs/:id/links` (404) and `/travel/days` — **Review Focus 3**;
    - `audit rows contain neither A's address nor coordinates` (scan every `AuditLog` row's JSON for the address string and for `32.9` and `35.2`);
    - `leg title uses place names only`;
    - `a geocoder failure logs no address` (capture `logger`).
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/routes/private/travel.http.test.ts src/routes/private/travel.privacy.http.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the thin controllers over Task 11 and 12 classes, and the zod schemas.
- [ ] **Step 4: Run the tests again** (Expect PASS), then the full server `npm run test:unit`.
- [ ] **Step 5: Commit:** `git commit -m "Travel: REST API for places, rules, settings, marking items and legs, private to the member"`

---

### Task 14: Travel MCP tools and their privacy tests (M, ~600 lines)

**Files:**

- Create in `server/src/mcp/tools/items/`: `travelPlaces.ts`, `travelRules.ts`, `travelSettings.ts`, `travelMark.ts`, `travelLegs.ts`.
- Create in `server/src/mcp/__tests__/`: `travelTools.test.ts`, `travelPrivacy.test.ts`.
- Modify:
  - `server/src/mcp/tools/items/index.ts`;
  - `server/src/mcp/__tests__/contract.test.ts` and `roleMatrix.test.ts`;
  - `server/src/mcp/tools/itemViews.ts`: travel props in views keep names only. Task 11 already stores names only; assert it.

**Interfaces:**

- Consumes: Tasks 11–13 class methods.
- Produces these tools, all `minRole: 'editor'`:

  | Tool                  | Scope         | Kind                   | Input                                                                                                                                     | Output                              |
  | --------------------- | ------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
  | `travel_list_places`  | `read`        | read-only              |                                                                                                                                           | `{ places: PlaceAgentView[] }`      |
  | `travel_set_place`    | `items:write` | `openWorldHint: true`  | `{ id?, name, address?, lat?, lon?, aliases?, home? }`                                                                                    | `{ place: PlaceAgentView }`         |
  | `travel_remove_place` | `items:write` | destructive, `confirm` | `{ id }`                                                                                                                                  |                                     |
  | `travel_list_rules`   | `read`        |                        |                                                                                                                                           | rules                               |
  | `travel_set_rule`     | `items:write` |                        | `{ id?, where?, seriesItemId?, itemId?, occurrenceStart?, mode, direction, place? }` (exactly one scope; `place` is a saved place's name) | the rule                            |
  | `travel_remove_rule`  | `items:write` | destructive            | `{ id }`                                                                                                                                  |                                     |
  | `travel_get_settings` | `read`        |                        |                                                                                                                                           | settings                            |
  | `travel_set_settings` | `items:write` |                        | partial settings                                                                                                                          | settings                            |
  | `travel_mark_item`    | `items:write` |                        | `{ itemId, occurrenceStart?, every?: boolean, mode, direction, place?, minutes? }`                                                        | `{ rule, legs: ItemSummaryView[] }` |
  | `travel_edit_leg`     | `items:write` |                        | `{ legId, startAt?, endAt?, minutes? }`                                                                                                   | the leg                             |
  | `travel_skip_leg`     | `items:write` |                        | `{ legId }`                                                                                                                               |                                     |
  | `travel_reset_leg`    | `items:write` |                        | `{ legId }`                                                                                                                               |                                     |
  - Every description says that addresses and coordinates are accepted but never returned.
  - Add the rows to `contract.test.ts` after the time block tools.

- [ ] **Step 1: Write the failing tests.**
  - `travelTools.test.ts`:
    - `set Home by coordinates, a rule on a calendar, mark a series → legs listed by get_calendar as busy`;
    - `rough minutes give a remembered length`;
    - `remove needs confirm`.
  - `travelPrivacy.test.ts`:
    - `no tool output carries an address or coordinates`: serialize every output of the travel tools, plus `get_item`, `get_calendar` and `list_today` for a leg, and assert that neither the address nor the lat/lon digits appear;
    - `B's key lists no places of A and cannot get A's leg`.
- [ ] **Step 2: Run them to verify they fail.** Run `cd server && node --import tsx --test src/mcp/__tests__/travelTools.test.ts src/mcp/__tests__/travelPrivacy.test.ts src/mcp/__tests__/contract.test.ts src/mcp/__tests__/roleMatrix.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again** (Expect PASS), then the full server `npm run test:unit`.
- [ ] **Step 5: Commit:** `git commit -m "MCP: travel tools for the key's own member, names only, never an address"`

---

### Task 15: Settings → Travel (L, ~750 lines)

**Files:**

- Create:
  - `client/src/pages/settings/TravelPage.tsx`;
  - in `client/src/pages/settings/travel/`: `PlacesSection.tsx`, `TravelRulesSection.tsx`, `TravelSettingsSection.tsx`, `ContainerPlacesSection.tsx`, `UpcomingDays.tsx`;
  - `client/src/api/services/travelService.ts`, `client/src/api/queries/travel.ts`;
  - `client/src/i18n/translations/{en,he}/travel.ts`;
  - `client/tests/helpers/travel.py`, `client/tests/e2e/travel/__init__.py`, `client/tests/e2e/travel/test_travel_settings.py`.
- Modify:
  - `client/src/router/routes.ts` (`ROUTES.TRAVEL`);
  - `client/src/router/AppRouter.tsx` (a lazy route);
  - `client/src/pages/settings/SettingsLayout.tsx`: a "Travel" tab for editors and owners;
  - the i18n index files.

**Interfaces:**

- Consumes: Task 13 routes; `SentenceFilter` (`client/src/features/editor/SentenceFilter.tsx`) with `useBuilderCatalog`, `useFacets` and `useCurrentWorkspace().topics`; `useFacets` containers for the default places.
- Produces:
  - hooks: `usePlaces`, `useSavePlace`, `useRemovePlace`, `useTravelRules`, `useSaveTravelRule`, `useRemoveTravelRule`, `useTravelSettings`, `useSaveTravelSettings`, `useSetContainerPlace`, `useTravelDays(from, to)`;
  - Python helpers `create_place(...)`, `create_rule(...)` and `mark_item(...)` in `client/tests/helpers/travel.py`.
- The page shows:
  - places, with a Home badge, and the address visible to its owner only;
  - rules ("When [sentence] → by [mode], [there / back / both]");
  - factors, buffers, go-home and the default mode, showing the spec defaults;
  - the default place per calendar or project;
  - "Next 14 days", with each day's leg and removal counts linking to `?travelDay=`;
  - "No OpenRouteService key: walking and driving use your last trip or an estimate" when `orsAvailable` is false.

- [ ] **Step 1: Write the failing unit test** `client/src/pages/settings/travel/travelForms.test.ts`:
  - `coordinates text passes as coords`;
  - `factor input clamps to 0.5–3`;
  - `rule sentence → TravelRuleScope where`.
- [ ] **Step 2: Run it to verify it fails.** Run `cd client && node --import tsx --test src/pages/settings/travel/travelForms.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** (with a pure `travelForms.ts` next to the sections).
- [ ] **Step 4: Run the unit test again** (Expect PASS), then the client `lint`, `build` and `test:unit`.
- [ ] **Step 5: Write and run the e2e** in `test_travel_settings.py`:
  - `test_add_home_and_place_by_coordinates`;
  - `test_rule_with_sentence_filter_saves`;
  - `test_settings_defaults_shown_and_saved` (×1.15 and +10 shown for driving);
  - `test_travel_tab_in_hebrew`.

  Expect 4 passed, and take the screenshots.

- [ ] **Step 6: Commit:** `git commit -m "Settings: Travel, with places, rules, factors and default places"`

---

### Task 16: "Add travel time" in the create form and the item sheet (L, ~700 lines)

**Files:**

- Create in `client/src/features/travel/`: `TravelPanel.tsx`, `travelPanel.ts`, `travelPanel.test.ts`, `EveryOccurrenceDialog.tsx`.
- Create: `client/tests/e2e/travel/test_add_travel.py`.
- Modify:
  - `client/src/features/items/create/NewTodoSheet.tsx`:
    - an "Add travel time" switch, collapsed by default;
    - a to-do with only a due date is asked for a time;
    - after the item is saved, `POST /travel/items/:itemId`.
  - `client/src/features/items/create/TimeBlockForm.tsx`: the same switch;
  - `client/src/features/items/ItemSheet.tsx`: "Add travel" on timed items (events, to-dos with a start, blocks and areas). On a series it asks `EveryOccurrenceDialog`.

**Interfaces:**

- Consumes: Task 13 `markItem` and `preview`, Task 6 `solveSpan`, Task 15 hooks.
- Produces:
  - `interface TravelPanelState { mode: TravelMode; fromPlaceId: string | null; toPlaceId: string | null; there: boolean; back: boolean; span: { start: Date | null; end: Date | null; minutes: number | null }; edited: SpanField[] }`;
  - `markRequestOf(state: TravelPanelState, anchor: { itemId: string; occurrence: Date | null; start: Date }, every: boolean): MarkItemRequest`;
  - `previewLine(t, preview): string`, e.g. "Leave 13:20 · arrive 13:52 · 32 min (OpenRouteService)" or "(your last trip)" / "(estimate)";
  - hooks `useMarkItem` and `useTravelPreview`.
- Defaults: from = the plan's previous place, else Home; to = the item's place or a saved place. Tabs: Walk, Drive, Public transport.
- The travel section of the item sheet also has "Place for travel" (the spec's "set place"). It writes `PUT /travel/item-places/:itemId`, so an event a rule matches but whose place can't be found can be given one.

- [ ] **Step 1: Write the failing unit test** `travelPanel.test.ts`:
  - `arrive-by fills start from minutes`;
  - `every on a series sends every:true without occurrence`;
  - `one occurrence sends its original start`;
  - `preview line names the source`.
- [ ] **Step 2: Run it to verify it fails.** Run `cd client && node --import tsx --test src/features/travel/travelPanel.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the unit test again** (Expect PASS), then the client `lint`, `build` and `test:unit`.
- [ ] **Step 5: Write and run the e2e** in `test_add_travel.py`. Seed Home and Braude by coordinates through `client/tests/helpers/travel.py`:
  - `test_new_todo_with_travel_makes_a_leg` (the leg shows before the to-do in the calendar);
  - `test_series_every_occurrence_creates_rule`;
  - `test_due_only_todo_asks_for_a_time`.

  Expect 3 passed, and take the screenshots.

- [ ] **Step 6: Commit:** `git commit -m "Travel: Add travel time when creating, and on events, to-dos and blocks"`

---

### Task 17: Leg sheet, day panel, conflict and past marks (M, ~550 lines)

**Files:**

- Create in `client/src/features/travel/`: `TravelLegSection.tsx`, `TravelDaySheet.tsx`, `legView.ts`, `legView.test.ts`.
- Create: `client/tests/e2e/travel/test_travel_legs.py`.
- Modify:
  - `client/src/features/items/ItemSheet.tsx`: kind `travel` renders `TravelLegSection`;
  - `client/src/features/shell/AppShellLayout.tsx`: mounts `TravelDaySheet` on `?travelDay=`; add `'travelDay'` to `RESERVED_PARAMS` and its test;
  - `calendarEvents.ts`, `clockModel.ts`, `agendaModel.ts`, `TimelineBlock.tsx`: travel occurrences carry `conflict` and `past` (`data-conflict`, `data-past`):
    - a red edge and the "You can't make it" label when in conflict;
    - dimmed when past;
    - a mode icon (lucide `Footprints`, `Car`, `Bus`);
    - the title from `legTitle`, so the clock's Now/Next reads "Bus to Braude" in the UI language;
  - `AgendaBlock.tsx`: a "Travel changed" chip on days that have removals (`useTravelDays`).

**Interfaces:**

- Consumes: Task 13 leg routes and `/days`, Task 15 hooks.
- Produces:
  - `legTitle(t, travel: TravelLegProps): string` (i18n, place names only: "Bus to Braude", "נסיעה באוטובוס לבראודה");
  - `removalText(t, reason: RemovalReason, title: string): string` ("Bus to Braude removed: the lecture was cancelled");
  - `isPastLeg(occurrence, now): boolean`.
- The leg sheet shows:
  - time, mode icon, from → to;
  - source ("OpenRouteService", "your last trip", "estimate", "set by you");
  - the flags "the event moved; check this trip" and conflict;
  - start, end and length (any two), Skip, Reset, and the app links.
  - It never shows a status or a tick.

- [ ] **Step 1: Write the failing unit test** `legView.test.ts`:
  - `title in en and he uses names`;
  - `each removal reason has text`;
  - `conflict and past flags reach the calendar event props`.
- [ ] **Step 2: Run it to verify it fails.** Run `cd client && node --import tsx --test src/features/travel/legView.test.ts src/features/dashboards/variables/urlVars.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the unit test again** (Expect PASS), then the client `lint`, `build` and `test:unit`.
- [ ] **Step 5: Write and run the e2e** in `test_travel_legs.py`:
  - `test_leg_sheet_edit_skip_reset`;
  - `test_cancelled_anchor_shows_reason_in_day_panel` (delete the anchor to-do; the panel reads "removed: … cancelled");
  - `test_conflict_marked` (two anchors 15 minutes apart at different places).

  Expect 3 passed, and take the screenshots (one in Hebrew).

- [ ] **Step 6: Commit:** `git commit -m "Travel: leg sheet, the day's travel panel with removal reasons, conflicts marked"`

---

### Task 18: Privacy page and docs (S–M, ~300 lines)

**Files:**

- Modify:
  - `client/src/i18n/translations/{en,he}/legal.ts` and `client/src/pages/legal/PrivacyPolicyPage.tsx`, if a new section needs markup. The new text says:
    - place coordinates are sent to OpenRouteService to compute lengths;
    - addresses are sent to OpenRouteService's geocoder or OpenStreetMap Nominatim;
    - places are private to the member and never shared, logged or given to agents.
  - `docs/dashboard/DATA.md`:
    - §3.6 Items: kinds `block` and `travel`, plus `props.layer`, `recurrence`, `exceptions`, `travel` and `travelKey`;
    - new §3.22 `Places`, §3.23 `TravelRules`, §3.24 `TravelProfiles`, §3.25 `RoutingQuotas`;
    - §6 indexes.
  - `docs/dashboard/DECISIONS.md`: "Rulings during the build", Rulings 1–26 of this plan, one line each.
  - `INTEGRATIONS-SETUP.md`: a short OpenRouteService section.
    - Shalev creates the free account (no card). Confirm the free plan's daily limits and commercial use in the HeiGIT dashboard.
    - The key goes into `todolist-<stage>-app-secrets` under `OPENROUTESERVICE_API_KEY`: merge it into the JSON, never overwrite the secret.
    - Without it, walking and driving use the remembered length or the estimate.
  - `docs/dashboard/MCP.md`: §7.1 (`list_today` `scheduled`, `get_calendar` occurrences, `busy`); §7.2 (`create_time_block`, `edit_time_block`, the `travel_*` tools); §7.6 (`layer`, `occurrence`, `busy`).
  - `docs/design/CLASSES.md`: the travel classes section, plus the ticked audit.
  - `agent-plugin/README.md`, `agent-plugin/skills/todolist-daily/SKILL.md`, `agent-plugin/skills/todolist-tasks/SKILL.md`, `agent-plugin/cursor/rules/todolist.mdc`:
    - laying out a study week with `create_time_block` (areas first, blocks inside);
    - setting up travel (Home first, then rules, rough minutes are fine);
    - blocks are time, not to-dos (never `complete_todo`);
    - plugin version bumps where `hooks.test.mjs` checks the manifests.
  - `client/tests/e2e/legal_privacy/smoke.py`: assert the OpenRouteService sentence on `/en/privacy` and `/he/privacy`.
  - `docs/design/LOCAL-IS-TODO.md`: every row ticked.

- [ ] **Step 1: Write the failing assertion** in `legal_privacy/smoke.py`: `test_privacy_names_openrouteservice`.
- [ ] **Step 2: Run it to verify it fails.** Run the pytest command on `tests/e2e/legal_privacy/smoke.py -k openrouteservice`. Expect FAIL.
- [ ] **Step 3: Write the text and the docs.**
- [ ] **Step 4: Run the checks.**
  - The smoke test passes.
  - `client/tests/e2e/app/translations.py` passes.
  - `node --test agent-plugin/hooks/*.test.mjs` passes.
  - root `npm run format:check` passes.
- [ ] **Step 5: Commit:** `git commit -m "Privacy and docs: travel data, time blocks and the new MCP tools"`
