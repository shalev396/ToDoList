> Spec deltas since this doc was written live in [REPORT.md](REPORT.md) under "Spec deltas".

# FRONTEND.md: Elytra → personal to-do and management app

Status: design doc only. Nothing is built, changed or deployed.
Siblings: `DATA.md` (Mongo collections) and `BACKEND.md` (Lambda APIs). This doc uses their names: `Items{kind, area, status, dueAt, startAt, endAt, containerId, source{provider,url,key}, props, overlay}`, `Containers` (project/course/folder/calendar), `Integrations`, `SyncRuns`, `Memberships{role, areaScope}`, and the `/api/private/workspaces/:wid/...` routes. Where they differ, the sibling docs win.

---

## 0. Elytra today (read from `shalev396/Elytra@main`, `client/`)

| Area | What exists | Reuse plan |
|---|---|---|
| Build | Vite 7, React 19, TypeScript 5.9 | Keep |
| UI | shadcn/ui (`new-york`, `neutral`, CSS variables), Radix, Tailwind v4, `lucide-react`, `sonner` toasts, `tw-animate-css`, GSAP | Keep. Add shadcn components as needed (tabs, sheet, popover, command, select, toggle-group, badge, skeleton, chart) |
| Theme | `theme-provider.tsx` + `mode-toggle.tsx` (light/dark, stored in localStorage); `--chart-1..5` tokens already in `index.css` | Keep. All blocks use tokens only |
| Routing | `react-router-dom` 7. Every route sits under `/:lng` (`LanguageLayout`). `ROUTES` + `pathTo()` are the single source of paths. `ProtectedRoute`, `GuestRoute`, `DashboardLayout` → `StandardLayout` | Add the new routes to `ROUTES` and `appRoutes` |
| Data | `@tanstack/react-query` 5 (`queryKeys`, `QUERY_STALE_TIME_PRIVATE_MS` = 60 s); axios instance with a Bearer ID token and refresh queue; error toasts | Keep. Add query keys per resource |
| State | Redux Toolkit (`user` slice only). The Cognito ID token is in sessionStorage and the refresh token in localStorage | Keep auth as is. Add one `editor` slice (below) |
| i18n | i18next, `en` + `he` namespaces | All UI text (labels, empty states) goes through i18n. Hebrew needs RTL |
| Types | `@api-types/*` → `../server/src/types` (contracts shared with the server) | Put block, view and dashboard JSON types there so the client and Lambda share one schema |
| Tests | Python/Playwright e2e: smoke, visual, responsive, accessibility, security per page | Add the same suites for the new pages |
| Server | Express 5 on one Lambda (`serverless-http`), Mongoose + Sequelize, Cognito JWT, AWS CDK | See BACKEND.md |

Today the `DashboardPage` placeholder only renders `userId` and `message`. It gets replaced.

---

## 1. Product shape after login

```
/:lng/dashboard                 Main dashboard (customizable grid)
/:lng/t/:topic                  Topic dashboard: work | personal | college | <user-created>
/:lng/t/:topic/:group           Group page: one project (Work/Personal) or one course (College)
/:lng/integrations              Connections + sync status (+ "Sync everything to Google Calendar")
/:lng/templates                 Template gallery: Work / Personal / College / blank
/:lng/profile, /profile/edit    Existing
```

- Item detail opens in a right-side **Sheet** (`?item=<id>` in the URL), not as a separate page. That way the link can be shared and the back button closes it.
- The sidebar lists topics dynamically: workspace `settings.areas` (DATA.md) plus any user-created topic dashboards from `GET /workspaces/:wid/dashboards`. Nothing is hardcoded except the app name.
- Filter options (providers, projects, courses, areas) always come from `GET /workspaces/:wid/facets`. There are no hardcoded lists.
- `:group` = a `Containers` id (a project for Work/Personal, a course for College).
- Role-aware: `viewer` members (DATA.md §3.3) never see edit mode. `areaScope` hides topics the member can't see.
- Edit mode is a toggle (`?edit=1`). Users only see the drag handles and the "add block" button while editing.

### Default content (from templates; all of it can be edited)

| Page | Blocks (defaults mirror today's Notion setup) |
|---|---|
| **Dashboard** | 24h clock (personal Google Calendar, current-time needle, "where to be now/next") · donut of open to-dos by source, with Work/College/Personal chips + count · calendar (Week ⇄ Month, **defaults to Week**) · deadlines across all areas, soonest first |
| **College** | Moodle-like course list (filters: semester, course, type) → course page = deadlines for that course · weekly calendar on top · deadlines for all courses at the bottom |
| **Work** | Grouped by project · filters: project, provider (ClickUp, Jira, …) · week calendar · projects board · deadlines. AutoDS is **included** (the AutoDS mute only applies to Remi's messages) |
| **Personal** | Same layout as Work. The source is Linear (one-way). Projects matching `shalev396/*` are classified Personal (the rule runs on the backend, see BACKEND.md) |

---

## 2. Research: how leading tools model customizable pages

| Product | Model | What we borrow |
|---|---|---|
| Notion | Everything is a **block** with an id, a type, properties, ordered children and a parent pointer. Pages and database rows are blocks too ([Notion: Creating the Notion API](https://www.notion.com/blog/creating-the-notion-api)) | Dashboards = a tree of typed blocks with JSON props |
| Airtable Interfaces | Pre-built layouts (list, kanban, calendar, timeline, dashboard) plus elements. A **Filter element** is linked to the other elements that share its source ([layouts](https://support.airtable.com/articles/7171868269-adding-layouts-to-interfaces), [dashboard](https://support.airtable.com/articles/5415824889-airtable-interface-layout-dashboard), [condition filters](https://support.airtable.com/articles/9290731839-filtering-records-using-conditions)) | Cross-block filter blocks that target blocks on the same source |
| Coda | The canvas mixes tables, **controls** (their values are referenced in formulas) and **buttons** (they run actions) ([controls](https://help.coda.io/hc/en-us/articles/39555865536013-Canvas-control-basics), [buttons](https://help.coda.io/hc/en-us/articles/39555758072717-Button-basics)) | Controls as page variables, buttons as actions |
| Retool | Components fire **event handlers** that run queries. **Transformers** are read-only derived data ([event handlers](https://docs.retool.com/classic-apps/guides/interaction-navigation/event-handlers), [transformers](https://docs.retool.com/queries/guides/transformers)) | Split pure transforms (filter, group, aggregate) from side-effect actions (sync, open) |
| Grafana | A dashboard is one JSON doc: `panels[]` with `gridPos {x,y,w,h}` on a 24-column grid, plus `templating.list` variables that are reused across panels ([JSON model](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/view-dashboard-json-model/), [variables](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/)) | Store layout as `gridPos` and use page-level variables for cross-block filters |
| Mixpanel Insights | Metric → inline or **global filters** → **breakdowns** → chart. The API caps a query at 10 filters and 3 breakdowns ([Insights](https://docs.mixpanel.com/docs/reports/insights), [query API](https://docs.mixpanel.com/reference/insights-run-query)) | The block pipeline: source → filters → group-by → viz, with similar caps |

**Takeaway:** one JSON document per dashboard. Blocks are typed and placed on a grid. Each data block holds a declarative query pipeline. Page variables drive cross-block filters. Side effects (sync, open) are explicit actions and never part of a query.

---

## 3. Library choices (fit: React 19 + shadcn + Tailwind v4)

| Need | Pick | Why / tradeoffs | Considered |
|---|---|---|---|
| Dashboard grid | **react-grid-layout v2** | v2 (Dec 2025) brings first-class TypeScript and hooks (`useContainerWidth`, `useResponsiveLayout`) and per-breakpoint layouts ([release](https://github.com/react-grid-layout/react-grid-layout/releases/tag/2.0.0)). It's the standard choice for widget dashboards ([ilert](https://www.ilert.com/blog/building-interactive-dashboards-why-react-grid-layout-was-our-best-choice)) | **Gridstack** is better for nested grids and cross-grid drags, but its core isn't React ([gridstackjs.com](https://gridstackjs.com/)). **dnd-kit** would mean writing resize and compaction ourselves ([discussion](https://github.com/clauderic/dnd-kit/discussions/1560)) |
| In-block drag (kanban, list reorder) | **dnd-kit** | Accessible (keyboard sensors) and headless | n/a |
| Charts | **shadcn `chart` (Recharts v3)** | Copied into the repo and themed with the `--chart-*` tokens Elytra already has ([shadcn chart](https://ui.shadcn.com/docs/components/radix/chart)). Covers donut, bar, line, radial and number | **ECharts** (Apache-2.0) is the escape hatch for heavy or exotic charts, e.g. its [gauge-clock example](https://echarts.apache.org/examples/zh/editor.html?c=gauge-clock). **Tremor** (Apache-2.0, Vercel since 2025, [blog](https://vercel.com/blog/vercel-acquires-tremor)) overlaps with shadcn charts. **Nivo** and **visx** are polished or low-level but add a second styling system. **Highcharts** is free only for strictly personal or educational use, and any professional use needs a paid license ([EULA update](https://www.highcharts.com/blog/news/our-new-eula-makes-free-usage-clearer/)). Skip it |
| 24h clock | **Custom SVG** (`d3-shape` arcs) | Event arcs on a 24h ring plus a needle at the current time. No library has this ready-made. ~150 lines, themeable, accessible | ECharts gauge-clock is 12h with hands, not an agenda ring |
| Calendar | **FullCalendar Standard** (`@fullcalendar/react`) | MIT, and its standard plugins include time-grid week/month/list plus drag and resize ([license](https://fullcalendar.io/license), [plugins](https://fullcalendar.io/docs/plugin-index)). `initialView: 'timeGridWeek'`. Themed with CSS vars | **Schedule-X** looks more modern and is MIT, but since v4 drag/resize and the event-form modal are Premium ([v4 notes](https://schedule-x.dev/blog/schedule-x-v4)). **react-big-calendar** is MIT but dated to style. FullCalendar's Timeline and Resource views are Premium, and we don't need them |
| Filters / conditions UI | **react-querybuilder** (shadcn registry build) | Can be installed via `npx shadcn add …` ([compat](https://react-querybuilder.js.org/docs/compat)). Exports JSON ([export](https://react-querybuilder.js.org/docs/utils/export)). We store its JSON, and the **backend** compiles it against a field whitelist. The client never sends raw Mongo | Hand-rolled chips for simple filters (these sit on top and use the same JSON) |
| Logic / automations canvas (phase 2) | **React Flow (`@xyflow/react`)** | MIT, and custom nodes are plain React components ([custom nodes](https://reactflow.dev/learn/customization/custom-nodes)). Only for if/then rules. The normal user path is the linear pipeline form | **Rete.js** (MIT, [licensing](https://retejs.org/docs/licensing/)) has a dataflow engine but heavier setup and a less shadcn-like look |
| Rich text (optional "note" block) | **Plate** | MIT core, shadcn-style copy-in components ([Plate](https://pro.platejs.org/docs/license)) | **BlockNote** gives the most Notion-like editing out of the box (core MPL-2.0; its XL packages are GPL-3.0 or commercial: [pricing](https://www.blocknotejs.org/pricing)). **Tiptap** has an MIT core with paid Pro extensions ([pro license](https://tiptap.dev/pro-license)). **Editor.js** is Apache-2.0 but has no React wrapper |
| Tables | **TanStack Table** with shadcn `data-table` | Headless, and fits the TanStack Query already in Elytra | n/a |

---

## 4. Composition model (Mixpanel-style, no code)

Each data block = **source → filters → group-by → aggregate → visualization**. The editor is a short form with four steps, each built from pre-built primitives.

```
[Source]   Items (narrowed by kind: todo|issue|task|event|assignment|deadline|file|pr) · Containers
           providers: clickup, jira, linear, google_calendar, moodle, github, local
[Filter]   field op value  (AND/OR groups)  · date presets: today, tomorrow, this week, next 7d, overdue, this semester
[Logic]    if <condition> then <style|hide|badge>    (e.g. if due < now → red; if status=done → hide)
[Group]    by source.provider | area | containerId (project/course) | status | priority | kind | due bucket
[Aggregate] count | sum | min/max(due) | earliest
[Viz]      list | table | kanban | calendar | chart(donut/bar/line/number) | clock | counter | deadlines | file-tree
```

**Block JSON** (stored via BACKEND.md `POST|PATCH /dashboards/:id/blocks/:bid`. Item fields are DATA.md `Items` fields):

```jsonc
{
  "id": "blk_…",
  "type": "chart",                   // list|table|kanban|calendar|chart|clock|counter|deadlines|note|filter|action
  "title": "Open to-dos",            // the only free text
  "gridPos": { "x": 0, "y": 0, "w": 6, "h": 8 },   // per breakpoint: lg/md/sm
  "query": {
    "source": "items",
    "where": { "combinator": "and", "rules": [ { "field": "status", "operator": "in", "value": ["open","in_progress"] } ] },
    "dateRange": "$page.range",       // variable reference
    "groupBy": ["source.provider"],
    "aggregate": { "op": "count" },
    "sort": [{ "field": "dueAt", "dir": "asc" }],
    "limit": 50
  },
  "rules": [ { "if": { "field": "dueAt", "operator": "<", "value": "@now" }, "then": { "tone": "destructive" } } ],
  "viz": { "kind": "donut", "showTotal": true, "legend": "chips" },
  "listen": ["$page.topic", "$page.provider"],     // cross-block filters
  "savedViewId": null
}
```

- **Page variables** (`$page.topic`, `$page.provider`, `$page.range`, `$page.course`) are set by **filter blocks** (chips, selects, date presets) or by clicking chart segments, so clicking a donut slice filters the rest of the page. Variables are mirrored in the URL search params, so any state can be shared and survives reload.
- **Saved views** = named `query + viz` pairs stored server-side. A block either embeds its own query or references a `savedViewId`. (Stored in DATA.md `Views`, §3.13; dashboards in `Dashboards`, §3.11.)
- **Actions** (button block or item menu): `open in provider`, `sync to Google Calendar`, `refresh source`. Actions call backend endpoints and never run inside a query.
- **Templates** = dashboard JSON with variables unbound: Work (group by project, provider chips), Personal (Linear source), College (course list → course page with deadlines). "Use template" clones it into the user's workspace.
- **Validation:** the same zod-style schema lives in `@api-types` and runs on both the client (editor) and the Lambda (save).
- **Caps** (like Mixpanel's): ≤10 filter rules and ≤3 group-bys per block, ≤40 blocks per dashboard. They keep queries cheap on Lambda + Mongo.

---

## 5. Component architecture

```
src/
  features/
    dashboards/
      DashboardPage.tsx            // loads dashboard JSON by route (main | topic | group)
      DashboardGrid.tsx            // react-grid-layout v2, edit mode, breakpoints lg/md/sm
      BlockFrame.tsx               // title, menu, loading/empty/error, "Open in <provider>" footer
      BlockEditorSheet.tsx         // 4-step pipeline form (source→filter→group→viz)
      registry.ts                  // type → { component, editor, defaultProps, icon }
      blocks/ ListBlock TableBlock KanbanBlock CalendarBlock ChartBlock ClockBlock
              CounterBlock DeadlinesBlock NoteBlock FilterBlock ActionBlock
      variables/ PageVarsProvider.tsx useUrlVars.ts
    items/
      ItemSheet.tsx                // detail: fields rendered dynamically from item.props schema
      SourceLink.tsx               // "Open in {provider}" button + favicon, from item.sourceUrl
      SourcePreview.tsx            // provider preview (title, status, due, snippet)
    integrations/
      IntegrationsPage.tsx ConnectionCard.tsx SecretField.tsx SyncGCalButton.tsx SyncStatus.tsx
    templates/ TemplateGallery.tsx
  api/queries/ dashboards.ts blocks.ts items.ts integrations.ts sync.ts   // + keys
```

- **Block registry pattern:** adding a block type means one entry in `registry.ts`. Pages never switch on the block type.
- **Dynamic fields:** items are heterogeneous (see DATA.md). `ItemSheet` renders `item.props` via a field-type map (date, user, status, url, number, text). There are no per-provider hardcoded forms.
- **Source links are mandatory:** `BlockFrame` and every row render `SourceLink`. If an item lacks `sourceUrl`, it shows "source missing" as a data error.

---

## 6. State and data fetching

| Kind | Where |
|---|---|
| Server data (dashboards, block results, items, sync status) | TanStack Query. Keys: `['dashboard', id]`, `['block', id, varsHash]`, `['item', id]`, `['facets', wid]`, `['syncRuns', integrationId]`. `staleTime` = `QUERY_STALE_TIME_PRIVATE_MS` |
| Block results | **One request per block**: `POST /workspaces/:wid/query` (BACKEND.md §4) with `{dashboardId, blockId}` or `{savedQueryId}` for saved blocks, or `{draft: <query JSON>, preview: true}` while editing (live preview of unsaved config), plus `vars` = the current runtime cross-block filter values (`$page.*`). The backend runs the pipeline, and the client only renders. Per-block loading keeps the page responsive |
| Editor draft (layout + block config while editing) | New Redux slice `editor` (RTK already present). Debounced autosave with `PUT /dashboards/:id/layout` (positions) and `PATCH /dashboards/:id/blocks/:bid` (config), optimistic, rolled back on error with a `sonner` toast |
| Page variables | URL search params ↔ `PageVarsProvider` context |
| Freshness | `refetchOnWindowFocus` and a 60 s interval for the clock and calendar blocks. Sync status is polled every 3 s only while a sync is running |
| Auth | Unchanged (existing axios interceptors + Cognito) |

---

## 7. "Sync everything to Google Calendar"

- **Where:** a button in the Integrations page header, plus an `action` block you can drop on any dashboard.
- **Flow:** `POST /workspaces/:wid/gcal-sync {itemFilter, dryRun}` (BACKEND.md §4). By default `itemFilter` = the current page's variables, and the confirm dialog (showing the dry-run create/update/delete counts) lets you widen it to everything. The backend pushes through the Google Calendar API with the user's OAuth connection (the refresh token is encrypted in `Credentials`). This is the **one sanctioned two-way sync**: edits made in Google are pulled back on the next push (and on the scheduled pull once a schedule returns, see TODO.md), and every write is audit-logged. Re-runs are idempotent. The client polls `GET /sync-runs?integrationId=<gcal>`.
- Mirrored items can't be edited in-app (`409` + source link per BACKEND.md). The UI shows the "Open in <provider>" button instead of edit controls. Only `local` items get inline edit.
- **UI shows:** state (idle / running / done / failed), started/finished time (Asia/Jerusalem), created/updated/skipped counts, the last error message (text only), and an "Open Google Calendar" link.
- **Never shows:** any token or secret. Errors are sanitized server-side.
- Each item can also have a "Sync this to calendar" action from its menu.

---

## 8. Integrations and secrets in the UI

- `ConnectionCard` per provider shows exactly the integration status fields: provider, account label, status (`connected` / `expired` / `error`, or "not connected" when no integration exists), `expiresAt` and `lastSyncAt`, plus a link to the provider's token docs. Never a token, masked hint or last-4.
- `SecretField` is **write-only** (`POST /workspaces/:wid/integrations`, or `PUT …/integrations/:iid/credential`, which returns `204`). The input is `type=password`, `autocomplete=off`, and it is cleared right after submit. There's no "reveal", and no token in Redux, React Query cache, URL, localStorage, error toasts, or console logs. "Test connection" (`POST /integrations/:id/test`) shows only `{ok, accountLabel}`.
- The card shows `expiresAt` (e.g. Jira ≤365 days) with a renewal hint 14 days ahead.
- Slack is **out of scope** (the assistant uses Slack via MCP). There is no Slack card or block.

---

## 9. Design rules (enforced in review)

- **Minimal hardcoded text.** The only literal strings are titles and filenames, which come from data. UI chrome strings come from i18n. Counts, labels, legends and empty states are computed.
- **Every item links back to its source:** an "Open in {provider}" button, plus a hover/preview card when the provider gives one (title, status, due, assignee).
- **Calendars default to Week.** The Week ⇄ Month toggle is a shadcn `ToggleGroup`, and the choice is saved per block.
- **Easy to scan:** a 12-col grid, `Card`-based blocks, one accent color per source (mapped to `--chart-*`), at most ~7 rows visible per list block with "show all" opening the full view, and relative + absolute dates ("in 2 days · Fri 13 Nov").
- **AutoDS is included** in all views by default. Muting is a messaging concern only.

---

## 10. Theming

- Only the shadcn CSS variables. Dark/light comes from the existing `ThemeProvider`.
- The source → color map is data-driven (DATA.md `integrations.color`, falling back to `--chart-n` by index).
- FullCalendar, react-grid-layout and react-querybuilder are restyled through CSS variables in `index.css` (no separate theme files).
- Motion uses `tw-animate-css`. GSAP only for the landing page. Both respect the existing `useReducedMotion`.

## 11. Accessibility

- Grid editing works by keyboard: arrow keys move a block, Shift+arrow resizes, and each block has a "Move"/"Resize" menu as a non-drag fallback. dnd-kit keyboard sensors handle kanban.
- Charts: shadcn charts with `accessibilityLayer`, plus a visually hidden data table per chart. The donut legend is made of real buttons, so filtering doesn't require clicking the chart.
- Clock: `role="img"` with a live text summary ("Now: X until 14:00, next: Y at 15:30"), updated every minute.
- Focus is trapped in Sheets and Dialogs (Radix). Contrast meets AA in both themes. Hebrew is RTL (`dir` from `LanguageLayout`); the grid mirrors and the clock doesn't.
- Extend the existing Playwright `accessibility.py` suites to the new pages.

## 12. Mobile

- Breakpoints `lg ≥1200 / md ≥768 / sm <768`. On `sm` the grid becomes a single column (stored separately, so mobile order can differ), and edit mode is reorder-only.
- Calendar on `sm` uses `timeGridDay` or `listWeek`, and the user's Week default applies on desktop. The 24h clock stays square.
- The sidebar becomes a bottom tab bar (Dashboard + up to 3 pinned topics + More). The item Sheet becomes a full-height drawer.
- Tap targets are at least 44 px. The "Open in provider" link opens the native app when the OS supports it.

---

## 13. Phasing

1. Routes, the grid, the block registry, and the list/table/deadlines/calendar/donut/counter blocks. Dashboard + Work/Personal/College templates.
2. Clock block, filter blocks + page variables, saved views.
3. Sync-to-GCal button + status, Integrations page.
4. Rules (if/then), the React Flow automations canvas, the note block (Plate), sharing (two-person workspace per DATA.md).

## 14. Open items to confirm with siblings

- ~~DATA.md missing `Dashboards`/`Views`~~ **Resolved:** `Dashboards`, `DashboardVersions`, `Views` are in DATA.md §3.11–3.13 (blocks are embedded in `Dashboards`).
- ~~`tokenHint` in `GET /integrations`~~ **Resolved:** removed from BACKEND.md and MCP.md; status is `{provider, accountLabel, status, expiresAt, lastSyncAt}` only.
- ~~`/query` draft + vars~~ **Resolved:** BACKEND.md §4 accepts a saved query id or a draft, plus runtime `vars`.
- Whether the Moodle course list comes from a token API or the calendar export (affects the College filters).
