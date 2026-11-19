# Block Tweaks, Hourly Sync and Topic Colours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The calendar opens at a chosen hour, kanban columns scroll on their own, every integration syncs every hour, items land in the right topic ("File under"), and every time and task view colours items by topic family (or subject) and role through one shared rule.

**Architecture:** One pure, shared module under `server/src/types/` (`colours.ts`, `glob.ts`) decides an item's `{family, role}`; the server persists topic and subject families and re-files stored records when File under changes; the client paints through one module (`client/src/features/colours/`) with CSS tokens `--tc-<family>-<role>` validated by the dataviz validator. The hourly sync is one EventBridge rule on the existing function, whose `sync-dispatch` action becomes a scheduled tick with an (empty) list of after-dispatch passes for the travel plan.

**Tech Stack:** TypeScript, Express 5 on one Lambda, MongoDB (mongoose) behind classes, AWS CDK (aws-events), zod 4, React 19 + Vite + Tailwind 4 + shadcn, FullCalendar 6, dnd-kit 6.3.1, node:test (tsx), pytest + Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-hourly-sync-and-block-tweaks-design.md` and `docs/superpowers/specs/2026-11-17-topic-colours-design.md`. Context only (another plan builds them, this plan leaves hooks for them): `docs/superpowers/specs/2026-11-17-time-blocks-design.md`, `docs/superpowers/specs/2026-11-17-travel-time-design.md`.

## Global Constraints

- **Where:** work and commit in the worktree `C:/Projects/Github/Shalev396/TodoList/.worktrees/feat` (branch `feat/time-colours-travel`). Never push, never touch `dev`/`qa`/`main`.
- **Strict OOP on the server:** the database only through classes in `server/src/classes/**`. Enforced by `server/class-boundary.mjs` (lists), `server/eslint.config.js` (no-restricted-imports) and `server/src/classes/classBoundary.test.ts` (import graph, dynamic imports, raw text). Interfaces + `implements`; routes, controllers and MCP tools stay thin (parse, call one class method, shape the answer). Repositories change only in `server/src/models/definitions/*` (interface) + `server/src/models/mongoose/*` (implementation).
- **Shared pure code:** modules under `server/src/types/` import only other `types/` modules (and zod); the client imports them at run time through `@api-types` (`client/vite.config.ts:66`, `client/tsconfig*.json`), e.g. `@api-types/colours.ts` in node-tested files, `@api-types/colours` in components.
- **i18n + RTL:** every user-facing string in both `client/src/i18n/translations/en/<ns>.ts` and `.../he/<ns>.ts` (same keys; new namespaces registered in each `index.ts`). Logical CSS only (`ps-`, `ms-`, `border-s`, `text-start`, `rtl:rotate-180`); the clock ring never mirrors (`ClockRing.tsx` sets `direction: ltr`); user text gets `dir="auto"`.
- **API:** the `{success, data}` envelope (`res.success` / `res.error`), existing status codes and `ERROR_CODES` (`server/src/types/errorCodes.ts`) unchanged; changes are additive. Postman (`postman/collections/TodoList API`) covers only Auth, Dashboard, Setup, Uploads and User, and `server/openapi.yaml` only public auth and `/private/me…`, so neither changes. Ruling: no Postman requests — the collection does not cover workspaces, integrations or attributes.
- **Infra:** one function and one role stay (`server/infra/test/stack.test.ts` "creates one function on two layers, with one role…"); the only new resources are one `AWS::Events::Rule` and its `AWS::Lambda::Permission`. Free services only; no billing, no queue, no new function.
- **Commands** (run from the worktree):
  - server one file: `cd server && node --import tsx --test <path>`; suites `npm run test:unit`, `npm run test:infra`.
  - client one file: `cd client && node --import tsx --test <path>`; suite `npm run test:unit`.
  - gate before every commit (both packages when both changed): `cd server && npm run lint && npm run build && npm run test:unit` (+ `npm run test:infra` when `server/infra/**` changed); `cd client && npm run lint && npm run build && npm run test:unit`; root `npm run format:check`. The pre-commit hook (`.husky/pre-commit`) formats, scans for secrets, lints staged files and regenerates `server/infra/composer/template.json` when infra changes. Never `--no-verify`; never add an `eslint-disable`.
- **E2E (every UI task runs its own test locally before handing over; the owner will not test untested work):**
  1. API: `cd server && npm run start:local -- --stage dev --no-rate-limits` (`--no-rate-limits` as `client/tests/README.md` and CI run it).
  2. Client: `cd client && npx vite --port 5191 --strictPort`.
  3. Tests (from the worktree's `client/`): `BASE_URL=http://localhost:5191 API_BASE_URL=http://127.0.0.1:3000/api C:/Projects/Github/Shalev396/TodoList/client/.venv/Scripts/python.exe -m pytest <file> --browser chromium --base-url http://localhost:5191 -p no:cacheprovider`. The venv exists only in the main checkout (verified); the worktree has none.
- **Screenshots (every UI task):** before (on the task's base commit, before editing) and after, desktop Chromium 1440×900 and iPhone WebKit 393×852 with the forced insets and fake Home Screen app of `client/tests/e2e/app_shell/ios_home_screen.py`, light and dark, en and he where the task adds text. Save to `client/screens/t<N>/{before,after}-<what>.png` (git-ignored, `.gitignore:50`). List them in the task's report.
- **Secrets:** never print or open `server/.env*`; copying one with `cp` is the only allowed touch.
- **Commits:** plain messages, no attribution lines.
- Decisions the specs leave open are marked **Ruling: … — why** where they are made.

### Worktree setup (once, before Task 1)

- [ ] `cd C:/Projects/Github/Shalev396/TodoList/.worktrees/feat && npm ci && (cd server && npm ci) && (cd client && npm ci)`
- [ ] `cp ../../server/.env.dev server/.env.dev` (copy only; never open or print it).
- [ ] `C:/Projects/Github/Shalev396/TodoList/client/.venv/Scripts/python.exe -m playwright install webkit` if WebKit is missing (the iPhone screenshots).
- [ ] Gate passes on the untouched branch (all commands above). Expected: green.

## Review Focus

1. **Midnight as the start hour.** `startHour: 0` must open at 00:00, not fall back to 7 through a truthy check; month and phone-list views (no time slots) must not throw. → Task 1: `readStartHour({startHour: 0}) === 0`, and the e2e switches to Month and back.
2. **A drop on a phone aimed at the next column.** With the droppable inside its capped, scrolled list, its overflowing rect must not catch a pointer that is over the next column. → Task 2: `clipToViewport` unit tests and `visibleCollisions` keeps only containers whose clipped rect holds the pointer.
3. **Names that are not plain words.** A calendar named `Calc. (I) [2026]`, or a GitHub board whose match key (`owner/projects/3`) differs from its name, must be re-filed exactly and only itself. → Task 4: Refiling tests with those two containers next to look-alikes.
4. **Dangling references.** An item whose `overlay.topicOverride` names a deleted topic, or whose Subject value is no longer an option, falls through to the next source (topic, then gray); a topic with no family yet reads as gray; nothing throws. → Task 6: `resolveColour` cases.
5. **Real subject titles.** Hebrew patterns with quotes (`*חדו"א*`), mixed-case Latin, a title matching two subjects (first in option order wins), and an explicit value beating an earlier pattern. → Task 6 (`subjectOf`) and Task 8 (`SubjectMatches.count` counts the same way).

---

### Task 1: Calendar block — the hour it opens at (`startHour`)

**Files:**

- Modify: `server/src/types/builder.ts` (`VIZ_SCHEMAS.calendar`, ~line 518)
- Test: `server/src/types/builder.test.ts`
- Create: `client/src/features/dashboards/blocks/calendar/startHour.ts`, `startHour.test.ts`
- Rename + modify: `client/src/features/dashboards/blocks/calendar/useSaveCalendarView.ts` → `useSaveCalendarViz.ts`
- Modify: `client/src/features/dashboards/blocks/calendar/CalendarBlock.tsx`
- Modify: `client/src/i18n/translations/{en,he}/timeBlocks.ts`, `{en,he}/editor.ts` (`editor.viz.options.startHour`)
- Modify: `docs/dashboard/BUILDER.md` (the calendar viz example, line ~138: add `"startHour": 8`)
- Create: `client/tests/e2e/dashboard_time_blocks/test_start_hour.py`

**Interfaces:**

- Produces: `VIZ_SCHEMAS.calendar` gains `startHour: z.int().min(0).max(23).optional()` (accepted by the catalog, `builder_*` MCP tools and the editor's VizStep, which renders it as a number field). In `startHour.ts`: `DEFAULT_START_HOUR = 7`; `readStartHour(viz: Record<string, unknown>): number` (an integer 0–23, else 7); `slotTime(hour: number): string` (`'08:00:00'`); `startScrollTop(m: { slotTop: number; regionTop: number; scrollTop: number; stickyHeight: number }): number` = `max(0, slotTop − regionTop + scrollTop − stickyHeight)`. `useSaveCalendarViz(dashboard, block): (patch: { view?: 'week' | 'month'; startHour?: number }) => void` (same rules as today's hook: editors and owners on the draft save; anyone else keeps it for the visit).

- [ ] **Step 1: Failing tests.** `builder.test.ts`: `it('calendar viz takes a startHour from 0 to 23')` — `safeParse({kind:'calendar', startHour: 0}).success === true`, `23` true, `24`, `-1`, `7.5` false. `startHour.test.ts`: `readStartHour({}) === 7`, `readStartHour({startHour: 0}) === 0`, `readStartHour({startHour: '8'}) === 7`, `readStartHour({startHour: 30}) === 7`; `slotTime(0) === '00:00:00'`, `slotTime(13) === '13:00:00'`; `startScrollTop({slotTop: 500, regionTop: 100, scrollTop: 40, stickyHeight: 60}) === 380`; `startScrollTop({slotTop: 90, regionTop: 100, scrollTop: 0, stickyHeight: 60}) === 0`.
- [ ] **Step 2: Run** both files; expected FAIL (no `startHour`, no module).
- [ ] **Step 3: Schema + `startHour.ts`.**
- [ ] **Step 4: CalendarBlock.** State `startHour` from `readStartHour(block.viz)`. A ref on the `role="region"` scroll div (keep `height="auto"`; drop `scrollTime`, it has nothing to scroll). `scrollToStart()`: only when the FullCalendar view is `timeGridWeek`; find `.fc-timegrid-slot-lane[data-time="<slotTime>"]` inside the region and the sticky header `.fc-scrollgrid-section-header` (height 0 when absent), then set `region.scrollTop = startScrollTop(...)` — measured from the rendered row, never a pixel guess. Call it in `requestAnimationFrame` from FullCalendar's `viewDidMount` and `datesSet` (week navigation keeps the hour) and from an effect on `startHour`. Header `actions`: a `SelectField` (`components/ui/select`) labelled `timeBlocks.calendar.startsAt`, options `00:00`…`23:00` (`dir="ltr"`), next to the Week/Month toggle, shown when `view === 'week'`, not on a phone, not `viz.view === 'list'`, not while editing. On change: `setStartHour(h)` then `save({ startHour: h })`. The Week/Month toggle calls `save({ view })`. Put `data-start-hour={startHour}` on the region.
- [ ] **Step 5: i18n.** en `timeBlocks.calendar.startsAt: 'Starts at'`, he `'מתחיל ב־'`; `editor.viz.options.startHour`: en `'Opens at hour'`, he `'שעת פתיחה'`.
- [ ] **Step 6: E2E** `test_start_hour.py` (pattern of `dashboard_time_blocks/smoke.py`: `fresh_owner`, `create_dashboard`, desktop viewport): `test_week_opens_at_seven_by_default` — the `07:00:00` slot's top is within 2px of the region's top + sticky header height; `test_start_hour_is_saved_and_kept_across_weeks` — choose `12:00` → one `POST …/ops` 200 → `12:00:00` slot at the top; click Next → still 12:00; wheel up 200px → region `scrollTop` decreases (free scrolling); reload → 12:00; switch to Month and back to Week → 12:00, no console error; `test_midnight` — choose `00:00` → region `scrollTop` is 0 and `data-start-hour="0"` after reload.
- [ ] **Step 7: Run** the unit tests (PASS), the e2e (PASS), take the screenshots (week at 07:00 before; at 12:00 after; iPhone shows the list view without the select).
- [ ] **Step 8: Gate, then commit** `git commit -m "Calendar block: choose the hour the week view opens at"`.

---

### Task 2: Board (kanban) block — each column scrolls on its own

**Files:**

- Modify: `client/src/features/dashboards/blocks/KanbanBlock.tsx` (`Column`, board `ScrollArea`, collision detection)
- Modify: `client/src/features/dashboards/blocks/data/kanbanDrag.ts`, test `kanbanDrag.test.ts`
- Create: `client/tests/e2e/dashboard_data_blocks/test_kanban_scroll.py`

**Interfaces:**

- Produces (`kanbanDrag.ts`): `interface Box { top: number; left: number; bottom: number; right: number }`; `clipToViewport(rect: Box, viewport: Box): Box | null` (intersection, null when empty); `pointIn(point: { x: number; y: number }, box: Box): boolean`. In `KanbanBlock.tsx`: `visibleCollisions: CollisionDetection` replaces `collisions`.

**Ruling:** the droppable list sits _inside_ its column's own scroll viewport — why: dnd-kit 6.3.1 auto-scrolls only the scrollable _ancestors_ of the node under the pointer (`useScrollableAncestors(overNode ?? activeNode)`, `@dnd-kit/core/dist/core.esm.js:2956`; the node itself is skipped, line ~714), so a column list can scroll while dragging only if it is an ancestor of the droppable. Because the droppable then extends past its viewport, collisions are clipped to the viewport.

- [ ] **Step 1: Failing tests** in `kanbanDrag.test.ts`: `clipToViewport({top:0,left:0,bottom:900,right:200}, {top:100,left:0,bottom:400,right:200})` deep-equals `{top:100,left:0,bottom:400,right:200}`; disjoint boxes → `null`; `pointIn({x:10,y:450}, clipped)` is false although the unclipped rect holds it (the Review Focus 2 case).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the helpers. `visibleCollisions`: `pointerWithin`, then keep only containers whose `node.current.closest('[data-column-viewport]')` rect clipped against the container rect holds `pointerCoordinates`; with no pointer (keyboard) fall back to `rectIntersection` over the same clipped rects.
- [ ] **Step 4: Layout.** `Column`: `flex min-h-0 w-64 shrink-0 flex-col gap-2 md:h-full max-md:w-full`; the header `h3` stays as is (`shrink-0`, always visible); below it `<div data-column-viewport={id} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md bg-sunken/60 max-md:max-h-[60dvh]">` (the `isOver` ring moves here), holding the droppable `<div ref={setNodeRef} data-column={id} className="flex min-h-full flex-col gap-2 p-1.5">` with the empty text or the card list. Board: the `ScrollArea` keeps horizontal scrolling; its inner row stays `flex h-full min-h-0 gap-3 … max-md:h-auto max-md:flex-col`, so on desktop the columns fill the block's height and the block itself never scrolls vertically.
- [ ] **Step 5: E2E** `test_kanban_scroll.py`: seed 30 local to-dos via `create_local_item`, complete 24 (`POST …/items/:id/complete`), add a kanban block with `apply_ops` (`add_block`, `type: 'kanban'`, catalog defaults). `test_done_scrolls_alone` (1440×900): Done viewport `scrollHeight > clientHeight`; scroll it 400px → its `scrollTop > 0`, the Open viewport's `scrollTop == 0`, `window.scrollY` unchanged, the Done header still inside the block. `test_drop_on_a_scrolled_column`: scroll Done to the bottom, drag an Open card's handle onto Done → `PATCH` 200 and the item's status is `done` via the API. `test_phone_columns_are_capped` (393×852): every column viewport's height ≤ 0.6 × 852 + 1, Done scrolls inside, and scrolling the page reaches the column after Done.
- [ ] **Step 6: Run** unit + e2e (PASS); screenshots (long Done column before/after, desktop and iPhone).
- [ ] **Step 7: Gate, commit** `git commit -m "Board block: each column scrolls on its own"`.

---

### Task 3: Sync every hour, on the hour (and the after-dispatch hook)

**Files:**

- Modify: `server/infra/lib/constants.ts` (`SYNC_DISPATCH_SCHEDULE`; the "No schedule invokes any of them for now" comment → only `sync-dispatch` is scheduled)
- Create: `server/infra/lib/constructs/schedule.ts` (`HourlySync`)
- Modify: `server/infra/lib/app-stack.ts` (instantiate after `Compute`; header comment "No queue, no worker function and no schedule" → one hourly rule)
- Modify: `server/infra/lib/composer.ts` (`GROUP_OF_CONSTRUCT`: `Schedule: 'Compute'`)
- Modify: `server/infra/test/sync.test.ts`, `server/infra/test/stack.test.ts`, `server/infra/test/composer.test.ts`
- Regenerate: `server/infra/composer/template.json` (`cd server && npm run synth:composer`; the hook also does it)
- Create: `server/src/jobs/scheduledTick.ts`, `scheduledTick.test.ts`
- Modify: `server/src/lambda.ts` (header comment, `ACTIONS[SYNC_DISPATCH_ACTION]`), `server/src/lambda.test.ts`, `server/src/sync/dispatcher.ts` (header: "invoked hourly by the schedule, or directly")

**Interfaces:**

- Produces (infra): `SYNC_DISPATCH_SCHEDULE = 'cron(0 * * * ? *)'`; `class HourlySync extends Construct` with props `{ config: StageConfig; function: lambda.IFunction }`, creating `events.Rule` `Rule` named `resourceName(stage, 'hourly-sync')`, `schedule: events.Schedule.expression(SYNC_DISPATCH_SCHEDULE)`, enabled on every stage, target `new targets.LambdaFunction(fn, { event: events.RuleTargetInput.fromObject({ action: SYNC_DISPATCH_ACTION }), retryAttempts: 2, maxEventAge: Duration.minutes(30) })`.
- Produces (server, `jobs/scheduledTick.ts`) — **the travel plan's hook:**
  ```ts
  export interface AfterDispatchPass {
    /** Unique; the key of its counts in the tick's result. */
    readonly name: string;
    run(now: Date): Promise<Record<string, number>>;
  }
  /** Run after every scheduled dispatch, in order. Empty until the travel plan adds its horizon pass. */
  export const AFTER_DISPATCH_PASSES: readonly AfterDispatchPass[] = [];
  export interface ScheduledTickResult {
    dispatch: DispatchResult;
    passes: Record<string, Record<string, number> | { failed: true }>;
  }
  export async function runScheduledTick(options?: {
    now?: Date;
    dispatch?: () => Promise<DispatchResult>;
    passes?: readonly AfterDispatchPass[];
  }): Promise<ScheduledTickResult>;
  ```
  `lambda.ts`: `[SYNC_DISPATCH_ACTION]: () => runScheduledTick()`. The default dispatch is `dispatchAllSyncs('schedule')`. A pass that throws is logged (`logger.error('scheduled tick: pass failed', { pass: name, error })`), recorded as `{ failed: true }`, and the next pass still runs; the tick resolves.

**Ruling:** an EventBridge _rule_, not EventBridge Scheduler — why: a rule's Lambda target needs only a resource-based permission, so the stack keeps its one role; Scheduler needs an execution role. `retryAttempts: 2` and `maxEventAge: 30 min` so a throttled tick is not delivered late into the next hour.

- [ ] **Step 1: Failing infra tests.** `sync.test.ts`: replace `it('has no schedules…')` with `it('runs sync-dispatch every hour on the hour through one EventBridge rule')`: `resourceCountIs('AWS::Events::Rule', 1)`; `hasResourceProperties('AWS::Events::Rule', { Name: 'todolist-<stage>-hourly-sync', ScheduleExpression: 'cron(0 * * * ? *)', State: 'ENABLED', Targets: [Match.objectLike({ Input: '{"action":"sync-dispatch"}', RetryPolicy: { MaximumEventAgeInSeconds: 1800, MaximumRetryAttempts: 2 } })] })`, the target `Arn` is the one function's; still 0 `AWS::Scheduler::Schedule`/`ScheduleGroup`; no role trusts `scheduler.amazonaws.com` or `events.amazonaws.com`. In `it('lets the function invoke itself…')`: the permissions' principals are `apigateway.amazonaws.com` plus exactly one `events.amazonaws.com` whose `SourceArn` is the rule's `Arn`. `stack.test.ts`: the "one function…" test still holds (1 function, 1 role) and counts 1 rule. `composer.test.ts`: the Compute group gains the rule's card (the permission folds into it); still no `AWS::Scheduler::Schedule`.
- [ ] **Step 2: Failing server tests** `scheduledTick.test.ts`: `it('runs the dispatch, then every pass in order, with the same now')` (fake dispatch `{dispatched: 2, failed: 0}`, two passes recording calls); `it('records a failing pass and still runs the next')` → `passes.first` deep-equals `{ failed: true }`, `passes.second` has its counts; `it('answers the dispatch and no passes by default')`; `it('has no after-dispatch passes yet')` → `AFTER_DISPATCH_PASSES.length === 0` (the travel plan changes this test). `lambda.test.ts`: `it('runs the scheduled tick on sync-dispatch')` → status 200, body has `dispatch.dispatched` (a number) and `passes` `{}`.
- [ ] **Step 3: Run** `npm run test:infra` and the two server files → FAIL.
- [ ] **Step 4: Implement** constants, `HourlySync`, the stack wiring (`new HourlySync(this, 'Schedule', { config, function: compute.function })`), the composer group, `scheduledTick.ts`, `lambda.ts` (header comment: "`sync-dispatch` also runs hourly from the stack's one EventBridge rule; the others run only when invoked directly"), the comments in `dispatcher.ts` and `app-stack.ts`. Leave purge and gcal-dispatch unscheduled (their "no schedule" comments stay true).
- [ ] **Step 5: Run** `npm run synth:composer`, `npm run test:infra`, the two server files → PASS. `cdk-nag` runs inside synth; any new finding is fixed, never suppressed without the reason the other `nag.ts` entries give.
- [ ] **Step 6: Gate, commit** `git commit -m "Sync every hour on the hour from one EventBridge rule; scheduled tick with after-dispatch passes"`.

---

### Task 4: File under — server (re-file stored records, per-container rules)

**Files:**

- Modify: `server/src/classes/item/Container.ts` (`matchKey`, `toView` adds it), `server/src/types/items.ts` (`FacetContainer.matchKey`)
- Modify: `server/src/models/definitions/Container.ts` + `server/src/models/mongoose/Container.ts` (`setTopics`)
- Modify: `server/src/models/definitions/Item.ts` + `server/src/models/mongoose/Item.ts` (`refileByContainer`)
- Create: `server/src/classes/item/Refiling.ts`, `Refiling.test.ts`; export from `classes/item/index.ts`
- Modify: `server/src/classes/workspace/TopicRules.ts` (`withRule`, `ruleFor`), `TopicRules.test.ts`
- Modify: `server/src/classes/workspace/Workspace.ts` (`update` re-files on a rules change; new `fileUnder`)
- Modify: `server/src/classes/integration/Integration.ts` (`toView().topicId`, `listIn`, `fileUnder`, `fileContainerUnder`; `update` re-files when `topicId` changes), `server/src/models/definitions/Integration.ts` (`IntegrationStatusBase.topicId`)
- Modify: `server/src/routes/private/integrations.ts` (new PUT + types), `server/src/controllers/integrations.ts`, the integration body schemas' module (where `UpdateIntegrationRequestBody` is parsed), `server/src/types/api-contracts.ts` (export the new types)
- Test: `server/src/routes/private/integrations.http.test.ts`, `integrations.roleMatrix.test.ts`, `server/src/sync/providers/github.test.ts` (pin match keys)
- Docs: `docs/design/CLASSES.md` (one line for `Refiling`)

**Interfaces:**

- Produces:
  ```ts
  // Container
  get matchKey(): string; // GitHub: source.key ?? name ('owner/repo', 'owner/projects/3'); every other provider: name
  // FacetContainer gains  matchKey: string  (redacted like name)
  // Refiling (classes/item/Refiling.ts)
  export interface RefileCounts { containers: number; items: number }
  export class Refiling {
    /** One integration's live containers re-classified by the workspace's current rules (default: its topic), then its items follow their container (container-less: the integration's topic). Never writes an overlay. */
    static async integration(integration: Integration): Promise<RefileCounts>;
    /** Every live integration of the workspace (a rule change). */
    static async workspace(workspaceId: string): Promise<RefileCounts>;
  }
  // repositories
  IContainerRepository.setTopics(workspaceId: string, changes: readonly { id: string; topicId: string | null }[]): Promise<number>;
  IItemRepository.refileByContainer(workspaceId: string, integrationId: string, assignments: readonly { containerId: string | null; topicId: string | null }[]): Promise<number>;
  // TopicRules
  withRule(match: string, topicId: string | null): TopicRules; // drops rules with the same match (case-insensitive); a topic prepends the new rule (it beats broader globs); null only removes
  ruleFor(match: string): TopicRule | null;                     // exact, case-insensitive
  // Workspace
  async setNameRule(caller: Caller, match: string, topicId: string | null): Promise<FileUnderResult>; // owner; TopicRules#withRule; same validation, audit and write as update's topicRules; then Refiling.workspace
  // Integration
  static async listIn(workspaceId: string): Promise<Integration[]>; // live ones; only Refiling calls it
  async fileUnder(caller: Caller, topicId: string | null): Promise<{ integration: Integration; refiled: RefileCounts }>; // its owner (404 for others); Topic.assertOf; audited as integration.update {changed:['topicId']}
  async fileContainerUnder(caller: Caller, containerId: string, topicId: string | null): Promise<FileUnderResult>; // its owner (404) and the workspace owner (403); the container must be this integration's live one (404)
  export interface FileUnderResult { rule: TopicRule | null; refiled: RefileCounts }
  // IntegrationStatusBase gains  topicId: string | null
  // Route: PUT /api/private/workspaces/:wid/integrations/:iid/containers/:cid/file-under, requireWorkspace('owner')
  export interface FileUnderRequestBody { topicId: string | null }   // zod: z.strictObject({ topicId: z.string().min(1).max(100).nullable() })
  export type FileUnderResponseData = FileUnderResult;
  ```
  `Integration#update` routes its `topicId` change through the same private write as `fileUnder` and re-files too (answer unchanged: `IntegrationStatusView`, now with `topicId`). `Workspace#update` re-files the workspace after a write that changed `topicRules` (answer unchanged).

**Rulings:**

- Re-file in place instead of starting a provider sync — why: syncs are incremental (a full sweep is due only every 20 h, `FULL_SYNC_INTERVAL_MS`, `server/src/classes/sync/SyncEngine.ts:102`), so a sync would leave unchanged records in the old topic. Re-filing applies the sync's own rule (`toContainerUpsert` / `toItemUpsert`, `server/src/classes/sync/syncRecords.ts:79-118`) to every stored record of the affected connections at once, with no provider call and no quota; the next sync computes the same topics (the changed `topicId` makes the stored hash differ once, so that run rewrites those rows with equal values). This is the spec's "starts a sync … so already-synced items move then", done without the provider.
- A rule change re-files the whole workspace — why: a per-calendar File under writes an ordinary _name_ rule, which also files same-named containers of other connections, exactly as the next sync would.
- The match key is derived, not stored — why: only GitHub's mapper sets one (`server/src/sync/providers/github/mapping.ts` `mapRepo`, `mapBoard`), always equal to `source.key`; a test pins that, so a mapper change trips it.
- Overrides win (verified): sync and Refiling write only `topicId`; `overlay.topicOverride` is user-only (`server/src/classes/item/Overlay.ts`) and the colour resolver (Task 6) reads `topicOverride ?? topicId`. Topic pages and filters read the stored `topicId` only (`builder/catalog.ts:91`, `TOPIC_FIELD.path = 'topicId'`); this plan keeps that as is.
- Verification step: `grep -rn "topicId:" server/src/sync/providers --include=*.ts | grep -v "\.test\."` prints nothing, so no adapter sets a record's topic itself and container → items is the whole rule.

- [ ] **Step 1: Failing tests.**
      `TopicRules.test.ts`: `withRule('braude', 'studies')` on `[{match:'*', topicId:'p'}]` → `[{braude→studies}, {*→p}]`; on `[{match:'BRAUDE', topicId:'w'}]` → one rule `braude→studies`; `withRule('braude', null)` removes it and adds nothing; `ruleFor('Braude')` finds `braude`.
      `Refiling.test.ts` (test DB, as `Topic.test.ts` starts one): `it('moves a connection to its new topic, container by container, and keeps overlays')` — calendars "Personal" and "braude" with items, a container-less item and an item with `overlay.topicOverride = X`: after the integration's topic becomes Work, all three groups have `topicId` Work and the override is still X; `it('a name rule beats the default; removing it returns the container to the default')`; `it('re-files a GitHub board by its owner/projects key, not its title')` (name `Roadmap`, `source.key` `shalev396/projects/3`, rule `shalev396/*`); `it('matches a name with regex characters only to itself')` (`Calc. (I) [2026]` vs `Calc X (I) [2026]`); `it('never touches soft-deleted items, other integrations or local to-dos')`; counts returned equal the rows changed.
      `github.test.ts`: `it('gives repos and boards a match key equal to source.key')`.
      `integrations.http.test.ts`: PUT file-under as the workspace owner who owns the integration → 200 `{rule: {match, topicId}, refiled}` and the workspace's `settings.topicRules[0]` is that rule; `{topicId: null}` → `rule: null`, rule gone; editor → 403; another member's integration → 404; unknown or other-integration container → 404; unknown topic → 400; body `{topicId: 5}` → 400. PATCH `{topicId}` → 200, view has `topicId`, the integration's items moved. `GET …/facets` containers carry `matchKey`. `integrations.roleMatrix.test.ts`: the new route row (viewer/editor 403, owner 200).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** repository methods (`setTopics`: one `bulkWrite` of `updateOne`; `refileByContainer`: one `bulkWrite` of `updateMany` with filter `{ workspaceId, integrationId, containerId, deletedAt: null, topicId: { $ne: topicId } }` → `$set: { topicId }`), `Container#matchKey`, `Refiling`, `TopicRules` methods, `Workspace#setNameRule` (shares a private settings write with `update`; `Integration#fileContainerUnder` calls it with the container's `matchKey`), the `Integration` methods (import `Refiling` and `Workspace` lazily, as `Topic.delete` does, to avoid cycles), the route, controller and body schema.
- [ ] **Step 4: Run** the files above + `npm run test:unit` → PASS; run the grep from the rulings (prints nothing).
- [ ] **Step 5: Docs** `docs/design/CLASSES.md`: `Refiling` — re-files stored records after a File under change, no provider call.
- [ ] **Step 6: Gate, commit** `git commit -m "File under: re-file stored items at once; per-calendar and per-project rules"`.

---

### Task 5: File under — client (the Manage panel)

**Files:**

- Create: `client/src/features/integrations/FileUnder.tsx`, `fileUnder.ts`, `fileUnder.test.ts`
- Modify: `client/src/features/integrations/IntegrationCard.tsx` (render `<FileUnder>` after the mode row)
- Modify: `client/src/api/services/integrationService.ts` (`fileContainerUnder`), `client/src/api/queries/integrations.ts` (`useFileContainerUnder`)
- Modify: `client/src/i18n/translations/{en,he}/connect.ts` (`connect.fileUnder.*`)
- Create: `client/tests/e2e/integrations/test_file_under.py`

**Interfaces:**

- Consumes: Task 4's PUT route, `IntegrationStatusView.topicId`, `FacetContainer.matchKey`, `useUpdateIntegration` (PATCH `{topicId}`), `useFacets`, `useCurrentWorkspace()` (`topics`, `settings.topicRules`, `isOwner`).
- Produces: `containerRuleTopic(rules: readonly TopicRule[], matchKey: string): string | null` (exact, case-insensitive: the client mirror of `TopicRules#ruleFor`); `containersOf(containers: readonly FacetContainer[], integrationId: string): FacetContainer[]` (by name, locale-aware); `useFileContainerUnder(workspaceId)` (mutation `{ integrationId, containerId, topicId }` → `FileUnderResponseData`; on success invalidates the workspace, items, facets, blocks and integrations queries); `<FileUnder workspaceId integration />`.

UI: a "File under" `SelectField` — "None (Unsorted)" + topics in sidebar order, value `integration.topicId ?? ''`; saving shows `connect.fileUnder.saved` ({topic}). For the workspace owner only, a `<details>` "Calendars and projects (N)" lists `containersOf(...)`, each with a `SelectField`: "Same as the connection (<topic>)" + topics; value `containerRuleTopic(settings.topicRules, c.matchKey) ?? ''`; a change PUTs and toasts `connect.fileUnder.savedContainer` ({name, topic, count: refiled.items}). A hint: items filed by hand keep their topic. 44px targets on touch (`max-md:h-11`), names `dir="auto"`.

- [ ] **Step 1: Failing unit tests** `fileUnder.test.ts`: `containerRuleTopic([{match:'BRAUDE', topicId:'s'}], 'braude') === 's'`; a glob `*braude*` is not an exact rule → `null`; `containersOf` keeps only that integration's, sorted (`'alpha' < 'Beta'`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the helpers, service, hook, component, i18n (en/he: `label`, `none`, `hint`, `saved`, `containers`, `sameAsConnection`, `savedContainer`, `error`); unit tests PASS.
- [ ] **Step 4: E2E** `test_file_under.py` on a demo workspace (`create_workspace(..., loadDemoData=True)`, as `client/tests/README.md` describes): `test_connection_file_under_moves_its_items` — open Integrations, Manage the demo Google Calendar connection, choose Work → PATCH 200 → via `list_items(provider='google_calendar')` every item's `topicId` is Work's id; `test_calendar_file_under_writes_a_rule_and_back` — in "Calendars and projects" choose College for the first calendar → PUT 200 → `get_workspace(...)["settings"]["topicRules"][0]` is `{match: <its name>, topicId: <college id>}` and its items are College; choose "Same as the connection" → the rule is gone and the items are Work again; `test_hebrew_panel_is_rtl` — `/he/…` panel strings are Hebrew and no horizontal overflow at 393px (`helpers/responsive.assert_no_horizontal_overflow`).
- [ ] **Step 5: Run** unit + e2e (PASS); screenshots of the Manage panel (desktop, iPhone, he).
- [ ] **Step 6: Gate, commit** `git commit -m "Manage panel: File under for the connection and for each calendar or project"`.

---

### Task 6: Colour core — the shared resolver, globs, and topic families saved on the topic

**Files:**

- Create: `server/src/types/glob.ts`, `glob.test.ts`
- Modify: `server/src/classes/workspace/TopicRules.ts` (uses `glob.ts`; behaviour unchanged, `TopicRules.test.ts` passes untouched)
- Create: `server/src/types/colours.ts`, `colours.test.ts`
- Modify: `server/src/types/attributes.ts` (Subject key, option looks, renames), create `server/src/types/attributes.test.ts`
- Modify: `server/src/classes/workspace/Topic.ts` (+ the create row type in `server/src/models/definitions/Topic.ts` if it lacks `colour`), `Topic.test.ts`
- Create: `server/src/migrations/topicColours.ts`, `topicColours.test.ts`; modify `server/src/migrations/index.ts` (append last)

**Interfaces:**

- Produces (`types/glob.ts`): `globSource(pattern: string): string` (`'^' + parts escaped and joined by '.*' + '$'`); `matchesGlob(pattern: string, text: string): boolean` (`new RegExp(globSource(p), 'isu')`: whole text, any case, `*` spans `/` and line breaks, everything else literal — today's `TopicRules` semantics).
- Produces (`types/colours.ts`) — **the resolver the time-blocks/travel plan consumes:**
  ```ts
  export type ColourFamily = TopicColour; // the nine of TOPIC_COLOURS
  export const COLOUR_ROLES = ['scheduled', 'work', 'travel', 'area'] as const;
  export type ColourRole = (typeof COLOUR_ROLES)[number];
  export const UNSORTED_FAMILY: ColourFamily = 'gray';
  /** Auto-assignment cycle (validated, Task 7); gray is never auto-assigned. */
  export const FAMILY_ASSIGN_ORDER = [
    'blue',
    'orange',
    'teal',
    'amber',
    'pink',
    'green',
    'violet',
    'red',
  ] as const;
  /** Kinds the resolver knows: today's ItemKind plus the two the time-blocks plan adds. */
  export type ColourKind = ItemKind | 'block' | 'travel';
  export type ColourLayer = 'block' | 'area';
  export interface ColourInput {
    kind: ColourKind;
    provider: string;
    title: string;
    topicId: string | null;
    topicOverride: string | null;
    subject: string | null; // the item's own Subject value
    layer: ColourLayer | null; // time blocks only
  }
  export interface ColourSubject {
    name: string;
    family: ColourFamily;
    patterns: readonly string[];
  }
  export interface ColourContext {
    topicFamilies: ReadonlyMap<string, ColourFamily>;
    subjects: readonly ColourSubject[];
  }
  export interface ItemColour {
    family: ColourFamily;
    role: ColourRole;
    from: 'subject' | 'topic' | 'unsorted';
    subject: string | null;
    topicId: string | null;
  }
  export function roleOf(input: Pick<ColourInput, 'kind' | 'provider' | 'layer'>): ColourRole;
  export function subjectOf(
    input: Pick<ColourInput, 'subject' | 'title'>,
    subjects: readonly ColourSubject[],
  ): ColourSubject | null;
  export function resolveColour(input: ColourInput, context: ColourContext): ItemColour;
  export function nextFamily(taken: readonly (ColourFamily | null)[]): ColourFamily;
  export function subjectsOf(attributes: readonly AttributeDef[]): ColourSubject[];
  ```
  Rules: `roleOf` — `kind 'travel'` → travel; `kind 'block'` with `layer 'area'` → area; `kind 'event'` from a provider (`provider !== 'local'`) → scheduled; everything else (todo, issue, task, assignment, deadline, message, pr, block) → work. `subjectOf` — the item's own value when it names a subject; otherwise the first subject in option order with a pattern matching the title (`matchesGlob`); else null. `resolveColour` — family from the subject, else the topic `topicOverride ?? topicId` when it is in `topicFamilies`, else gray (`from: 'unsorted'`); role from `roleOf`. `nextFamily` — the first of `FAMILY_ASSIGN_ORDER` not taken; when all are taken, the least-taken, earliest in the order (`gray` and `null` never count). `subjectsOf` — the `subject` attribute when it is a `select`: its options in order, each with its look's family and patterns; an option without a look is left out (it falls through to the topic).
  **How it compiles before and after the time-blocks plan:** `ColourKind` is `ItemKind | 'block' | 'travel'`, so `roleOf` compares with `'block'`/`'travel'` today (they are in the union) and `ItemQueryRow.kind` (an `ItemKind`) is assignable. When that plan adds `'block'` and `'travel'` to `ITEM_KINDS` (`server/src/types/domain.ts`), the union simply collapses to `ItemKind`; nothing else changes. `layer` is an input field, not read from any item shape here (the client adapter in Task 7 reads `props.layer`).
- Produces (`types/attributes.ts`): `SUBJECT_ATTRIBUTE_KEY = 'subject'`; `OPTION_PATTERNS_MAX = 10`; `OPTION_PATTERN_LENGTH_MAX = 100`; `OptionLookSchema = z.strictObject({ option: <the option schema, 1–40 trimmed>, colour: z.enum(TOPIC_COLOURS), patterns: z.array(z.string().trim().min(1).max(100)).max(10) })`, `type OptionLook`; `optionLooks?: OptionLook[]` (≤ `MAX_ATTRIBUTE_OPTIONS`) on `AttributeDefSchema` and `NewAttributeSchema`; `AttributePatchSchema` gains `optionLooks?` and `renames?: { from: string; to: string }[]` (≤ 30). `refineShape`: looks only on a `select`, each look names one of `options`, at most one look per option.

**Rulings:**

- Families are auto-assigned in `FAMILY_ASSIGN_ORDER`, not the picker's `TOPIC_COLOURS` order — why: neighbours in `TOPIC_COLOURS` (red, orange, amber) are under the validator's normal-vision floor (ΔE < 15); this cycle passes adjacency, wrap-around included, in both themes (Task 7). The first three topics (Work, College, Personal) get blue, orange, teal.
- Gray is never auto-assigned; the reuse starts at the ninth topic, not the tenth the spec says — why: gray is Unsorted's colour, so only eight families are auto-assignable.
- `colour: null` on a topic means "assign automatically": `Topic.create`, `ensureDefaults` and `update({colour: null})` save `nextFamily` of the workspace's other topics. A family chosen by hand (gray included) is kept.
- Option looks are an additive optional field of the definition — why: `settings.attributes` is `Mixed` (`server/src/models/mongoose/Workspace.ts:39`), so stored definitions stay valid and no data migration is needed for subjects.

- [ ] **Step 1: Failing tests.**
      `glob.test.ts`: `globSource('a*b') === '^a.*b$'`; `matchesGlob('*calc*', 'Intro to CALCULUS')`; `matchesGlob('a.b', 'axb') === false`; `matchesGlob('(I)*', '(I) lecture')`; `matchesGlob('*', 'two\nlines')`; `matchesGlob('braude', 'braude x') === false`.
      `colours.test.ts`: roles — google_calendar/moodle `event` → scheduled; `{kind:'event', provider:'local'}` → work; todo, issue, task, assignment, deadline, pr, message → work; `{kind:'block', layer:'block'}` → work; `{kind:'block', layer:'area'}` → area; `{kind:'travel'}` → travel. Subjects — explicit `'Algebra'` beats an earlier `*calc*` match; an explicit value that is no subject falls to patterns; first in option order wins; `*חדו"א*` matches `'הרצאה: חדו"א 1'`; `*Calculus*` matches `'calculus quiz'`; no patterns never match. Families — subject beats topic; `topicOverride` beats `topicId`; an override naming a deleted topic → gray, `from: 'unsorted'`; a topic missing from the map → gray; a Calculus lecture (event) and a Calculus block share the family with roles scheduled and work. `nextFamily([]) === 'blue'`, `nextFamily(['blue', null, 'gray']) === 'orange'`, all eight once → `'blue'`, all eight + `'blue'` → `'orange'`. `subjectsOf` — none → `[]`; a `text` attribute keyed `subject` → `[]`; option order kept; an option without a look is left out.
      `attributes.test.ts`: a `select` with looks parses; a look naming no option fails; looks on a `text` fail; two looks for one option fail; a pattern of 101 characters fails; `renames` parse on a patch.
      `Topic.test.ts`: `it('gives new topics the next unused family in sidebar order')` (defaults → blue, orange, teal; a fourth created → amber); `it('keeps a family chosen by hand and re-assigns on null')`; `it('reuses blue for the ninth topic and never picks gray')`.
      `topicColours.test.ts`: a workspace with topics (by order) `[null, 'orange', null]` → `['blue', 'orange', 'teal']`; a second run changes nothing; counts `{ topics: 2 }`.
- [ ] **Step 2: Run** the files → FAIL.
- [ ] **Step 3: Implement** `glob.ts`, `TopicRules` on it, `colours.ts`, the attribute schema, `Topic` assignment, migration `topicColours` (id `2026-11-17-topic-colours`: per workspace with a null-colour topic, its topics sorted by `order`, `createdAt`, `_id`, each null one gets `nextFamily` of the colours taken so far; raw driver like the other migrations; idempotent; returns `{ topics }`).
- [ ] **Step 4: Run** the files + `npm run test:unit` (`migrations.test.ts` lists the new id) → PASS.
- [ ] **Step 5: Gate, commit** `git commit -m "Topic colours: shared colour resolver, globs, and topic families saved on first assignment"`.

---

### Task 7: Palette tokens, the client colour module, and Settings → Topics family picker

**Files:**

- Modify: `client/src/index.css` (tokens in `:root` and `.dark`)
- Create: `client/src/features/colours/palette.ts`, `palette.test.ts`, `rowColour.ts`, `rowColour.test.ts`, `useColours.ts`, `ColourDot.tsx`, `Hatch.tsx`, `FamilySwatch.tsx`
- Create: `client/src/components/items/sourceIcons.ts`, `client/src/components/items/SourceIcon.tsx`; modify `client/src/features/landing/ProviderIcon.tsx` (imports the glyph map from `sourceIcons.ts`)
- Create: `client/src/pages/settings/general/TopicFamilyPicker.tsx`; modify `client/src/pages/settings/general/TopicsSection.tsx`
- Create: `client/src/i18n/translations/{en,he}/colours.ts` (register in both `index.ts`)
- Modify: `docs/design/DESIGN.md` (new "Topic colours" section)
- Create: `client/tests/e2e/topics/test_topic_family.py`

**Interfaces:**

- Consumes: Task 6's `ItemColour`, `ColourContext`, `resolveColour`, `subjectsOf`, `SUBJECT_ATTRIBUTE_KEY`; `useCurrentWorkspace().topics`; `useAttributes(workspaceId)`; `useUpdateTopic`.
- Produces — **the one client colour module (every block colours through it):**
  ```ts
  // palette.ts
  export function colourVar(family: ColourFamily, role: ColourRole): string; // 'var(--tc-blue-work)'
  export function inkVar(family: ColourFamily, role: 'scheduled' | 'work'): string; // 'var(--tc-blue-work-ink)'
  export interface ColourPaint {
    fill: string;
    ink: string;
    stripe: string | null;
  }
  export function paintOf(colour: Pick<ItemColour, 'family' | 'role'>): ColourPaint; // travel: stripe = scheduled var, ink = var(--foreground); area: ink = var(--foreground); scheduled/work: ink = inkVar
  export function hatchBackground(stripe: string): string; // 'repeating-linear-gradient(135deg, <stripe> 0 1.5px, transparent 1.5px 6px)'
  // rowColour.ts
  export interface ColourRow {
    kind: ColourKind;
    title: string;
    topicId: string | null;
    source: { provider: string };
    props: Record<string, unknown>;
    overlay: { topicOverride: string | null; attrs: Record<string, unknown> };
  } // ItemQueryRow satisfies it
  export function colourInputOf(row: ColourRow): ColourInput; // subject = attrs[SUBJECT_ATTRIBUTE_KEY] when a string; layer = props['layer'] when 'block' | 'area', else null
  export function colourContextOf(
    topics: readonly { id: string; colour: TopicColour | null }[],
    attributes: readonly AttributeDef[],
  ): ColourContext; // null family → gray
  // useColours.ts
  export function useColourContext(): ColourContext;
  export function useRowColours(
    rows: readonly (ColourRow & { id: string })[],
  ): (rowId: string) => ItemColour; // unknown id → { family: 'gray', role: 'work', from: 'unsorted', … }
  export function useTopicFamily(): (topicId: string | null) => ColourFamily;
  // components — each sets data-family and data-role
  export function ColourDot(p: {
    colour: Pick<ItemColour, 'family' | 'role'>;
    className?: string;
  }): JSX.Element; // 8px, aria-hidden, hatched for travel
  export function HatchPatternDefs(p: {
    idPrefix: string;
    families: readonly ColourFamily[];
  }): JSX.Element; // SVG <defs>, one <pattern id={`${idPrefix}-${family}`}> each
  export function hatchFill(idPrefix: string, family: ColourFamily): string; // `url(#${idPrefix}-${family})`
  export function FamilySwatch(p: { family: ColourFamily; className?: string }): JSX.Element; // area, travel (hatched), scheduled, work
  export function SourceIcon(p: {
    source: Provider;
    showName?: boolean;
    className?: string;
  }): JSX.Element; // brand glyph (simple-icons) in muted ink; local → lucide ListTodo; name for screen readers as SourceDot does; data-source-icon
  ```
  Tokens: `--tc-<family>-<role>` for 9 families × 4 roles, and `--tc-<family>-scheduled-ink`, `--tc-<family>-work-ink`, defined in `:root` (light) and `.dark` (dark) — 54 per theme.

**Palette (designed here, validated, recorded):**

- Scheduled steps (start from the app's tokens; already validated while writing this plan):

  | family | light     | dark      | from                                                                  |
  | ------ | --------- | --------- | --------------------------------------------------------------------- |
  | blue   | `#2a78d6` | `#3987e5` | `--chart-1`                                                           |
  | orange | `#eb6834` | `#d95926` | `--chart-2`                                                           |
  | teal   | `#1baf7a` | `#199e70` | `--chart-3`                                                           |
  | amber  | `#eda100` | `#c98500` | `--chart-4`                                                           |
  | pink   | `#e87ba4` | `#d55181` | `--chart-5`                                                           |
  | green  | `#008300` | `#008300` | `--chart-6`                                                           |
  | violet | `#6250d6` | `#9085e9` | `--chart-7`                                                           |
  | red    | `#d03b3b` | `#e05252` | `--status-critical`; dark lowered from `#ef7070` into the dark L band |
  | gray   | `#675f50` | `#b0a691` | `--muted-foreground` (Unsorted; not in the categorical runs)          |

  Validator, in `FAMILY_ASSIGN_ORDER` with the wrap (blue repeated last): light on `#fffdf9` — Lightness, Chroma, CVD (worst 9.1 amber↔teal, protan), Normal-vision (19.6) PASS; Contrast WARN for teal 2.77, amber 2.13, pink 2.65 (the relief DESIGN.md already records: the clock's legend and Now/Next labels, titles everywhere). Dark on `#1e1a14` — all PASS (CVD 8.4, normal 19.3).

- Derived steps (compute in OKLCH with a scratch script, then validate): **Work** — same hue, L −0.16 (light) / +0.12 (dark), chroma clamped to sRGB; **Travel** — chroma × 0.45, L +0.12 (light) / −0.08 (dark), drawn with 135° stripes of the Scheduled step; **Area** — the Scheduled step mixed into the card (`#fffdf9` / `#1e1a14`) at 14% (light) / 24% (dark); **inks** — for Scheduled and Work, `--foreground` or `--card` of the theme, whichever contrasts more (must be ≥ 4.5:1; if neither, move that family's Work step until one does).
- Load the `dataviz` skill (Skill tool); its base directory is printed at the top. Runs, each per theme (`--mode light --surface "#fffdf9"`, `--mode dark --surface "#1e1a14"`): (1) Scheduled steps in `FAMILY_ASSIGN_ORDER` + wrap; (2) Work steps, same order; (3) per family, `--ordinal` on `[travel, scheduled, work]` (light: light→dark; dark: in the order that is monotonic in L); (4) `contrast()` (exported by `validate_palette.js`) of each ink on its fill ≥ 4.5 and of `--foreground` on each Area ≥ 4.5. No FAIL may remain; record every run's lines verbatim in DESIGN.md's new section with the token table.

- [ ] **Step 1: Failing tests.** `palette.test.ts` (parses `src/index.css` like `components/shared/toastPalette.test.ts`): `it('defines every family × role and both inks in both themes as hex')`; `it('ink on scheduled and work fills is at least 4.5:1')`; `it('the theme ink on every area is at least 4.5:1')`; `colourVar('blue','work') === 'var(--tc-blue-work)'`; `paintOf({family:'teal', role:'travel'}).stripe === 'var(--tc-teal-scheduled)'`. `rowColour.test.ts`: `colourInputOf` reads `overlay.attrs.subject` and `props.layer` (`'area'`), ignores a numeric subject and a `layer: 'x'`; `colourContextOf` maps a null topic colour to gray and builds subjects from the `subject` select.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Palette** — compute, run the four validator runs, fix until no FAIL, write tokens and the DESIGN.md section.
- [ ] **Step 4: Module + components** (`SourceIcon` moves the brand map out of `features/landing/ProviderIcon.tsx` into `components/items/sourceIcons.ts`; landing renders exactly as before).
- [ ] **Step 5: Topics picker.** In each `TopicRow`: a `FamilySwatch` + family name; editors and owners (`canManageTopics`) get a button opening a `DropdownMenu` radio group of the nine families, each `FamilySwatch` + its name (`colours.family.<family>`); a choice calls `useUpdateTopic({ topicId, body: { colour } })`, errors toast. i18n `colours.ts`: `family.{gray…pink}`, `role.{scheduled,work,travel,area}`, `picker.{label, change}` (he: אפור, אדום, כתום, ענבר, ירוק, טורקיז, כחול, סגול, ורוד; מתוכנן, עבודה, נסיעה, אזור).
- [ ] **Step 6: E2E** `test_topic_family.py`: `test_default_topics_have_their_families` — a fresh workspace's Settings shows Work `[data-family="blue"]`, College orange, Personal teal; `test_picker_recolours_a_topic` — choose Violet for Work → `PATCH …/topics/:id` 200 → reload → violet; `test_picker_in_hebrew_and_dark` — `/he/settings`, dark theme, family names in Hebrew, no horizontal overflow at 393px.
- [ ] **Step 7: Run** unit + e2e (PASS); screenshots (Topics section with swatches, light/dark, en/he, iPhone).
- [ ] **Step 8: Gate, commit** `git commit -m "Topic colour palette, the shared client colour module, and the family picker"`.

---

### Task 8: Subjects — server (looks, renames, upsert, live match counts)

**Files:**

- Modify: `server/src/classes/workspace/AttributeDefinition.ts` (`SelectAttribute`: looks and renames rules; others refuse both)
- Create: `server/src/classes/workspace/Subjects.ts`, `Subjects.test.ts`; export from `classes/workspace/index.ts`
- Modify: `server/src/classes/workspace/Workspace.ts` (`createAttribute` / `updateAttribute` complete the Subject's looks and apply renames; new `upsertSubject`), `Workspace.attributes.test.ts`
- Modify: `server/src/models/definitions/Item.ts` + `server/src/models/mongoose/Item.ts` (`renameAttributeValue`)
- Create: `server/src/classes/item/SubjectMatches.ts`, `SubjectMatches.test.ts`
- Modify: `server/src/types/attributes.ts` (`SubjectMatchCountsSchema`), `server/src/routes/private/attributes.ts`, `server/src/controllers/attributes.ts`, `server/src/types/api-contracts.ts`
- Create: `server/src/routes/private/attributes.http.test.ts`
- Modify: `server/src/mcp/tools/items/listAttributes.ts` (output schema shows `optionLooks`)
- Docs: `docs/design/CLASSES.md` (`Subjects`, `SubjectMatches`)

**Interfaces:**

- Consumes: Task 6's `OptionLook`, `SUBJECT_ATTRIBUTE_KEY`, `nextFamily`, `subjectOf`, `subjectsOf`, `globSource`.
- Produces:
  ```ts
  // classes/workspace/Subjects.ts — value object over the Subject select's options and looks
  export interface SubjectInput { name: string; rename?: string | undefined; family?: TopicColour | undefined; patterns?: readonly string[] | undefined; attributeName?: string | undefined }
  export class Subjects {
    static of(def: AttributeDef | undefined): Subjects;
    get list(): readonly ColourSubject[];
    /** Every option without a look gets nextFamily over the topics' families and the subjects' so far, patterns []. */
    complete(topicFamilies: readonly (TopicColour | null)[]): Subjects;
    upsert(input: SubjectInput, topicFamilies: readonly (TopicColour | null)[]): Subjects; // rename, update family/patterns, or append
    toDefinition(): { options: string[]; optionLooks: OptionLook[] };
  }
  // Workspace
  async upsertSubject(caller: Caller, input: SubjectInput): Promise<ColourSubject>;
  // editor+; creates the 'subject' select on first use (name: attributeName ?? 'Subject');
  // 409 attribute_exists when 'subject' exists but is not a select; 400 past 30 options; audited attribute.create / attribute.update
  // IItemRepository
  renameAttributeValue(workspaceId: string, key: string, from: string, to: string): Promise<number>;
  // classes/item/SubjectMatches.ts
  export const SUBJECT_MATCH_SCAN_MAX = 5000;
  export class SubjectMatches {
    static async count(caller: Caller, subjects: readonly { name: string; patterns: readonly string[] }[], scanMax?: number): Promise<{ counts: number[]; capped: boolean }>;
  }
  // POST /api/private/workspaces/:wid/attributes/subject/match-counts, requireWorkspace('viewer')
  export interface SubjectMatchCountsRequestBody { subjects: { name: string; patterns: string[] }[] } // ≤ 30 subjects, ≤ 10 patterns each
  export interface SubjectMatchCountsResponseData { counts: number[]; capped: boolean }        // index-aligned with the request
  ```
  `updateAttribute` with `renames`: each `from` was an option and is not one any more, each `to` is a new option; the definition is written, then `renameAttributeValue` per pair (`select` only; 400 otherwise). `createAttribute`/`updateAttribute` on key `subject` run `Subjects.complete` before writing, so every subject is saved with a family ("saved when assigned"). `SubjectMatches.count`: the caller's visible items (`ItemPolicy.for(caller)` and `ItemQuery.effectiveStage()`, as `Item.find` reads them) whose Subject value is one of the names or whose effective title matches any pattern (`$regex` built from `globSource`, options `is`), at most `scanMax`; each is resolved with `subjectOf` against the request's order; `capped` when the scan hit the cap.

**Ruling:** Settings → Subjects has no delete in this version — why: the spec lists add, rename, reorder, family and patterns; removing an option stays possible in Settings → Attributes, as today.

- [ ] **Step 1: Failing tests.** `Subjects.test.ts`: topics `[blue, orange, teal]` → completing `['Calculus', 'Algebra']` gives amber, pink; `upsert({name:'Calculus', patterns:['*calc*']})` updates; `upsert({name:'Calc', rename:'Calculus'})` renames keeping its family; appending past 30 throws 400. `Workspace.attributes.test.ts`: creating `subject` stores looks with families; an option added through the generic PATCH gets a family; `renames` move items' values (`overlay.attrs.subject`) and leave other attributes alone; a look naming no option → 400; looks on a `rating` → 400; `upsertSubject` creates on first use then appends; on a `text` attribute keyed `subject` → 409 `attribute_exists`; a viewer → 403. `SubjectMatches.test.ts`: an explicit value counts to its subject even when an earlier subject's pattern matches; a title matching two subjects counts to the first; reversing the request order moves that count; Hebrew `*חדו"א*` counts a Hebrew title; another member's private to-do is not counted; `scanMax: 2` with 3 candidates → `capped: true`. `attributes.http.test.ts`: match-counts as a viewer → 200 `{counts, capped}`; 31 subjects → 400; a pattern of 101 characters → 400.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `Subjects`, the `AttributeDefinition` rules, `Workspace` changes, `renameAttributeValue`, `SubjectMatches`, the route, controller, contracts and the `list_attributes` output schema.
- [ ] **Step 4: Run** the files + `npm run test:unit` → PASS.
- [ ] **Step 5: Gate, commit** `git commit -m "Subjects: colour and title patterns per Subject option, renames, and live match counts"`.

---

### Task 9: Subjects — client (Settings → Subjects)

**Files:**

- Create: `client/src/pages/settings/general/SubjectsSection.tsx`, `subjectsDraft.ts`, `subjectsDraft.test.ts`
- Modify: `client/src/pages/settings/WorkspaceSettingsPage.tsx` (after `AttributesSection`, `canEdit` for editors and owners)
- Create: `client/src/api/queries/subjects.ts`; modify the attributes service module (`matchCounts`)
- Modify: `client/src/i18n/translations/{en,he}/settings.ts` (`settings.subjects.*`)
- Create: `client/tests/e2e/settings/test_subjects.py`

**Interfaces:**

- Consumes: Task 8's route and attribute schema; Task 7's `FamilySwatch`, `colours.family.*`; Task 6's `nextFamily`, `subjectsOf`.
- Produces: `subjectsDraft.ts` — `interface SubjectDraft { key: string; name: string; savedName: string | null; family: TopicColour; patterns: string[] }`; `draftOf(def: AttributeDef | undefined): SubjectDraft[]`; `addSubject(draft, name, topicFamilies): SubjectDraft[]` (family `nextFamily` preview); `moveSubject(draft, key, -1 | 1)`; `parsePatterns(text: string): string[]` (one per line or comma, trimmed, empty dropped); `requestOf(saved: AttributeDef | undefined, draft): { create: NewAttribute } | { patch: AttributePatch } | null` (null when unchanged; `renames` from `savedName !== name`). `useSubjectMatchCounts(workspaceId, subjects)` — debounced 400 ms, keyed by the names and patterns.

UI: one row per subject — name input (`dir="auto"`), family `SelectField` with `FamilySwatch`, patterns textarea (one per line, placeholder `*Calculus*`), the live count (`aria-live="polite"`, `settings.subjects.matches` plural, `capped` → "5000+"), move up/down buttons (44px on touch); "Add subject"; a Save/Discard bar for the section. Viewers see it read-only. Save: no `subject` attribute → `POST …/attributes` `{ key: 'subject', name: t('settings.subjects.attributeName'), type: 'select', options, optionLooks }`; otherwise `PATCH …/attributes/subject` `{ options, optionLooks, renames? }`. A 409 `attribute_exists` shows the existing error text and refetches.

- [ ] **Step 1: Failing tests** `subjectsDraft.test.ts`: `parsePatterns('*calc*\n, *חדו"א* ,')` → `['*calc*', '*חדו"א*']`; `addSubject` previews amber when topics hold blue/orange/teal; `requestOf(undefined, [Calculus])` → `create` with key `subject`; renaming a saved subject → `patch.renames` `[{from:'Calculus', to:'Calc'}]`; unchanged → `null`; `moveSubject` at the edge is a no-op.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** + i18n, unit tests PASS (en/he: `title`, `hint`, `add`, `name`, `family`, `patterns`, `patternsHint`, `matches_one/_other`, `capped`, `moveUp`, `moveDown`, `save`, `discard`, `saved`, `empty`, `attributeName` = Subject / נושא).
- [ ] **Step 4: E2E** `test_subjects.py`: seed "Calculus HW 1", "calculus quiz", "History essay", "תרגיל חדו\"א" via `create_local_item`; `test_add_subject_with_live_count_and_save` — Add "Calculus", pattern `*calculus*` → count 2 → Save → `POST …/attributes` 201 → reload shows Calculus with `[data-family="amber"]`; `test_reorder_and_rename` — add History `*history*` (count 1), move it above Calculus (counts unchanged), rename Calculus → Calc → Save → `PATCH` 200 with `renames`; `test_hebrew_pattern_counts_in_hebrew_ui` — `/he/settings`, add `חדו"א` with `*חדו"א*` → count 1, RTL, no overflow at 393px.
- [ ] **Step 5: Run** unit + e2e (PASS); screenshots (desktop/iPhone, en/he).
- [ ] **Step 6: Gate, commit** `git commit -m "Settings: Subjects with family, title patterns and live match counts"`.

---

### Task 10: Colours on the clock and the calendar (areas and travel included)

**Files:**

- Create: `client/src/features/dashboards/blocks/time/areas.ts`, `areas.test.ts`
- Modify: `client/src/features/dashboards/blocks/clock/clockModel.ts`, `clockModel.test.ts`, `ClockRing.tsx`, `ClockBlock.tsx`
- Create: `client/src/features/dashboards/blocks/clock/legend.ts`, `legend.test.ts`, `ClockLegend.tsx`
- Modify: `client/src/features/dashboards/blocks/calendar/calendarEvents.ts`, `calendarEvents.test.ts` (the `fc-src-moodle` assertion at line 37 changes), `CalendarBlock.tsx`
- Modify: `client/src/index.css` (drop `.fc-src-*`, lines ~597–617; add `.todolist-calendar .fc .tc-area { opacity: 1 }`, its label style, `.tc-travel { background-image: var(--tc-hatch) }`)
- Modify: `client/src/i18n/translations/{en,he}/timeBlocks.ts`
- Create: `client/tests/e2e/dashboard_time_blocks/test_topic_colours.py`

**Interfaces:**

- Consumes: Task 7's `useRowColours`, `paintOf`, `ColourDot`, `HatchPatternDefs`, `hatchFill`, `hatchBackground`, `SourceIcon`.
- Produces — **the area/travel drawing primitives (the time-blocks/travel plan only feeds rows):**
  ```ts
  // time/areas.ts
  export function splitAreas<O extends { row: { id: string } }>(
    occurrences: readonly O[],
    colourOf: (rowId: string) => ItemColour,
  ): { areas: O[]; items: O[] };
  export interface AreaGroup<O> {
    area: O | null;
    items: O[];
  }
  /** Chronological groups: each item goes under the first area (by start, then the longer) with area.start <= item.start < area.end; items outside every area form area-null groups between; an area with no items still yields its group. */
  export function nestInAreas<O extends { start: Date; end: Date | null }>(
    items: readonly O[],
    areas: readonly O[],
  ): AreaGroup<O>[];
  // clock
  export interface ClockEvent {
    id: string;
    title: string;
    start: Date;
    end: Date;
    source: Provider;
    colour?: ItemColour;
  } // no colour → the source colour (the landing demos)
  export interface ClockArea {
    id: string;
    title: string;
    start: Date;
    end: Date;
    colour: ItemColour;
  }
  // ClockRingProps gains  areas?: readonly ClockArea[]  — a thin band just outside the ring (outer → outer + max(2, 3·scale)), drawn before the arcs; travel arcs: travel fill + an overlay path filled with hatchFill
  export function buildClockModel(
    rows: readonly TimeRow[],
    now: Date,
    timeZone: string,
    colourOf?: (rowId: string) => ItemColour,
  ): ClockModel; // ClockModel gains areas: ClockArea[]; area rows are never arcs, Now or Next
  export interface LegendEntry {
    key: string;
    label: string;
    colour: ItemColour;
  }
  export function legendEntries(
    events: readonly { colour?: ItemColour }[],
    labelOf: (colour: ItemColour) => string,
    max?: number,
  ): { entries: LegendEntry[]; more: number }; // distinct family+label in first-seen order, max 6
  export function ClockLegend(p: { entries: readonly LegendEntry[]; more: number }): JSX.Element;
  // calendar
  export function toEventInput(
    item: DisplayedOccurrence,
    timeZone: string,
    colour: ItemColour,
  ): EventInput; // backgroundColor/borderColor = fill, textColor = ink; classNames tc-travel (+ fc-due); extendedProps gain family, role
  export function toAreaEventInput(
    occurrence: Occurrence,
    colour: ItemColour,
    timeZone: string,
  ): EventInput; // display 'background', backgroundColor = area fill, classNames ['tc-area'], title, extendedProps { rowId, area: true }
  ```
  `CalendarBlock`: `splitAreas` over the displayed occurrences; areas → `toAreaEventInput` (FullCalendar renders background-event titles through `eventContent`; the label sits at the top), items → `toEventInput`; `eventDidMount` sets `data-family`/`data-role` and, for travel, `el.style.setProperty('--tc-hatch', hatchBackground(stripe))`; the event content shows a small `SourceIcon` before the title. `ClockBlock`: `useRowColours(rows)`; the Now/Next and all-day lines use `ColourDot` + `SourceIcon`; `ClockLegend` under the ring, labels `subject ?? topic name ?? t('topics.unsorted')`; `describeEvent` adds the label (`timeBlocks.clock.describeEvent` gains `{{topic}}`).

**Ruling:** the area band on the clock sits just outside the ring rather than inside it — why: "under the item arcs" inside the ring would be hidden exactly where items are; outside, it stays visible and still reads as the background layer. Area and travel rows can't be made until the time-blocks/travel plan lands, so they are covered here by unit tests (`areas.test.ts`, `clockModel.test.ts`, `calendarEvents.test.ts`), and that plan's e2e checks them on screen.

- [ ] **Step 1: Failing tests.** `areas.test.ts`: `splitAreas` by role; `nestInAreas` — an item at 13:30 goes under a 13:00–17:00 area; one at exactly 17:00 does not; overlapping areas → the earlier; an empty area yields `{area, items: []}`; order is chronological. `clockModel.test.ts`: `it('turns area rows into areas, never arcs, Now or Next')`; `it('gives each arc its row colour')`. `legend.test.ts`: two Work items and one College → two entries; eight families with `max 6` → 6 + `more: 2`. `calendarEvents.test.ts`: an event takes its fill and ink and `data` props; travel has `tc-travel`; `toAreaEventInput` → `display: 'background'`, area fill, the title; no `fc-src-` class remains.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** + CSS + i18n, unit tests PASS (`clock.legend`, `clock.moreTopics`, `calendar.areaLabel`, the `describeEvent` change; en and he).
- [ ] **Step 4: E2E** `test_topic_colours.py`: a fresh workspace, a default dashboard (`create_dashboard`, which has a clock and a calendar), two local to-dos (`create_local_item` in Work and College, then `PATCH` `startAt`/`endAt` today 10:00–11:00 and 13:00–14:00 in the workspace zone); `test_clock_arcs_follow_topics` — `path[data-family="blue"][data-role="work"]` and `[data-family="orange"]` exist; the legend lists Work and College; the Now/Next line has a `[data-source-icon]`; `test_calendar_events_follow_topics` — the two `.fc-event`s carry `data-family` blue/orange and their computed `background-color` equals the resolved `--tc-blue-work`; `test_dark_and_hebrew` — dark theme resolves a different fill; `/he/` legend is RTL while the SVG keeps `direction: ltr`.
- [ ] **Step 5: Run** unit + e2e (PASS); screenshots (clock + calendar before/after, light/dark, iPhone, he).
- [ ] **Step 6: Gate, commit** `git commit -m "Clock and calendar: colour by topic and role; area bands and travel hatching"`.

---

### Task 11: Colours on the timeline, agenda, lists, deadlines, boards and charts; the source as an icon

**Files:**

- Modify: `client/src/features/dashboards/blocks/timeline/TimelineBlock.tsx`; create `timeline/TimelineAreaBand.tsx`
- Modify: `client/src/features/dashboards/blocks/agenda/AgendaBlock.tsx`; create `agenda/AgendaAreaHeader.tsx`
- Modify: `client/src/components/items/TaskRow.tsx`, `DeadlineRow.tsx`, `BoardCard.tsx`
- Modify: `client/src/features/dashboards/blocks/ListBlock.tsx`, `DeadlinesBlock.tsx`, `KanbanBlock.tsx` (cards and the drag overlay), `TableBlock.tsx` (provider column → `SourceIcon showName`)
- Create: `client/src/features/dashboards/blocks/data/segmentColor.ts`, `segmentColor.test.ts`; modify `ChartBlock.tsx`
- Modify: `client/src/i18n/translations/{en,he}/timeBlocks.ts` (`agenda.areaRange`, `timeline.areaRange`: `{{title}} {{start}}–{{end}}`)
- Create: `client/tests/e2e/dashboard_data_blocks/test_topic_colours.py`

**Interfaces:**

- Consumes: Task 7's module; Task 10's `splitAreas`, `nestInAreas`.
- Produces:

  ```ts
  TaskRowProps.colour?: ItemColour;   // ColourDot before the title; SourceIcon replaces SourceDot
  DeadlineRowProps.colour?: ItemColour; // deadline markers: the Work shade (the resolver gives work)
  BoardCardProps.colour?: ItemColour; // a 4px inline-start edge in paintOf(colour).fill (border-s-4, RTL-safe); SourceIcon replaces SourceDot
  export function TimelineAreaBand(p: { title: string; start: Date; end: Date; colour: ItemColour; timeZone: string; locale: string; children: ReactNode }): JSX.Element; // area tint behind its items, label at the top
  export function AgendaAreaHeader(p: { title: string; start: Date; end: Date; colour: ItemColour; timeZone: string; locale: string }): JSX.Element; // "Studying 13:00–17:00"
  export function segmentColor(segment: Segment, index: number, topicFamily: (topicId: string | null) => ColourFamily): string; // field 'topic' → colourVar(family, 'scheduled'), Unsorted (null or '') → gray; a provider → its source colour (unchanged); else chart slots
  ```

  Timeline and agenda: `splitAreas`, then `nestInAreas` per day (timeline) and per agenda part (an area header appears in each part that holds its items; an area with no items is listed in the part where it starts). Travel rows get a hatched `ColourDot`. `ToneRow`'s display-rule edge stays outside the card; the topic edge is the card's own.

- [ ] **Step 1: Failing tests** `segmentColor.test.ts`: topic segment of Work (blue) → `var(--tc-blue-scheduled)`; Unsorted → `var(--tc-gray-scheduled)`; a provider segment → `var(--color-source-jira)`; a status segment → `var(--chart-1)` for index 0. Extend `agendaModel.test.ts` only if `buildAgenda` changes (areas are split off before it).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the components, the views' area split and the chart colour + i18n; unit tests PASS.
- [ ] **Step 4: E2E** `test_topic_colours.py` (to-dos in Work and College; list and kanban blocks added with `apply_ops`, the default dashboard's chart regrouped by `topic` with an `update_block` op): list rows carry `[data-family]` dots per topic and `[data-source-icon="local"]`; kanban cards have the start edge colour (`border-inline-start-color` equals the resolved token) and, in `/he/`, the edge is on the right; chart segments grouped by topic fill with the Scheduled tokens; timeline and agenda rows have dots; deadlines rows use `[data-role="work"]`.
- [ ] **Step 5: Run** unit + e2e (PASS); screenshots (each block before/after, iPhone, he, dark).
- [ ] **Step 6: Gate, commit** `git commit -m "Lists, boards, timeline, agenda, deadlines and charts: topic colours; the source as an icon"`.

---

### Task 12: MCP tools — `set_topic_colour`, `set_file_under`, `set_subject`

**Files:**

- Create: `server/src/mcp/tools/workspace/setTopicColour.ts`, `server/src/mcp/tools/workspace/setFileUnder.ts`, `server/src/mcp/tools/items/setSubject.ts`
- Modify: `server/src/mcp/tools/workspace/index.ts` (after `workspaceRemoveMember`), `server/src/mcp/tools/items/index.ts` (after `setItemAttributes`)
- Test: `server/src/mcp/__tests__/contract.test.ts` (`MCP_TABLE`), `http.test.ts` (`CATALOG` + calls), `itemTools.test.ts`, `roleMatrix.test.ts` (if it lists tools)
- Docs: `docs/dashboard/MCP.md` §7.2 and §7.5 tables (the contract test says "exactly the tools of MCP.md")

**Interfaces:**

- Consumes: `TopicRef`, `topicIdOf` (`server/src/mcp/tools/itemViews.ts:185,216`), `toolCaller` (`mcp/auth/principal.ts`), `defineTool`; Task 6/7's `TOPIC_COLOURS`; Task 4's `Integration#fileUnder`, `Integration#fileContainerUnder`; Task 8's `Workspace#upsertSubject`.
- Produces:
  ```ts
  set_topic_colour — toolset 'workspace', scopes ['workspace:share'], minRole 'owner'
    input  { topic: TopicRef; family: z.enum(TOPIC_COLOURS) }
    output { topic: { id: string; slug: string; name: string; family: TopicColour } }
    handler: Topic.update(toolCaller(ctx), topicId, { colour: family })
  set_file_under — toolset 'workspace', scopes ['workspace:share'], minRole 'owner'
    input  { integrationId: string; containerId?: string; topic: TopicRef | null }   // null: Unsorted for a connection; "same as the connection" for a container
    output { integrationId: string; containerId: string | null; topicId: string | null; rule: { match: string; topicId: string } | null; refiled: { containers: number; items: number } }
    handler: containerId ? integration.fileContainerUnder(...) : integration.fileUnder(...); the key's member's own integration only (another's is the plain 404 tool error)
  set_subject — toolset 'items', scopes ['items:write'], minRole 'editor'
    input  { name: string(1–40); rename?: string; family?: z.enum(TOPIC_COLOURS); patterns?: string[] (≤ 10, each 1–100) }
    output { subject: { name: string; family: TopicColour; patterns: string[] }; created: boolean }
    handler: workspace.upsertSubject(toolCaller(ctx), input)
  annotations (all three): readOnlyHint false, destructiveHint false, idempotentHint true, openWorldHint false
  ```
  Descriptions are the static contract (what the tool does and returns, never instructions), as the existing tools word them; `set_file_under` says items move at once and a topic set by hand on an item is kept.

**Ruling:** `set_topic_colour` is owner-only although the app lets editors recolour a topic — why: the owner ruled "Topic/File-under tools: scope `workspace:share`, owner only" (spec: "like the same settings in the app"). The agent plugin (`agent-plugin/`) has no tool list (its skills name tools only in passing), so only MCP.md changes.

- [ ] **Step 1: Failing tests.** `contract.test.ts`: three `MCP_TABLE` rows with the scopes/roles above. `http.test.ts`: add `set_topic_colour`, `set_file_under` to `CATALOG`; an owner key (`workspace:read`, `workspace:share`) recolours `work` to violet (the topic is violet after); an editor key does not list either tool; `set_file_under` with a container → the rule is first in `settings.topicRules` and `refiled.items` > 0; with another member's integration → the 404 tool error text; `topic: 'nope'` → "Unknown topic". `itemTools.test.ts`: `set_subject` by an editor creates the attribute (`created: true`), a second call with `patterns` updates it (`created: false`), `rename` moves item values; a viewer key does not list it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the tools and the indexes; update MCP.md.
- [ ] **Step 4: Run** the MCP tests + `npm run test:unit` → PASS; `npm run mcp:smoke` if the local API is up.
- [ ] **Step 5: Gate, commit** `git commit -m "MCP: set_topic_colour, set_file_under and set_subject"`.

---

## For the time-blocks and travel plan (interfaces it must consume)

- **Colour resolver** (`server/src/types/colours.ts`, Task 6): `resolveColour(input: ColourInput, context: ColourContext): ItemColour`, `roleOf`, `subjectOf`, `subjectsOf`, `nextFamily`. `ColourInput.kind` is `ColourKind = ItemKind | 'block' | 'travel'` (compiles before and after `ITEM_KINDS` gains them); `ColourInput.layer: 'block' | 'area' | null`. The client adapter `colourInputOf(row)` (Task 7, `client/src/features/colours/rowColour.ts`) reads the layer from `row.props['layer']` and the subject from `row.overlay.attrs['subject']`; if that plan stores the layer elsewhere, only `colourInputOf` changes. Roles: `kind 'block'` + `layer 'area'` → area; `kind 'block'` → work; `kind 'travel'` → travel.
- **Subjects** (Task 8): `SUBJECT_ATTRIBUTE_KEY = 'subject'`; `Workspace#upsertSubject(caller, { name, family?, patterns?, rename?, attributeName? })` creates the Subject select on first use and gives a new subject its family — the block form's "typing a new subject" and `create_time_block`'s `subject` call it.
- **Drawing primitives** (Tasks 10–11): views already split rows by role, so area and travel rows draw correctly the moment they arrive. `splitAreas`, `nestInAreas` (`blocks/time/areas.ts`); calendar `toAreaEventInput(occurrence, colour, timeZone)` and `toEventInput(item, timeZone, colour)` (travel → `tc-travel` + `--tc-hatch`); clock `ClockRingProps.areas: ClockArea[]` (`{ id, title, start, end, colour }`), travel arcs hatched via `HatchPatternDefs` / `hatchFill(idPrefix, family)`; `TimelineAreaBand` (`{ title, start, end, colour, timeZone, locale, children }`); `AgendaAreaHeader` (`{ title, start, end, colour, timeZone, locale }`); `ColourDot` (hatched for travel); `paintOf`, `colourVar`, `hatchBackground`.
- **Scheduled tick** (Task 3, `server/src/jobs/scheduledTick.ts`): `interface AfterDispatchPass { readonly name: string; run(now: Date): Promise<Record<string, number>> }`; add `new TravelHorizonPass()` (a class that `implements AfterDispatchPass`, "at most once a day per workspace" is its own rule) to `AFTER_DISPATCH_PASSES` and update the test `it('has no after-dispatch passes yet')`. It runs after `dispatchAllSyncs('schedule')` on every hourly `{action: 'sync-dispatch'}`; a throwing pass is recorded as `{ failed: true }` and never fails the tick.
