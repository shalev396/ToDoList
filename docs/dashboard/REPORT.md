# REPORT: TodoList build (history of the first build; nothing deployed or pushed)

> This is a history note. It describes the first, offline build as it was. The offline mode, the Apps Script bridge, the queues, workers and schedules were removed afterwards (see `DECISIONS.md`); the README and the other docs describe the current product.

The first build was on branch `local/dashboard` (now `dev`), built on a template import of Elytra `main@e382dc5` (see DECISIONS.md D1). The build plan was a process document and is no longer kept. Decisions and build rulings are in `DECISIONS.md`, the deploy steps (none executed) in `DEPLOY-PLAN.md`.

## The OOP redesign (2026-11-14 to 2026-11-16)

After the first build the server was reshaped, phase by phase, into a set of classes (plan: `.superpowers/sdd/2026-11-14-oop-redesign/plan.md`; the class reference is [`docs/design/CLASSES.md`](../design/CLASSES.md); the decisions are D20 to D27 in `DECISIONS.md`). What it delivered, in one place:

- **Classes are the only database access.** `services/*`, `sync/runSync.ts`, `gcal/plan.ts` and `gcal/commit.ts` moved behind `Integration`, `Workspace`, the `Item` hierarchy, `Dashboard`, `View`, `SyncRun`/`SyncEngine`, `Calendar`/`PushPlan`/`PushCommit`, `AgentKey` and the rest. The list of modules still touching the database (42 at the start) is gone; a test holds the boundary with no exceptions.
- **The read-only gate and write-back.** Every provider connection starts read-only; one choke point (`Integration#withWriteSession`) guards every write. A read-and-write integration writes a mirrored item's provider fields back (item sheet and MCP `update_todo`); TodoList-only fields are overlay overrides.
- **One primary calendar per workspace**, a fixed push rule, a planned date, and clean-ups that never touch what TodoList did not add; event claims keep a TodoList delete from being read as the user's.
- **Topics replace the fixed areas**, and dashboards and topics are deleted with their workspace.
- **MCP sign-in (OAuth)** for agents next to keys, built by a parallel session (`AgentKey`, `McpClient`, `McpAuthorization`).
- **Tests at the end of phase 7a:** server unit 3234, infra 163, client unit 694, 282 browser tests collected. The gate tests (class boundary, write paths, read-only, vault and adapter secrets, sync and dashboard internals, the golden `DocCheck`) are listed in CLASSES.md section 9.

**Known limitations** (stated plainly, none is a regression):

- A calendar move whose DELETE half gets no answer (or a 429) leaves the old event in Google, untracked: the move's create half re-points the item's one link, so neither a push nor "Remove" sees the old event again; only "Also remove" at disconnect clears it. Backlog (R3-M2): leave the row on the old calendar until the delete half succeeded.
- PERMISSIONS-V2 ruling 12, case F (a move's claim on the old calendar no longer exists after the move, so another integration adopting that event in the same moments can read the move's delete as the user's).
- `McpClient.register` is not audited: client registrations belong to no workspace.
- `Integration.removeAllIn` has no live-workspace guard on purpose: the cascade runs it before the workspace is retired, to destroy credentials first, and it is pinned by class to the cascade.
- `Dashboard#blocks(caller)` has no production caller yet.
- The purge runs only when invoked directly. There are no schedules, by design (an infra test asserts it: `server/infra/test/sync.test.ts` counts `AWS::Scheduler::Schedule` at 0), so the 30-day hard delete and the orphan sweeps happen only when someone runs it.
- Descriptions are never written back to trackers, on purpose (only a preview is stored; D21).
- Postman has no coverage of the newer routes (`PATCH …/integrations/:iid {mode}`, the primary calendar, `?removeAdded`, `remove-pushed`); the collection was not touched.
- Plan elements not built, and the three classes still over about 900 lines: see DECISIONS D28.
- The persona dry run can reveal that another member's private topic page exists. It cannot be reached today, because no route makes a dashboard private.

## What was built

| Phase | Delivered |
|---|---|
| 0. Local foundation | Template import and TodoList rename. Offline runtime (`ENV=local`, `AUTH_MODE=local-dev`, local S3/SES/KMS/queue stand-ins). Env files (`setup:local`, `env:check`). Redacting logger, response secret guard, 4-arg error handler, pre-commit secret scan. |
| 1. Data and organizations | 16 workspace-scoped collections with DATA.md §6 indexes and validators (`sync-db`). Organizations: create, invite by link, roles, areaScope, leave, delete, limits. Credential vault (KMS envelope, AES-256-GCM, AAD-bound) with only `decryptForSync`/`decryptForHook` able to decrypt. Demo seed (`seed --owner`, onboarding's "Load demo data"). |
| 2. API and Logic Bridge | zod block, query and op schemas shared with the client. Query compiler (whitelisted fields, base filter always first, DST-correct presets). Dashboard ops, versions (undo, redo, revert, publish), lint and templates. REST for items, facets, integrations (write-only credentials, test connection, disconnect), sync, agent keys, views and builder. Secret-leak suite over all 77 routes. |
| 3. Sync | Read-only client (GET plus allow-listed GraphQL queries plus the exact Google token exchange). SSRF guards: netGuard, per-hop redirect checks, connect-time IP check. Fixture transport with relative dates. Engine: per-resource sweep with window, delete-only records, per-record validation, orphan sweep, run hygiene and reaper. Adapters: Jira, ClickUp, Linear, Moodle, Google Drive, Google Calendar, GitHub (repos, issues/PRs, Projects v2 boards). Dispatcher, worker, purge, `sync:local`. |
| 4. Frontend | New design system (DESIGN.md). Landing, pricing and legal pages. Auth, onboarding and invites. App shell with org switcher and ⌘K. Org settings and members. Dashboard runtime (grid, page vars, autosave with conflict recovery, RTL). All 12 block types. Item sheet. Block editor with live preview. Integrations, templates and agent-keys pages. en and he throughout. |
| 5. Google Calendar bridge | Signed envelope, public hooks, diff/commit with CalendarLinks, the Apps Script client (gated by `GCAL_BRIDGE_ENABLED`; locally only the mock on :3999), `gcal-sync` dry run, the mock, and `apps-script/Code.gs` with its README. |
| 6. MCP | v2 SDK, stateless JSON on `/api/mcp` and `/api/mcp/readonly`, plus stdio. `elk_` agent keys, scopes ∩ role, limits, redaction, audit and confirm. 48 tools (read, items, sync, integrations, workspace, builder) with D12 preview-before-write. 9 `todolist://` resources and 5 prompts. |
| 7. Infra and docs | CDK KMS per stage, SQS + DLQ + worker, no schedules (the sync, gcal and purge functions are invoked directly), `/api/mcp` routes without the JWT authorizer, CI workflows (inert until pushed). DECISIONS, DEPLOY-PLAN and this report. |

## Run it

The original build ran fully offline (a fake-login server, a seed command, an Apps Script mock). That mode, the Apps Script bridge, the queues and the schedules are all gone; the sections below are the history of that first build. To run the app now, see the README: fill `server/.env.<stage>`, deploy a stage, then `npm run dev` in `server/` against it and `npm run dev` in `client/`. Why each piece was removed and what replaced it is in `DECISIONS.md` (C0-A to C0-D entries).

## Tests

Commands and counts are from that build. Today `npm run test:unit` runs every server suite, the secret-leak, MCP and Google Calendar tests included.

| Suite | Command | Result |
|---|---|---|
| Server unit (incl. secret-leak suite) | `cd server && npm run test:unit` | 2144/2144 |
| Secret-leak suite | `npm run test:secrets` | 10/10 (77 routes, 325 responses, DB + logs scanned) |
| Calendar bridge | `npm run test:gcal-bridge` | 71/71 |
| MCP | `npm run test:mcp` | 212/212 |
| Infra (offline synth, 3 stages) | `npm run test:infra` | 126/126 |
| Server build + lint | `npm run build && npm run lint` | clean |
| Client unit | `cd client && npm run test:unit` | 416/416 |
| Client lint + build | `npm run lint && npm run build` | clean |
| Repo secret scan | `npm run secrets:scan` (root) | 1309 files clean |
| E2E (Python Playwright) | `cd client && npm test` (see `client/tests`) | Run per suite during the build: dashboard suites 51/52 (one keyboard-focus flake), frame suites 101, controls, data and time blocks, editor and integrations all green |

Known flaky tests (parked): `dashboard_grid::test_block_menu_moves_with_the_keyboard_and_returns_focus` under 4 workers; `organizations.http.test` and `organizations.cascade.test` under heavy machine load; MCP `list_deadlines` when a run crosses local midnight.

## Spec deltas (changes vs the 9 design docs)

- **Organizations (multi-user).**
  - The API keeps `Workspaces`/`Memberships`; the UI says "Organization".
  - Invites carry a hashed token with a 7-day expiry. Locally the link is shown once in the UI.
  - Limits: 5 orgs created per user, 25 members and 20 integrations per org, 10 agent keys per user, manual sync once per 5 min. Invite-email limits are counted from AuditLogs.
  - Account deletion cascades.
  - The `allowAgentPublish` org setting gates agent publishing.
- **GitHub connection.**
  - One integration per owner (`accountId` = owner login).
  - Repos, issues/PRs and Projects v2 boards, with boards owning the board-linked items.
  - `projectsToken` is optional. `config.boards.enabled` follows the test capability.
  - The `<login>/*` → personal rule is lowercased and appended atomically, for user owners only.
- **Environments.**
  - `ENV=local` + `AUTH_MODE=local-dev` work offline; local-dev is refused elsewhere.
  - `LOCAL_API_PORT` / `API_PROXY_TARGET` are dev-only port overrides.
- **Sync engine** (the contract is in `.superpowers` T3.2 report §2):
  - `Items`/`Containers.syncResource` give a per-resource sweep with an optional `window`.
  - Delete-only records `{externalId, deleted: true}`.
  - Per-record `invalid_record`, plus an orphaned-resource sweep and `listing_too_large`.
  - Failures carry the prefixed `externalId`.
  - Redeliveries are counted once.
  - A stale-run reaper runs.
  - The dispatcher skips `auth_failed`/`paused`/`expired` and integrations with no credential.
  - Fixture-mode syncs skip throttles.
- **Items.**
  - `idempotencyKey` is unique per owner, permanently (partial unique index).
  - Mirrored edits return 409 with `openIn`.
  - `overlay.areaOverride` respects areaScope.
- **Integrations.**
  - Internal statuses are active/expiring/expired/error/paused, shown as the 6-key public shape.
  - `credential_missing`.
  - A config read route.
  - `expiresAt` is set via PATCH and cleared on rotation.
  - Test connection: one try, 10 s, 5 per minute.
  - netGuard (SSRF).
  - The vault treats `email`/`clientEmail`/`kid`/`kidNext` as labels, not secrets.
- **Google Calendar.**
  - Item ids are `<calendarId>:<eventId>`.
  - Cancelled occurrences of a series stay live as `cancelled`; the client excludes them.
- **Apps Script bridge.**
  - New setup order: secret → deploy web app → paste `/exec` → one PUT `{execUrl, sharedSecret, kid}` → run `setup()`.
  - Rotation is a full re-PUT; there is no `sharedSecretNext`.
  - Renamed to `origin: "todolist"`, `todolistItemId`, `todolistWs`.
  - With the flag off, hooks answer `{"ok":false}` and Apps Script connect is refused.
- **Dashboards.**
  - `scope.groupVar` is required on group pages.
  - Group templates need `scope.area`.
  - Publish takes `expectedVersion`.
  - Text lint covers badges and free-string viz.
  - The fileTree reads file items (`props.path`).
  - The undo guard pins whole array elements.
  - "Use template" opens the created dashboard (`?dashboard=<id>`).
- **Errors.** `{message, code?}` with a shared `ERROR_CODES` list. The client maps codes to en/he text, and 5xx responses are always generic.
- **MCP.**
  - D12 previews are bound to the draft version.
  - `builder_preview` takes §8.4 input (`sampleRows`, optional `expectedVersion`).
  - `dryRun` on create/undo/publish.
  - Area filters on `list_facets`/`query_items`.
  - Connect links: single use, 10 minutes, consume endpoint.
  - URL elicitation is not wired yet; the link is returned in the result.

## Parked items (for later)

- **Sync**
  - Jira custom-field ids are fixed (10020/10016/10014), with no config override.
  - ClickUp/Linear full listings are unbounded.
  - The Calendar push is capped at 200 items, and there are no deletes on truncation.
  - Moodle makes one submission-status call per assignment (1 s each).
  - `EXDATE`/`RDATE` in recurrence are ignored.
  - The reaper doesn't bump `consecutiveErrors`.
  - `softDeleteBySource` is scoped by account rather than integration id.
- **Product**
  - Google-native event edits: a read-and-write Google Calendar integration now writes title and start/end back (phase 2b); everything else a Google event carries stays read-only.
  - The calendar picker takes ids as text.
  - Cross-integration duplicates: a personal board card linking an org issue.
  - The counter `showDelta` has no data source.
  - Org-wide undo can refuse more often than needed, by design.
- **Client**
  - The vendor chunk grew 41 kB.
  - zod resolves from `server/node_modules`, giving two typed copies.
- **Docs.** `openapi.yaml` and the Postman collection don't cover the new routes.
- **Races accepted under the no-transactions ruling:** caps, rate limits, the idempotent replay of a soft-deleted item, the invite seats.

## Open questions (defaults applied)

- **OVERVIEW §6:**
  - Moodle tokens per school.
  - Sync cadence (default 08:00 and 18:00 plus manual).
  - Purge on disconnect (default: soft-delete, then hard purge after 30 days).
- **Can editors connect their own sources in a shared org?** Default: owners only.
- **Drive access for other users.** Default: a user-shared service account. Alternatives: an app-wide service account, or an Apps Script Drive relay.
- **DLQ alarm destination (SNS).** You pick it at deploy time.
- **Local test data:** resolved. The stray test org isn't in your current DB.
