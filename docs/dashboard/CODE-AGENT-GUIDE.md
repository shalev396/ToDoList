# CODE-AGENT-GUIDE.md: how a code agent runs and reviews the dashboard

For whichever code agent Shalev uses (Claude Code, Cursor, Codex…). Status: **guide only**. The agent builds on the `dev` branch, runs the local API against a deployed stage, and **never deploys or pushes** unless asked.
**Read first:** `OVERVIEW.md` → `DATA.md` → `BACKEND.md` → `FRONTEND.md` → `BUILDER.md` → `MCP.md`. On naming conflicts, **DATA.md wins**.
Base repo: [shalev396/Elytra](https://github.com/shalev396/Elytra) (React 19 + Vite, Express 5 on one Lambda, Mongoose/Sequelize, CDK).

---

## 0. Rules for the agent (non-negotiable)

1. **Build on the `dev` branch for Shalev's review.** Don't run `deploy:*`, `cdk deploy`, `reset:db` against a deployed stage, `git push` or open PRs unless Shalev explicitly asks, every time.
2. **No secrets in the repo.** `.env.*` files are git-ignored. Only `server/.env.example` is committed, with placeholders. Use [gitleaks](https://github.com/gitleaks/gitleaks) or a pre-commit grep for `pk_`, `lin_api_`, `ATATT`, `xox`, `ghp_`, `github_pat_`, `-----BEGIN`.
3. **Never print tokens.** Don't `cat` env files, `echo $SECRET`, log request bodies on credential routes, or paste tokens into chat or screenshots. Test with **fake fixture tokens** only. Real provider tokens are entered by Shalev in the UI and stored encrypted (DATA.md §0, §7).
4. Provider data is a **one-way mirror into the app**. Never write to Jira, ClickUp, Linear or Moodle. The one sanctioned exception is the two-way sync with the personal Google Calendar through Google OAuth (audit-logged).
5. **Product rules to keep in code review:**
   - Titles and filenames are the only literal text; everything else is i18n or data.
   - Every item has "Open in <provider>".
   - AutoDS stays **included** in views (the mute only applies to Remi's messages).
   - `shalev396/*` projects are Personal.
   - Slack is out of scope for the app.

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22 (CI uses 24; MCP Inspector needs ≥ 22.19 per MCP.md) | Elytra `engines` |
| Python 3 | 3.10+ | Elytra's Playwright E2E suite (`client/tests`) |
| AWS CLI + creds for the stage account | yes | The local API reads the deployed stage's Cognito, database and resources |
| Postman CLI | optional | `npm run test:local` |

---

## 2. Environment variables (`server/.env.<stage>`, git-ignored)

Only these exist: `AWS_ACCOUNT_ID`, `CERTIFICATE_ARN`, `WAF_WEB_ACL_ARN`, `AWS_ROLE_NAME`, `AWS_REGION`, `DATABASE_URL`, `BASIC_AUTH_PASSWORD` (dev and qa) and `DOMAIN_NAME`. `server/.env.example` is the committed reference. Nothing else is controlled by an environment variable, and app secrets live in AWS Secrets Manager (one secret per stage, `todolist-<stage>-app-secrets`). The client needs no env file: in development it calls `http://localhost:3000/api`, deployed it calls `/api` on its own origin.

---

## 3. Run it

```bash
git switch dev
npm install && (cd server && npm install) && (cd client && npm install)
aws sso login
cd server && npm run dev        # the same Express app the Lambda serves, on :3000, against the deployed dev stage
cd ../client && npm run dev     # :5173
```
`src/local.ts` reads the Cognito, bucket and KMS ids from the deployed `todolist-<stage>` stack and `DOMAIN_NAME` and `DATABASE_URL` from `server/.env.<stage>`. Background syncs run in-process there. There is no offline mode, no local database and no Docker.

## 4. Demo data (fake, deterministic)

`POST /private/workspaces {loadDemoData: true}` (dev and qa only; prod refuses) loads `server/src/seed/seedWorkspace.ts`:
- A workspace with `timezone: Asia/Jerusalem`, `weekStart: sun` and areaRules `shalev396/* → personal`.
- **Integrations** for jira, clickup, linear, moodle and google_calendar, flagged `demo` (they never sync) with **fake** credentials.
- About 60 `Items` covering every `kind`, with overdue, today, this-week and next-month dates. Each has a fake `source.url` (`https://example.invalid/<provider>/<id>`). The set includes **AutoDS-named projects** (to prove they show up in views) and a `shalev396/Elytra` project (to prove it's classified Personal).
- `Containers`: 3 courses with sections, 4 projects.
- `Dashboards` from the BUILDER.md templates: Dashboard, Work, Personal, College.

Demo data never reads real data from the box or anywhere else.

## 5. Tests

| What | Command |
|---|---|
| Server unit (Elytra) | `cd server && npm run test:unit` |
| Infra assertions | `npm run test:infra` |
| API (Postman, local API against a stage) | `npm run test:local` |
| Builder schema, compiler, lint | `node --import tsx --test "src/builder/**/*.test.ts"` |
| **Secret-leak suite** (CI-blocking, DATA.md §7) | `npm run test:unit` (`src/__tests__/secrets/`): scans every route response, log line and MCP output against the token patterns |
| Google Calendar OAuth | `npm run test:unit` (`src/gcal/`): push, pull, echo skip, tombstones, 410 reset. Uses a mock Google (a test seam), never real Google |
| E2E (Playwright, stage-backed) | `cd client && npm run test:install && npm run test` |
| MCP | `npm run test:unit` (`src/mcp/`); `npm run mcp:smoke` against a stage; or `npx @modelcontextprotocol/inspector --cli <url> --transport http --method tools/list` ([Inspector](https://modelcontextprotocol.io/docs/tools/inspector)). Use the dev key only |
| Lint, types | `npm run lint` in both packages, `npx tsc -b` |

**Done = all green + the UI review pass (§6) + a short report to Shalev with screenshots.**

---

## 6. Competitor UI comparison pass

### 6.1 What competitors do better (sources opened 2026-11-11)

| Product | Does better | Source |
|---|---|---|
| **Notion** | Databases with switchable views (table, board, calendar, chart) over the same data, and inline filters and sorts per view. Charts can sit side by side to form a dashboard. *But* charts are paid (Free gets one chart) and capped at 200 groups | [views & filters](https://www.notion.com/help/views-filters-and-sorts), [charts](https://www.notion.com/help/charts) |
| **Mixpanel** | A fast linear query builder: metric, then filters, then breakdown, then chart type, with instant re-render while you edit | [Insights](https://docs.mixpanel.com/docs/reports/insights) |
| **Linear** | Dashboard insights can each be **filtered independently**, and **clicking a slice or metric opens the filtered issues** in place. The style is very calm and dense (an Enterprise feature) | [Dashboards](https://linear.app/docs/dashboards) |
| **ClickUp** | You **act from the dashboard** (change status, reassign) without switching tools. Cards drag and resize. Dashboards can be shared without sharing the workspace | [Dashboards](https://clickup.com/features/dashboards) |
| **Coda** | Page **controls** (selects, date pickers) feed every table and formula, and **buttons** run actions | [controls](https://help.coda.io/hc/en-us/articles/39555865536013-Canvas-control-basics), [buttons](https://help.coda.io/hc/en-us/articles/39555758072717-Button-basics) |
| **Airtable Interfaces** | Pre-built layouts on one dataset, a **filter element linked to many elements**, and per-audience permissions | [Interface Designer](https://support.airtable.com/docs/getting-started-with-airtable-interface-designer), [layouts](https://support.airtable.com/articles/7171868269-adding-layouts-to-interfaces) |
| **Sunsama** | A daily-planning ritual (plan the day, then shut down). **Tasks and meetings in one plan**, with timeboxing on the calendar | [sunsama.com](https://www.sunsama.com/) |
| **Akiflow** | A **universal inbox** from every tool, one calendar for work and life, and fast time-blocking | [akiflow.com](https://akiflow.com/) |
| **Motion** | Auto-scheduling: tasks get placed into free calendar time | [usemotion.com](https://www.usemotion.com/) |

### 6.2 Differences vs. our plan

| Area | Us (FRONTEND.md / BUILDER.md) | Best-in-class | Gap or action |
|---|---|---|---|
| Building a chart | 4-step pipeline sheet | Mixpanel: inline, live as you edit | Show a **live preview** in the editor sheet with the `dryRun` query on every change, debounced 300 ms |
| Drill-down | `emits` sets `$page` vars | Linear: click a slice to see the filtered list | Clicking a segment also opens a **Sheet with the filtered items**, alongside filtering the page |
| Acting on items | Mirrored items are read-only, so you open the source | ClickUp edits in place | Keep read-only (sources of truth), but make "Open in <provider>" **one click with a hover preview**. Local items edit inline |
| Page controls | filter blocks | Coda and Airtable: linked controls | Filter blocks show **which blocks they control** (outline on hover) |
| Daily flow | none | Sunsama/Akiflow: plan today, inbox | A **"Today" template**: clock + overdue + today's deadlines + drag-to-calendar for local items (a phase-2 idea) |
| Views of the same data | per block | Notion: view tabs on one source | A block can hold **view tabs** (table ⇄ board ⇄ calendar) sharing one query |
| Cost | everything free (self-hosted) | Notion charts and Linear dashboards are paid | A selling point. Nothing to do |
| Auto-scheduling | none | Motion | Out of scope. Note for later |

### 6.3 Suggested improvements (ranked)

1. **Live preview in the block editor.** This is the biggest "feels like Mixpanel" win, and it reuses `builder_preview`.
2. **Click-to-drill Sheet** on every chart, counter, clock arc and calendar event.
3. **Hover preview cards** for source links: title, status, due date and provider icon.
4. **Command palette** (`⌘K`, shadcn `command`): jump to a topic or course, add a block, run "Sync to Google Calendar".
5. **Empty states computed from data** ("No deadlines in the next 14 days" built from the query, via i18n keys), never placeholder copy.
6. **Density toggle** (comfortable/compact) like Linear, saved per user.
7. **A "Today" template** inspired by Sunsama and Akiflow.

### 6.4 Checklist the agent runs (every UI PR, against a stage)

```bash
cd client && npm run dev &            # on a stage with demo data loaded
python -m pytest tests/e2e/ui_review.py --headed=false   # new suite
```
`ui_review.py` uses Playwright ([screenshots](https://playwright.dev/docs/screenshots)) and does the following:
- [ ] Captures full-page screenshots of `/en/dashboard`, `/en/t/work`, `/en/t/personal`, `/en/t/college`, a course page and `/en/integrations`:
  - in **light and dark** themes,
  - at **lg, md and sm** widths,
  - in `/he/` for RTL.

  Saved to `client/tests/artifacts/ui-review/<date>/` (git-ignored).
- [ ] **Text rule:** collect all visible text nodes. Each must match data (titles or filenames from the demo data) or a known i18n value. **Fail on any other literal.**
- [ ] **Source links:** every rendered item row has an "Open in …" link whose `href` equals the item's `source.url`.
- [ ] **AutoDS is visible:** the demo AutoDS project shows up in Work views. The `shalev396/Elytra` project shows up under Personal, not Work.
- [ ] **Calendars default to Week** on first load, and the Month toggle works and persists.
- [ ] **Clock:** the needle angle is within ±1° of the current time in `Asia/Jerusalem`, and there's one arc per demo event today.
- [ ] **Donut:** the segment counts add up to the center total, and clicking a segment filters the calendar and deadlines.
- [ ] **No secrets:** the page HTML, `localStorage`, `sessionStorage` (apart from Elytra's auth tokens), network responses and console show no token patterns. The Integrations page shows only status and metadata.
- [ ] **Accessibility:** run Elytra's existing axe-based `accessibility.py` on the new pages. No serious or critical violations.
- [ ] **Compare against principles** (from §6.1), recorded as a pass/fail table in the review report:
  - [ ] one-click drill-down,
  - [ ] live editor preview,
  - [ ] linked controls are visible,
  - [ ] at most 7 rows per list block,
  - [ ] consistent source colors,
  - [ ] no layout shift on load (skeletons),
  - [ ] dark mode parity.
- [ ] Write `client/tests/artifacts/ui-review/<date>/REPORT.md` with the screenshots, the failures, and the top 3 suggested fixes. Hand it to Shalev. **Don't deploy.**
