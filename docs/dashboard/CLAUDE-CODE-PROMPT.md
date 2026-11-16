# CLAUDE-CODE-PROMPT.md — master prompt: build Shalev's personal management dashboard

> The original build brief, kept current with the code. The repo now exists on the `dev` branch (built on Elytra); where this brief and `DECISIONS.md` disagree, `DECISIONS.md` wins. There is no local/offline mode: the local API runs against a deployed stage.

---

## 0. Ground rules (read twice, follow always)

1. **Build on the `dev` branch for Shalev's review.** Do not deploy anything: no `cdk deploy`, no `npm run deploy:*`, no `reset-db`/`sync-db` against a deployed stage, no changes in any AWS account.
2. **No pushes, no PRs, no remote changes without Shalev's explicit approval, each time.** Work on the `dev` branch. Commit in small, reviewable steps.
3. **Never print secrets.** Don't `cat` env files, `echo` keys, log request bodies on credential routes, or paste tokens into chat, screenshots or test snapshots. Use fake fixture tokens only (`FAKE-<provider>`). Real tokens are typed by Shalev into the running UI, which stores them encrypted.
4. **Never write to providers** (Jira, ClickUp, Linear, Moodle, GitHub). The one exception is the Google Calendar OAuth two-way sync (audit-logged).
5. When a doc is ambiguous, pick the option the docs recommend, write it down in `docs/dashboard/DECISIONS.md`, and keep going. Stop and ask only for things that need Shalev (credentials, deploys, pushes, paid services).
6. Reuse Elytra. Don't rebuild what exists (auth, layout, API envelope, CDK, tests, i18n, theme).

---

## 1. The need

Shalev wants **one personal management dashboard** that covers his whole week:

| Area | Sources (sources of truth) |
|---|---|
| **Time** | Personal Google Calendar (plus the calendars it already aggregates) |
| **Work** | Jira (AutoDS), ClickUp (Roonga, Parkbooker) |
| **College** (Braude) | Moodle (courses, assignments, deadlines; coming soon) |
| **Personal** | Linear (personal workspace), GitHub `shalev396/*` repos (optional) |

After login he lands on a **Dashboard** (24h clock, donut of open items by source, week calendar, deadlines soonest first) and can open topic dashboards (**Work**, **Personal**, **College**, or his own). He must be able to **build and rearrange these pages himself** from pre-built blocks with no code, and AI agents (Grok Bot "Remi", Claude, Cursor) must be able to read the data and **build pages for him conversationally** through MCP. A **"Sync to Google Calendar"** button pushes dated items to his personal calendar.

## 2. What was tried before, and why it fell short

The current setup is a **Notion workspace mirror** maintained by an assistant (see `notion-dashboard/README.md` in Remi's workspace for the full history):
- **Charts limited / paywalled:** Notion's free plan allows one chart; chart grouping is capped; synced views and automation are limited.
- **No real clock or calendar embeds** without hacks (a separate web app iframe that breaks in Notion apps/Safari/Brave when access is "Only myself").
- **Too much hard-coded text:** headings, labels and helper copy baked into pages went stale; every change meant re-editing pages.
- **Manual layout steps:** the API can't set a calendar to Week layout, arrange views or build dashboards — every page needed manual clicks after each rebuild.
- Twice-daily scripted syncs into Notion databases with no real data model, no versioning and no safe way for an agent to build pages.

## 3. Why this architecture

| Decision | Why |
|---|---|
| **Elytra as the base** | Shalev's own repo, already React 19 + Vite + shadcn + Tailwind v4, Express 5 on one AWS Lambda, Cognito auth, Mongoose/Sequelize switch, CDK stages dev/qa/prod, CI, Playwright tests. Reuse all of it. |
| **MongoDB (Mongoose, Atlas)** | Heterogeneous items (issues, tasks, events, assignments, files) fit one polymorphic `Items` collection with per-kind `props`; Elytra already supports `mongodb+srv://` with Lambda-tuned pooling and IAM auth. |
| **Serverless Lambda via the existing CDK** | No servers to run; the stack stays one Lambda function with one role (plus a KMS key); no queues, workers or schedules. AWS first. |
| **Google OAuth for Calendar** | A separate Google app (closed beta on dev and QA, verification only for prod), PKCE, refresh token sealed in the vault. The earlier Apps Script bridge was removed. |
| **Long-lived tokens** | Linear personal API key, ClickUp `pk_` token, Jira API token (≤365 days), Moodle web service token: no OAuth dance, set-and-forget, encrypted at rest. |
| **MCP for AI agents** | One standard interface so any agent can query the dashboard and build pages, without ever seeing a credential. |
| **Builder as a Logic Bridge** | One shared module (schema, compiler, ops, lint) used by both the UI editor and MCP tools, so a page an agent builds is the same JSON a human edits. |
| **Mixpanel-style composition** | Every data block is source → filters → group-by → aggregate → visualization, from pre-built primitives. Users and agents compose; nobody writes code. |

## 4. Read these first (in order)

All in `docs/dashboard/` (from `dashboard-design.zip`):

1. `OVERVIEW.md` — architecture diagram, data flows, all constraints, doc map, open questions.
2. `DATA.md` — collections, indexes, access control, token encryption, provider mapping. **Wins on any naming conflict.**
3. `BACKEND.md` — Lambda architecture, routes (`/query`, `/gcal-sync`, agent keys), sync jobs, token handling, rate limits.
4. `FRONTEND.md` — routes/pages, libraries, block JSON, composition model, editor, Sync-to-GCal UI, a11y, mobile.
5. `BUILDER.md` — Logic Bridge modules, block catalog, primitives, templates, versioning/dry-run. **Wins on block schema.**
6. `MCP.md` — MCP primer, transport, agent keys, privacy rules, tool catalog. **Wins on tool names.**
7. `CODE-AGENT-GUIDE.md` — stage-backed run, env vars, demo data, tests, and the competitor UI review pass you must run.

Target file structure (additions to Elytra; details in each doc):

```
docs/dashboard/                      # the 9 design docs + DECISIONS.md (yours)
client/src/features/
  dashboards/   DashboardPage DashboardGrid BlockFrame BlockEditorSheet registry blocks/ variables/
  items/        ItemSheet SourceLink SourcePreview
  integrations/ IntegrationsPage ConnectionCard SecretField SyncGCalButton SyncStatus
  templates/    TemplateGallery
client/src/api/queries/              dashboards blocks items integrations sync
server/src/
  models/definitions|mongoose/       Workspace Membership Invite Integration Credential Item Container
                                     SyncState SyncRun AuditLog Dashboard DashboardVersion View
                                     AgentKey CalendarLink ReplayNonce
  routes/private/                    workspaces items dashboards views query integrations sync agentKeys
  builder/                           schema catalog compile ops templates lint (Logic Bridge)
  classes/integration/Credential.ts  the only encrypt and decrypt path
  services/logger.ts                 redacting logger
  services/areaRules.ts
  sync/                              dispatcher worker (runs one job) http providers/{gcal,jira,clickup,linear,moodle,github}
  gcal/                              Google Calendar OAuth push and pull
  mcp/                               index stdio registry auth/ middleware/ tools/ resources/ prompts/
server/src/seed/                     demo data (loaded with loadDemoData on dev and qa)
server/infra/lib/constructs/         kms.ts (and the single function)
```

## 5. Libraries (use these; don't add alternatives without writing why in DECISIONS.md)

| Need | Library |
|---|---|
| Dashboard grid (drag/resize, breakpoints) | **react-grid-layout v2** |
| In-block drag (kanban, list reorder) | **dnd-kit** |
| Charts (donut, bar, line, number) | **shadcn `chart` (Recharts v3)**, themed via `--chart-*`; **Apache ECharts** only as a fallback for heavy/exotic charts |
| 24h clock | Custom SVG with `d3-shape` arcs + now-needle |
| Calendar | **FullCalendar Standard** (`@fullcalendar/react`, `timeGridWeek` default, rrule plugin) |
| Filters / conditions UI | **react-querybuilder** (shadcn build); backend compiles its JSON against a field whitelist |
| Tables | **TanStack Table** + shadcn `data-table` |
| Rich text (note block, optional, later phase) | **Plate** |
| Logic canvas (phase 2+, if/then rules only) | **React Flow** (`@xyflow/react`) |
| Server data | TanStack Query (existing); Redux Toolkit `editor` slice for the edit draft |
| Validation / schemas | zod → JSON Schema; Ajv 2020-12; JSON Patch (RFC 6902) |
| MongoDB | **Mongoose 8** (existing Elytra provider) |
| MCP | **MCP TypeScript SDK** (`@modelcontextprotocol/sdk`), Streamable HTTP at `/api/mcp`; MCP Inspector for tests |
| Crypto | AWS KMS (`@aws-sdk/client-kms`) + Node `crypto` AES-256-GCM; KMS only |
| Provider clients | `@linear/sdk`, `jira.js` (or plain REST), plain REST for ClickUp/Moodle |
| Existing UI stack | shadcn/ui, Radix, Tailwind v4, lucide-react, sonner, i18next (`en`, `he` RTL) |

## 6. UI vision

- **Notion-like, but truly customizable:** clean cards on a 12-column grid, generous whitespace, one accent color per source, light/dark parity, no clutter. It should look better than the Notion setup it replaces.
- **Dashboard defaults** (from templates, all editable): **24h clock** ring of today's events with a **now-needle** and "now / next"; **donut of open items by source** with Work/College/Personal chips and a total; **calendar defaulting to Week** (Month toggle, saved per block); **deadlines, soonest first**, overdue on top.
- **Topic pages:** Work (grouped by project, provider filter, AutoDS included), Personal (Linear + `shalev396/*`), College (course list → course page with deadlines; all-course deadlines at the bottom).
- **Edit mode** toggle: drag/resize blocks, "Add block" opens the 4-step pipeline editor with a **live preview** (`POST /workspaces/:wid/query` with `draft` + `vars` + `preview:true`).
- Cross-block filters: clicking a donut slice filters the calendar and deadlines (`$page.*` vars, mirrored in the URL).
- Every row has **"Open in <provider>"**; mirrored items are read-only, local to-dos edit inline.
- Accessible (keyboard grid editing, chart data tables, AA contrast), responsive (single column on mobile), Hebrew RTL.

## 7. Privacy and product rules (non-negotiable)

- **Tokens encrypted at rest** (KMS envelope + AES-256-GCM, AAD-bound) in `Credentials` only.
- **Tokens never returned** to the user, UI, logs, errors, exports or agents **in any form** — no masked hint, no last-4, no prefix. Integration status = `{id, provider, accountLabel, status: connected|expired|error, expiresAt, lastSyncAt}`.
- Secret inputs are write-only (`PUT …/integrations/:iid/credential` → `204`), never stored in Redux/React Query/localStorage/URL.
- Only the `Credential` class decrypts, through an `Integration`'s sessions; a test fails if anything else (including `server/src/mcp/**`) imports it.
- Redacting logger, response scrubber for token patterns (`pk_`, `lin_api_`, `ATATT`, `xox`, `ghp_`, `github_pat_`, `elk_`, JWTs), sanitized provider errors.
- Agent keys (`elk_…`) are shown once and stored only as SHA-256 hashes (`AgentKeys`).
- **One-way mirror** into the app; the **only** exception is the audit-logged two-way sync with Google Calendar through OAuth.
- **Minimal hard-coded text:** titles and filenames only; everything else from data, facets or i18n keys.
- **AutoDS is included** in every view and API/MCP result (the mute applies only to Remi's own chat messages).
- **Personal vs Work by project name** (`shalev396/*` → Personal); **College** from Moodle. Rules are data (`settings.areaRules`).
- **Slack is out of scope** for the app (agents use Slack via their own MCP).

## 8. Phased plan with acceptance criteria

Work phase by phase. At the end of each phase: all tests green, a short report to Shalev (what changed, screenshots, how to run), local commits only.

| Phase | Build | Acceptance criteria |
|---|---|---|
| **0. Foundation** | Clone, `dev` branch, `.env.example` placeholders (the 8 variables), the secret scan in the pre-commit hook. | `npm run dev` (against a deployed stage) + client on :5173; `git grep` finds no secrets. |
| **1. Data model** | All DATA.md collections (Mongoose, UUID ids), `sync-db` (indexes + `$jsonSchema`), `requireWorkspace` middleware, `CredentialVault` over KMS, demo data (fake data incl. AutoDS project and `shalev396/Elytra`). | Index list matches DATA.md §6; repository test proves every query is workspace-scoped; `JSON.stringify(credential)` has no `enc`. |
| **2. Backend API + Logic Bridge** | Workspaces/members/invites, items (local CRUD, mirrored `409`), facets, dashboards/views/ops/versions, `POST /workspaces/:wid/query` (saved id **or** draft + `vars` + `preview`), integrations (status shape only) + write-only credential route, agent keys. | Postman/unit tests pass; **secret-leak suite** green (no token pattern in any response/log); `/query` rejects non-whitelisted fields and `$where`; version conflicts return `409`. |
| **3. Sync (fixtures in tests)** | Sync job runner (an async self-invoke of the one function), provider mappers for Jira, ClickUp, Linear, Moodle, GitHub; area rules; `SyncStates`/`SyncRuns`. | Fixture sync upserts deterministically; second run is a no-op; deleted-at-source items get `deletedAt`; no non-GET requests leave a sync job; every item has `source.url`. |
| **4. Frontend dashboards** | Routes, grid, block registry, blocks (list, table, deadlines, calendar, donut/chart, counter, clock, filter, action), editor sheet with live preview, templates (Dashboard, Work, Personal, College), Integrations page. | CODE-AGENT-GUIDE §6.4 checklist passes: Week default, clock needle ±1°, donut totals and click-to-filter, "Open in <provider>" on every row, AutoDS visible, `shalev396/*` under Personal, text-rule check, no secrets in DOM/storage/network, axe clean, light/dark, lg/md/sm, `he` RTL. |
| **5. Google Calendar** | OAuth connect (PKCE), `CalendarLinks`, LWW + tombstones, "Sync to Google Calendar" button with dry-run preview. | Against a mock Google in tests: echo skipped, 410 reset, idempotent re-run, `AuditLogs gcal.write` written. Real Google is **not** called. |
| **6. MCP server** | `/api/mcp` + `/api/mcp/readonly`, agent-key auth, scopes ∩ role, tool catalog incl. builder tools (dry-run required before write), redaction + audit with `actorAgentId`. | MCP Inspector lists tools; contract tests pass; "MCP never imports the vault" test passes; red-team cases (prompt-injected titles, pasted tokens, cross-workspace ids, revoked keys) behave as MCP.md §12 says; an agent can build the College page end-to-end via preview → write. |
| **7. Review pack** | Competitor UI comparison pass (CODE-AGENT-GUIDE §6), `DECISIONS.md`, `REPORT.md` with screenshots, a written deploy plan (CDK constructs, Atlas, KMS) **not executed**. | Shalev has everything to review. Nothing deployed, nothing pushed. |

## 9. When you finish (or get blocked)

Report to Shalev: what's done per phase, how to run it (`npm run dev` against a stage, client URL), test results, screenshots path, open questions (start from OVERVIEW.md §6), and the proposed next step. Ask before any deploy, push, PR, or use of a real credential.
