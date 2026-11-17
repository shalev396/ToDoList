# BUILDER.md: the dashboard builder (people and AI agents compose dashboards from blocks)

Status: **design only**. Nothing is built or deployed.
Sibling docs: `DATA.md` (collections), `BACKEND.md` (routes), `FRONTEND.md` (block JSON §4, registry §5), `MCP.md` (agent tools). **This doc owns the dashboard/block schema and the builder operations.** FRONTEND.md's block JSON is adopted as-is, and the `Dashboards`/`DashboardVersions`/`Views` collections fill the gap FRONTEND.md §14 flagged.

---

## 1. Goal

What Remi did by hand in Notion (pages, calendars, donuts, deadline lists, filters) should be possible:
- **for Shalev, in the UI:** pick a block, set source → filters → group → viz, and it's done;
- **for any AI agent through MCP:** "add a College page with this week's calendar and per-course deadlines."

Both paths must produce **the same validated JSON**, so that neither side can create something the other can't open or edit.

---

## 2. Where the builder lives: MCP server or a Logic Bridge in the app?

| | **A. Builder inside the MCP server** | **B. Logic Bridge in the backend (recommended)** |
|---|---|---|
| What it is | The MCP server validates and writes dashboard JSON itself | One shared TS module, `server/src/builder/`, holding the schemas, validators, compiler, templates and ops. It is called by the Express routes (UI) **and** by the MCP tools |
| Single source of truth | ✗ The UI needs a second copy of the rules, which will drift | ✓ One schema (zod → JSON Schema) used by the UI editor, the API and MCP |
| Works without an AI | ✗ | ✓ |
| Security | MCP needs direct DB access | MCP only calls the backend API with a scoped workspace token. There's no DB access and no credentials, and the tokens rule holds |
| Testing | Needs an MCP harness for every rule | Unit-test the Bridge once. MCP gets thin contract tests |
| MCP spec fit | n/a | MCP tools are just named functions with a JSON Schema `inputSchema` ([MCP tools spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)), so we export the Bridge's zod schemas straight into them |

**Decision: B.** The Logic Bridge is the single source, and MCP is a thin wrapper.
- Every MCP builder tool maps 1:1 to a Bridge op, which maps 1:1 to an HTTP route.
- `@api-types` (Elytra's shared `server/src/types` alias, FRONTEND.md §0) re-exports the schemas, so the React editor validates as you type with the same rules.

```
React editor ─┐                       ┌─ validate (zod/ajv, JSON Schema)
              ├─► /api/private/…/builder/* ─► Logic Bridge ─┼─ compile query → Mongo pipeline (field whitelist)
MCP tools ────┘    (Cognito JWT | MCP     (server/src/       ├─ apply ops → new DashboardVersion
                    workspace token)       builder/)          └─ preview / dry-run (no write)
```

**Bridge modules:**
- `schema.ts`: zod schemas for blocks, queries and dashboards, plus generated JSON Schema ([zod](https://zod.dev/), [JSON Schema](https://json-schema.org/), [Ajv](https://ajv.js.org/)).
- `catalog.ts`: block types → `{schema, defaults, allowedViz, requiredFields}`.
- `compile.ts`: query JSON → Mongo aggregation. Only whitelisted `Items`/`Containers` fields are allowed. It always injects DATA.md §5's base filter (`workspaceId`, `deletedAt:null`, `areaScope`, `visibility`).
- `ops.ts`: dashboard edits as **JSON Patch** ([RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)) plus named high-level ops.
- `templates.ts` and `lint.ts`: rules for hard-coded text and source links.

---

## 3. Composition model (Mixpanel-style pipeline)

This mirrors Mixpanel Insights: a metric, then filters, then breakdowns, then a chart ([Insights](https://docs.mixpanel.com/docs/reports/insights)). It is the same as FRONTEND.md §4.

```
Source ──► Filters / conditions ──► Group-by / aggregate ──► Visualization ──► Rules (display only)
items|containers   where (AND/OR), dateRange,       groupBy ≤3, aggregate        viz kind + options     if/then: tone|badge|hide
                   $page vars                       count|sum|min|max|earliest
```

**Logic primitives (pre-built; there's no custom code path):**

| Primitive | JSON | Examples |
|---|---|---|
| Filter rule | `{field, operator, value}` in a `{combinator, rules}` group (the react-querybuilder format, FRONTEND.md §3) | `status in [open,in_progress]`, `source.provider = jira` |
| Date range | `"dateRange": "this_week" \| "next_7d" \| "overdue" \| "today" \| "this_semester" \| {from,to}` | Presets resolve in the workspace timezone, `Asia/Jerusalem`, with weeks starting Sunday (`settings.weekStart`) |
| Dynamic values | `@now`, `@today`, `@me`, `$page.<var>` | `dueAt < @now` |
| Group / aggregate | `groupBy: ["source.provider"]`, `aggregate: {op:"count"}` | The donut by source |
| If/then | `rules: [{if:{…}, then:{tone\|badge\|hide}}]` | Overdue shows red, done is hidden |
| Cross-block filter | a filter block **sets** `$page.x`; data blocks **listen** to `$page.x`; clicking a chart segment sets it too | Clicking the donut's "Work" slice filters the calendar and deadlines |
| Action | `{type:"action", action:"sync_gcal" \| "refresh_source" \| "open_source"}` | Runs through the backend and never inside a query |

**Caps:** at most 10 filter rules, 3 group-bys and 40 blocks per dashboard. The compiler refuses `$where`, `$function` and regex longer than 100 characters.

---

## 4. Block catalog

| Type | Purpose | Required query bits | Defaults |
|---|---|---|---|
| `clock` | 24h ring of today's events with a **now-needle**, plus "now / next" | `source: items`, `kind: event`, `dateRange: today` | `calendars: from integration`, refreshes every 60 s |
| `chart` | donut, bar, line or number | `groupBy` + `aggregate` | **Donut by `source.provider`** with a total count and area chips |
| `calendar` | FullCalendar week/month/list | items with `startAt` or `dueAt` | **`view: "week"`** (`timeGridWeek`), with Month as a toggle saved per block |
| `deadlines` | due-soon list, soonest first | `dueAt` not null, `status` open | `dateRange: next_14d`, overdue items on top |
| `kanban` | columns by status or any group field | `groupBy: [status]` | drag only for `local` items; mirrored items show "Open in <provider>" |
| `table` | TanStack table | any | columns come from `props` schema (dynamic) |
| `list` | compact rows | any | at most 7 rows, then "show all" |
| `counter` | one number with a delta | `aggregate` | e.g. open items this week |
| `filter` | chips, select or date presets that set `$page` vars | `sets: "$page.topic"` | options come from `GET /facets` (never hard-coded) |
| `action` | button | `action` | e.g. "Sync to Google Calendar" (Google OAuth) |
| `note` | rich text (phase 4) | n/a | the only block that holds free text, and it's user-authored |

The registry pattern is FRONTEND.md §5: adding a type means **one catalog entry on the server plus one registry entry on the client**.

---

## 5. Data model (defined in DATA.md §3.11–3.13, indexes in §6)

```jsonc
// Dashboards
{ "_id": "d-…", "workspaceId": "w-1", "ownerUserId": "u-1",
  "scope": { "area": "college", "containerId": null },     // null area = main dashboard
  "title": "College",                                       // titles are the only text
  "templateKey": "college@1", "visibility": "workspace",
  "vars": { "range": "this_week", "course": null },
  "layouts": { "lg": [{ "i": "blk_cal", "x": 0, "y": 0, "w": 8, "h": 10 }], "md": [], "sm": [] },
  "blocks": [ /* block JSON, §6 */ ],
  "version": 12, "publishedVersion": 11, "updatedBy": "u-1|agent:mcp:<clientId>", "updatedAt": "…" }
// DashboardVersions: { dashboardId, version, patch (RFC 6902), inverse, snapshotEvery10, actor, at }  keep the last 50 per dashboard (MCP.md §13)
// Views:             { workspaceId, title, query, viz }   reusable named query+viz (FRONTEND.md savedViewId)
```

**Indexes:**
- `Dashboards {workspaceId:1, "scope.area":1, "scope.containerId":1}`
- `DashboardVersions {dashboardId:1, version:-1}`, unique

---

## 6. JSON examples

**Donut of open items by source, with area chips (the dashboard page):**
```json
{ "id": "blk_donut", "type": "chart", "title": "Open",
  "query": { "source": "items",
    "where": { "combinator": "and", "rules": [
      { "field": "status", "operator": "in", "value": ["open", "in_progress"] },
      { "field": "area", "operator": "=", "value": "$page.area" } ] },
    "groupBy": ["source.provider"], "aggregate": { "op": "count" } },
  "viz": { "kind": "donut", "showTotal": true, "legend": "chips" },
  "emits": { "onSegmentClick": "$page.provider" }, "listen": ["$page.area"] }
```
**24h clock and week calendar:**
```json
{ "id": "blk_clock", "type": "clock", "title": "Today",
  "query": { "source": "items", "where": { "combinator": "and", "rules": [{ "field": "kind", "operator": "=", "value": "event" }] }, "dateRange": "today" },
  "viz": { "kind": "clock24", "needle": "now", "showNext": true } }
{ "id": "blk_cal", "type": "calendar", "title": "Week",
  "query": { "source": "items", "dateRange": "$page.range", "where": { "combinator": "or", "rules": [
      { "field": "startAt", "operator": "notNull" }, { "field": "dueAt", "operator": "notNull" } ] } },
  "viz": { "kind": "calendar", "view": "week", "allowMonth": true }, "listen": ["$page.area", "$page.provider"] }
```
**Deadlines for one course (a College course page; `$page.course` = `Containers` id):**
```json
{ "id": "blk_dl", "type": "deadlines", "title": "Deadlines",
  "query": { "source": "items", "dateRange": "next_14d",
    "where": { "combinator": "and", "rules": [
      { "field": "containerId", "operator": "=", "value": "$page.course" },
      { "field": "status", "operator": "!=", "value": "done" } ] },
    "sort": [{ "field": "dueAt", "dir": "asc" }] },
  "rules": [{ "if": { "field": "dueAt", "operator": "<", "value": "@now" }, "then": { "tone": "destructive" } }] }
```
**A builder op from the UI or MCP (dry-run first):**
```json
{ "dashboardId": "d-college", "expectedVersion": 12, "dryRun": true,
  "ops": [ { "op": "add_block", "block": { "type": "deadlines", "title": "Deadlines", "query": { "source": "items", "dateRange": "next_14d" } },
             "layout": { "lg": { "x": 0, "y": 20, "w": 12, "h": 6 } } } ] }
```
The response is `{ valid, errors[], warnings[], preview: { blockId → first 20 rows/aggregates }, diff }`. When the same request is sent with `dryRun:false`, it returns `{ version: 13 }`.

---

## 7. Templates (data, not code)

| Template | Blocks | Area rule |
|---|---|---|
| **Dashboard** (main) | clock · donut by source with area chips · calendar (week) · deadlines across all areas | all |
| **Work** | filter (project, provider) · calendar (week) · kanban or table **grouped by project** (`containerId`) · deadlines | `area = work`. AutoDS is **included**, since the mute only applies to Remi's messages |
| **Personal** | same as Work, with Linear as the source (one-way) | `area = personal`. Projects matching `shalev396/*` are personal (`settings.areaRules`, DATA.md §3.2) |
| **College** | filter (semester, course, type) · calendar (week) · course list (Moodle-like) → course page = per-course deadlines · all-courses deadlines at the bottom | `area = college` |

A template has `{key, version, dashboards[] with unbound $page vars}`, and `instantiate_template` clones it. Template upgrades are offered as a diff and never applied silently.

---

## 8. Safety: versioning, undo, dry-run, validation

- **Optimistic concurrency:** every write carries `expectedVersion` (same name as MCP.md). A mismatch returns `409` along with the current version, so agents and humans can't overwrite each other.
- **Versioning and undo:** each write stores the RFC 6902 patch and its inverse in `DashboardVersions`.
  - `undo` / `redo` / `restore_version(n)` are ops too.
  - A full snapshot is kept every 10 versions.
- **Draft → publish (MCP.md §8):** agents edit the draft, and `publishedVersion` is what Shalev sees. Publishing needs its own scope or a click in the UI. The UI editor auto-publishes for the owner.
- **Dry-run / preview:** `dryRun:true` validates the change, compiles the queries, and runs them with `limit 20` and a 2 s timeout. It never writes. The same compiler backs `POST /workspaces/:wid/query {draft, vars, preview:true}`, which the UI editor calls on every change (debounced) for live preview.
  - MCP agents **must** dry-run before writing; the tool description says so, and the Bridge rejects a write whose ops hash wasn't previewed in the last 10 minutes.
- **Validation layers:**
  1. Schema (zod).
  2. Catalog: required fields per type, allowed viz.
  3. Compile: field whitelist, caps, safe operators.
  4. **Lint**, which runs as a warning in the UI and **blocks** MCP writes:
     - **Text rule:** any string outside `title`, `note`, and filenames that come from data is flagged. Labels, legends, empty states and counts must be computed or come from i18n keys.
     - **Source link rule:** every row-rendering block must keep `item.source.url`. Blocks render the "Open in <provider>" button automatically, and a block config can't turn it off.
     - **Privacy rule:** no field path under `Credentials`, `enc`, `token` or `secret` may appear in any query. The whitelist enforces this.
- **Audit:** `AuditLogs` records `dashboard.update` with `actor`, which can be an agent id, and the version. Patches are never logged with secrets, since dashboards never hold any.

---

## 9. Builder operations (the Bridge API; MCP tools wrap these 1:1, and **MCP.md wins on tool naming**)

| Op | Route | MCP tool (from MCP.md §8) |
|---|---|---|
| Describe catalog, fields, facets | `GET …/builder/catalog`, `GET …/facets` | `builder_list_block_types`, `builder_list_templates` |
| List / get dashboards | `GET …/dashboards[/:id]` | `builder_list_dashboards`, `builder_get_dashboard` |
| Create / from template | `POST …/dashboards`, `POST …/builder/instantiate` | `builder_create_dashboard`, `builder_apply_template` |
| Validate / preview (dry-run) | `POST …/builder/validate`; `POST /workspaces/:wid/query` with a saved query id (`savedQueryId` or `dashboardId`+`blockId`) **or** `{draft}`, plus runtime cross-block filter `vars` and `preview:true` (BACKEND.md §4) | `builder_validate`, `builder_preview` |
| Edit blocks and layout | `POST …/dashboards/:id/ops` (`dryRun`, `expectedVersion`) | `builder_add_block`, `builder_update_block`, `builder_remove_block`, `builder_arrange`, `builder_connect_blocks` (sets `emits`/`listen`), `builder_apply_patch` |
| Versions | `GET …/versions`, `POST …/undo`, `POST …/revert`, `POST …/publish` | `builder_list_versions`, `builder_undo`, `builder_revert`, `builder_publish` |

What an AI naturally wants (and gets):
- "Show me what blocks exist": the catalog.
- "Try it first": dry-run with preview rows.
- "Make it like my Work page": instantiate a template, or copy a dashboard.
- "Undo that": undo.
- "Why is this empty?": the preview returns `errors[]` and the row count.

---

## 10. Constraints recap

- Minimal hard-coded text: only titles and filenames. Everything else is dynamic (facets, i18n, computed).
- Every item links back to its source.
- Providers are one-way into the app; the only sanctioned two-way path is the personal Google Calendar through Google OAuth (the `sync_gcal` action).
- Slack is out of scope for the app (agents use Slack through their own MCP).
- Tokens never reach the builder, the UI or agents.
- AutoDS appears in views.
- Personal vs work is decided by project name.
