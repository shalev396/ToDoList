# iPad layout, calendar chips, trip mode per event, sync-db in rounds: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix what the owner saw on his 13-inch iPad (2026-11-19 screenshots), make calendar chips say what they are, let him switch walk/bus/drive per event (this day or every repeat), and make `sync-db` finish however long it takes.

**Spec:** the owner's message of 2026-11-19 (quoted in each task) plus the travel-time design `docs/superpowers/specs/*travel*` already on dev. Rulings are recorded in each task.

**Tech:** client React + Tailwind (`client/`), server Express/TypeScript on one Lambda (`server/`), pytest + Playwright e2e (`client/tests`).

## Global Constraints

- Never open or print `server/.env.*`; never print secrets.
- Server DB access only through classes (`server/src/classes/**`), lint-enforced. Full OOP style as the surrounding code.
- Infra stays as is: one function, one role, no new AWS resources; the 300 s function timeout stays.
- No `--no-verify`; no attribution lines in commits; commit only your own files.
- Hebrew (he) and English (en) strings for every new UI text; RTL must work.
- Read-only rule: nothing here writes to a provider (Google etc.).
- Device under test: iPad Pro 13" Home Screen app, landscape 1376×1032 CSS px and portrait 1032×1376, dark theme (`localStorage['todolist-ui-theme']='dark'`), Hebrew UI, standalone mode.

---

### Task 1: sync-db in rounds (server + deploy script)

Owner: "lets do the retry in many rounds". The function has 300 s. sync-db (indexes and validators, then the pending data migrations) can need more on qa.

- `sync-db` watches the function's own clock (`context.getRemainingTimeInMillis`, as `remainingMsOf` in `server/src/lambda.ts`). Before each model in the index pass and before each migration it checks the time left; when less than a reserve (60 s) is left it stops cleanly and answers `{ done: false, … }` with what is still pending. A full run answers `{ done: true, … }`. Results stay names and counts only.
- Migrations are recorded one by one and idempotent, so a round that stops (or is killed) loses nothing.
- `server/scripts/deploy-backend.ts` (via `api-action.ts`) calls sync-db again while it answers `done: false`, printing each round. A round that times out anyway (`FunctionError` with "Task timed out") counts as not done and is retried. Stop with a failure after 10 rounds, or after 2 rounds in a row that made no progress (same pending list / two timeouts in a row).
- Other callers (`reset-db`, `sync:schema:local`) unchanged.
- Tests: unit tests for the stop-on-deadline logic (fake clock) and the script's round loop (fake invoker).

### Task 2: calendar chips and the iPad 13" dashboard

Owner: "I am on iPad 13 inch and the ui is breaking — check out the elements missing, gaps and overlapping … remove the hour from the blocks and make it so the icon is first line and second line what it is; if there is not enough room then icon + title in one line; now I can't see what it is without opening it."

- Week/day calendar chips (calendar block, and any view sharing its chip): no time of day on the chip. Line 1: the icon (source/kind icon, bus/walk/car for a trip). Line 2: the title, wrapping to the lines the chip's height allows, ellipsis at the end. A chip too short for two lines: icon + title on one line. The time stays in the chip's accessible name/tooltip.
- Overlaps: events that only touch (one ends when the next starts) are not overlapping; truly overlapping events sit side by side and none is drawn over another (the 15-minute "AutoDS Daily Meeting" over a lecture in the screenshot). Areas keep their own treatment but must not squeeze or cover chips.
- Audit the Summary dashboard layout (clock, donut chart "Open tasks by source", deadlines, calendar, counters; layout `lg` at both iPad widths) for missing gaps, overlaps and missing content. Seen in the screenshot: the donut ring renders black; the tall Deadlines block on the left looks empty; chips overlap in the week grid. Fix what reproduces.
- Not in this task: the trip (leg) sheet — Task 3 owns it.
- Before/after screenshots at both iPad sizes, dark, Hebrew.

### Task 3: walk or bus per event (trip sheet), this day or every repeat

Owner: "add so I can edit if I walk or take the bus on each event, so it will affect the rest of the repeats or a one-time change; now I don't see any change option." Also the trip sheet's "only this trip" times row overflows the sheet on the iPad (15:20 cut off, horizontal scrollbar).

- Server: `TravelSetup.changeLegMode(legId, { mode, scope })`, scope `this` | `repeats`. It marks the leg's anchor event (`TravelRule.markItem`) with the new mode, keeping the direction and place of the rule that makes the leg now (resolve it as `TravelAnchors` does: item mark, else series mark, else the oldest matching where-rule; place: that rule's place, else the leg's event-side place).
  - `this`: the anchor occurrence only.
  - `repeats`: a repeating anchor → every occurrence (series mark). A non-repeating anchor (his Braude timetable is imported as single events) → it and every later event in the same container with the same title, same weekday and same local start time; all marks stored, then one regeneration (never one per event).
  - REST `POST …/travel/legs/:id/mode`; MCP `travel_edit_leg` gains `mode` and `every`.
- Client: in the trip sheet, "How you go" becomes a Walk / Bus / Drive choice. Changing it asks "Only this day" / "Every repeat" (reuse `EveryOccurrenceDialog` style), saves, and the calendar refreshes. The event's own sheet keeps its travel section.
- Fix the trip sheet overflow at iPad sizes (no horizontal scroll; time inputs fit).
- e2e: change a trip to walk for this day, then for every repeat; screenshots at iPad size.

## Review Focus

- A sync-db round that is killed mid-migration, then re-run: nothing duplicated.
- RTL chips: icon at the start side; title wraps, not clipped to one Hebrew letter.
- Two events with identical times: both visible side by side.
- `repeats` on a single imported event whose later copies moved by an hour: those are not changed.
- A trip whose rule is a where-rule with direction `there`: changing its mode must not add a trip back.
