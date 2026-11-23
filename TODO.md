# TODO: Shalev's notes (2026-11-12 night) as one checklist

The source of truth for what's next. `[x]` = done and verified. `[~]` = in progress. `[ ]` = not started.
Build history and rulings live in `docs/dashboard/DECISIONS.md` and `docs/dashboard/REPORT.md`.

## Status

All work lives on the `dev` branch. Nothing is deployed yet. The architecture is fixed: one Lambda (`todolist-<stage>-api`), no queues, workers or schedules, no feature switches (the only env vars are the 8 in `server/.env.example`), no local/offline mode and no Apps Script bridge. See `docs/dashboard/DECISIONS.md`.

**Done:** the night list (A to G), H2 dynamic topics, H4 logic v2, H7 pricing from shared limits, H8 app secrets in Secrets Manager, H9 OAuth for the other providers, H10 the Saffron & Sand palette, H11 the landing rework.

**Open:** H1 permissions v2, H3 + H6 views and templates, H5 creating a to-do in providers, H12 final verification (whole-branch review, the stage-backed E2E, the landing notes), the first deploy of each stage, and the list below.

## Before prod

- [x] P1. One schedule (sync dispatch + purge). Done: the stack's one EventBridge rule runs `sync-dispatch` every whole hour (2026-11-17), and since 2026-11-23 its 01:00 UTC tick also runs the purge, once a day on every stage (`server/src/jobs/PurgePass.ts`, `PURGE_HOUR_UTC`): items and containers deleted more than 30 days ago, sync runs left `running`, and what deleted workspaces left behind. The privacy policy now promises "deleted for good 30 days later, by a clean-up that runs every day". Still on a direct invoke only: the Google Calendar push and pull (`gcal-dispatch`, B7).
- [ ] P2. Decide whether a failed background sync or invite email needs a retry beyond Lambda's two async retries (there is no dead-letter queue).
- [ ] P3. First deploy of each stage: the first run can fail on Cognito while SES verifies the domain; re-run it (see `docs/deployment.md`).

## A. Today's priorities (in this order)

- [x] A1. Rename "organization" to **workspace** everywhere: UI text (en and he), routes, component names, docs. The server already uses "workspace". Done: wording, code names, error codes, Hebrew מרחב עבודה.
- [x] A2. Invites work like Google Drive: Done: Share dialog (Can view / Can edit email invites with role-specific emails, People with access, General access join link + Copy link).
  - send an email invite with a role picked first (**Can view** or **Can edit**), and the email says the right thing;
  - or copy a link.
- [x] A3. Google Calendar the proper way: Done: OAuth (PKCE, single-use state, browser-binding cookie), many accounts, calendar picker, pushes through the Calendar API, revoke on disconnect. Real Google needs the secrets (INTEGRATIONS-SETUP §1).
  - OAuth, with a Google app separate from sign-in;
  - closed beta (testing mode) on dev and QA, Google verification only for prod;
  - the Calendar integration uses it; the Apps Script bridge is removed.
  - See "Answers" below.
- [x] A4. Write `INTEGRATIONS-SETUP.md`: the per-platform steps to register proper auth for Google Calendar, Google Drive, GitHub, Jira, ClickUp, Linear and Moodle.
- [x] A5. Dashboard builder works end to end:
  - logic operators and data sources;
  - choose one or more **connectors** (integrations) per block;
  - every integration syncing;
  - tested by the stage-backed E2E.
- [x] A6. MCP test, plus an **agent plugin** that Claude Code, Cursor and other agents can install. It includes: Done: `agent-plugin/` (Claude Code plugin: `.mcp.json`, 4 skills, hooks enforcing search-before-create, verb-first titles, area + due/someday, idempotency, preview-before-builder-write; Cursor `mcp.json` + rule). `npm run mcp:smoke` plus an in-process smoke test. `claude plugin validate` passed.
  - the MCP server config;
  - skills on how to use TodoList;
  - hooks that enforce the task methodology, e.g. tasks only get added through the proper tools and flow.

## B. Integrations

- [x] B1. Many-to-one: several connections of the same provider in one workspace (another Google Calendar, another Jira…). The UI gets a "Connect another" action. Done: every provider lists all its connections and offers "Connect another"; a duplicate account is a 409 `account_already_connected`.
- [x] B2. GitHub via OAuth (GitHub App with user tokens), after Google. Done in H9.
- [x] B3. The rest via proper auth, after Google. Jira, ClickUp and Linear are done in H9. Drive stays a service-account share and Moodle a per-site token (ruled).
  - Jira (Atlassian OAuth 2.0 3LO);
  - ClickUp OAuth;
  - Linear OAuth;
  - Moodle (no OAuth: a per-site token).
- [x] B4. The Integrations page is complete and polished: cards, connect flows, status, sync, "connect another". Done: one card per connection (label, status, last sync, Test, Sync now, Disconnect) with "Connect another" on every provider; localized errors.

- [x] B5. Google Calendar two-way for OAuth pushes. Today, edits or deletions made in Google to events we pushed aren't picked up, so a deleted event can come back on the item's next update. Done: OAuth pushes pull our own events and apply echo, last-write-wins and tombstone handling (`applyCommit`).
- [x] B6. Calendar writes are always on for OAuth integrations (no switch).
- [ ] B7. A scheduled Google Calendar sync for OAuth integrations (push plus the two-way pull). Removed with the schedules; comes back with P1. The `gcal-dispatch` action still runs on a direct invoke.

## C. Platform / infra (tomorrow and later)

- [~] C1. Move to AWS: dev, QA and prod through CDK. The architecture is simplified (one Lambda, no queues or schedules) and local runs against a deployed stage. Needs the first deploy (P3). Shalev has the DB server ready.
- [x] C2. Load protection: API Gateway stage and per-route throttles plus Lambda reserved concurrency. Background syncs are an async self-invoke of the one function; emails go straight to SES.

## D. Pages, views and builder

- [x] D1. A new workspace starts with **one empty Personal page**. All the other pages exist only if sample data is chosen. Done.
- [x] D2. Done as H2. **Dynamic topics/pages**: add, rename and remove them (e.g. "Acme Corp", "Night job"). Work, College and Personal are just defaults.
- [ ] D3. Decided; now H3. **Views per page as tabs**:
  - Summary: the dashboard, the default;
  - List: every task, with filters and sorting;
  - Timeline: time left to right, tasks top to bottom, day/week/month;
  - Board.
  - Research Jira, ClickUp, Linear and Notion views for more.
- [ ] D4. Decided; now H3 (the page-variables panel). Optional **global page controls**: a default landing view and shared filters.
- [x] D5. Done via H4. **Mixpanel-style logic inside blocks**: sort, include/exclude, rename the block, filter by any property (priority, status, source, dates…). "Our own little language".
  - Design doc FIRST: data types, how it maps to MongoDB, mixing many sources.
- [x] D6. **Per-block connectors**. Example: "every task from ClickUp and Jira → this List, ordered by status", configured in the editor, and the block updates when you press Done.
- [ ] D7. Decided; now H6. **Richer templates**: dashboard templates, templates per view, and per-persona templates.

## E. UI quality

- [x] E1. shadcn everywhere: Done: editor selects converted too; native-select removed; raw-control audit done (custom visuals deliberately kept).
  - replace native `<select>` with shadcn Select, which follows dark and light themes;
  - audit buttons and dropdowns;
  - import the missing components into `components/ui`, add variants, and use them app-wide.
- [x] E2. Scrollbars: use shadcn ScrollArea for every scroll region, and fix the broken ones. Done: ScrollArea on sheets, sidebar, ⌘K, block bodies and kanban.
- [x] E3. Responsiveness: for example, Personal with sample data has overflowing sources. Scale better and avoid scrolling where possible. Done: phone blocks stack at content height; tables scroll inside ScrollArea.
- [x] E4. Keyboard shortcuts: "g d" doesn't work. Fix them, and make them discoverable (hints in ⌘K and tooltips). Done: chords read the physical key (the likely cause was the Hebrew layout); `?` opens a shortcuts dialog; ⌘K and tooltips show hints.
- [x] E5. Saffron & Sand applied (H10). A new colour palette: not black/white, and none of the palettes Shalev used in his other projects. Check his site's projects in a headless browser, not his own. **Your pick needed:** 3 validated options are in `docs/design/PALETTE-OPTIONS.md`, with swatches in `docs/design/palette-options/`. Recommended: Saffron & Sand.

- [x] E6. Small UI fixes found by the agents: Done.
  - the "Let agents publish dashboards" switch is 36×20 px (below the 44 px touch target);
  - the template gallery lists topics that are switched off.

## F. Landing page, pricing, legal

- [x] F1. Built in H11, waiting for Shalev's notes. Hero: keep the clock and deadlines, but make them live. Every ~30 s an item is added or marked done, drawn from a bank of demo events.
- [x] F2. Built in H11, waiting for Shalev's notes. "Connect → build → share": show it as a visual flow in the style of Trello and ClickUp marketing. No numbered arrows, less text.
- [x] F3. Built in H11, waiting for Shalev's notes. "Built for everyone" instead of "for someone who studies and works": two example dashboards, a light student week and a packed one (two jobs + studies + a side project).
- [x] F4. Built in H11, waiting for Shalev's notes. Keep "Your day as a clock, your week as a calendar".
- [x] F5. Built in H11, waiting for Shalev's notes. New "Logic at every turn" section: a pseudo-animation that focuses a block → Edit → Logic → changes the filter to "only important".
- [x] F6. Built in H11, waiting for Shalev's notes. Replace the messy 4-block grid with **one showcase that rotates** (carousel logic, its own UI). Don't crowd many items into one line.
- [x] F7. FAQ: add "Is it open source?", answered "Yes", with a repo link (placeholder until the repo exists). Done: placeholder `repositoryUrl` in `data/app.ts`.
- [x] F8. Pricing: Done.
  - one **Individual** plan, free, no limits;
  - "Business or school? Contact us", which emails Shalev.
- [x] F9. **One source of truth for the contact email**, used by pricing and the privacy policy. Done: `app.contactEmail` is the single source.
- [x] F10. LAST: update the Terms of use and Privacy policy for the final product: every integration, how connections are stored (encrypted, write-only), and how access tokens are used. Done: both pages rewritten (en + he), then made ready for launch on 2026-11-23 (no review banner, sub-processors, Israeli law, #62 to #64), email and repo from `data/app.ts`. The free plan wording is "no feature limits, fair use, with sensible technical safeguards"; change it if you want different wording.

## G. Housekeeping and verification

- [ ] G2. The demo data (`server/src/seed`, loaded with `loadDemoData` on dev and qa) may be edited freely until the move to AWS.
- [x] G3. At the end: a verification agent checks that every change works and looks right (screenshots, E2E). Done:
  - every gate green: server 2268 unit, secrets, gcal 98, mcp 213, infra 171, layers; client 436;
  - E2E 254 passed with 2 known non-product failures;
  - MCP smoke 5/5; plugin validates.
  - The visual defects it found were fixed in N8 (filter chips, editor radio, Share dialog scroll, integration cards, Tasks block, pricing and hero balance, shortcuts focus, plugin icon).
- [x] G4. Final review blockers (generic 5xx) and 8 security minors are fixed. All suites are green (see `docs/dashboard/REPORT.md`).

## H. Shalev's decisions, 2026-11-13 (today's list)

- [~] H1. **Permissions v2.** Integrations belong to one user in one workspace. Rules:
  - share-on-attach;
  - only your own connectors can be added to a block;
  - other members appear only as "name + provider icons";
  - no topic scoping;
  - all enforced on the server.
  - Spec: `docs/design/PERMISSIONS-V2.md` (23 edge cases with rulings).
- [x] H2. **Dynamic topics** (D2 decided). Free-text names with standardized slugs; Work, College and Personal are only defaults. Deleting a topic removes its pages, views, layout and filters. Items stay, as "Unsorted". Done:
  - a Topics collection with slugs that never change;
  - add, rename and delete;
  - deleting a page keeps its items, which become Unsorted;
  - member area scoping removed;
  - migrations rewrite stored queries.
- [ ] H3. **Views** (D3 decided).
  - Summary is the fixed default and is fully editable.
  - Addable views: List, Board, Timeline, Calendar, Table, Gallery, Agenda, Workload. Each starts custom or from a view template.
  - A page-variables panel shows while editing.
- [x] H4. **Logic v2** (D5 decided; report: `.superpowers/sdd/2026-11-11-todolist-dashboard/task-H4-report.md`):
  - Mixpanel's full operator set;
  - the sentence-style editor as default;
  - **importance per page**, with presets: Weighted, Deadline first (EDF), Shortest first (SJF), Fair queue (HRRN: small tasks first, big ones age up so they never starve);
  - **custom attributes** defined per workspace, e.g. Importance 1–5;
  - provider custom fields shown with the provider logo.
- [ ] H5. **Create a local to-do in providers too.** Pick targets (Jira site → project → issue type; ClickUp workspace → space → folder → list; Linear team → project; GitHub repo). Each target ticks when created.
  - Only your own integrations, an explicit action, audited.
  - A write path separate from the read-only client.
  - This deliberately changes the old "never write to providers" rule, at Shalev's request.
- [ ] H6. **Templates:** Light student and Two jobs + studies + side project (the main two), plus Student + job.
- [x] H7. **Pricing feature list from variables** (limits from one source): supported integrations, MCP access, unlimited to-dos, N workspaces, N blocks, N views, template views and blocks. Wording: "no feature limits", with a workspace limit. Done: one Individual plan. Every number comes from `PLAN_LIMITS` (`server/src/types/limits.ts`), shared by the server, the builder caps and the pricing page.
- [x] H8. **App secrets in AWS Secrets Manager.** A generic service: Google Calendar OAuth now; OpenRouter, Linear and others later. Done: `services/appSecrets.ts`.
  - Reads ONE secret per stage, `todolist-<stage>-app-secrets` (flat UPPER_SNAKE keys), allow-listed by logical name (google-calendar-oauth, openrouter, oauth-github/jira/clickup/linear), cached 1 h. Secrets Manager only, never env vars. The backend deploy creates it as `{}`; the stack does not own it.
  - IAM grants GetSecretValue on `todolist-<stage>-app-secrets` only.
  - The how-to-add steps are in DEPLOY-PLAN and INTEGRATIONS-SETUP.
- [x] H9. Done and merged (`1375561`), reviewed, all gates green. **OAuth for the other providers** in code (GitHub, Jira, ClickUp, Linear), with mocks, plus in-app setup instructions on the Integrations page.
- [x] H10. **Apply the Saffron & Sand palette** (E5 decided). Done: tokens and `DESIGN.md` updated, light and dark, AA checked, solid focus rings.
- [x] H11. **Landing rework (F1–F6),** then run it and show Shalev for notes. Built:
  - live hero (a 40-step script, every 30 s);
  - connect, build, share scenes;
  - a light and a packed week toggle;
  - the logic walkthrough;
  - one rotating showcase;
  - FAQ kept.
    To show Shalev at the end (H12).
- [ ] H12. Final verification, then hand-off.

## Needs Shalev

- The first deploy of each stage (fill `server/.env.<stage>`; see `docs/deployment.md`).
- Google Cloud project(s) + the Secrets Manager secret for Calendar OAuth on dev (`INTEGRATIONS-SETUP.md` §1).
- OAuth apps, once H9 merges. The callback is `https://<stage-domain>/api/public/oauth/<provider>/callback`. Add `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` to `todolist-<stage>-app-secrets`. Full steps are in `INTEGRATIONS-SETUP.md` and in the in-app setup guide.
  - **GitHub:** a GitHub App. Turn on user authorization during install, keep expiring user tokens on, and grant read-only Metadata, Issues, Pull requests and Organization Projects. H5 will also need Issues: Read & write.
  - **Jira:** an Atlassian 3LO app with `read:jira-work`, `read:jira-user` and `read:me` (H5 adds `write:jira-work`).
  - **ClickUp:** an app with the redirect URL.
  - **Linear:** an OAuth app with `read` (H5 adds `issues:create`).
- Your notes on the new landing page (H11), when I run it for you at the end.

## Answers to Shalev's questions

**Google sign-in vs Google Calendar.** You're right: these are two separate concerns.

- **Sign-in.** Use Cognito with Google as a federated identity provider, scopes `openid email profile`. Cognito issues its _own_ tokens and does not hand the app a usable Google API token, so it can't be used for Calendar.
- **Calendar access.** Use a **separate Google OAuth client**, ideally in a **separate Google Cloud project**, so it gets its own consent screen and its own verification. The scope is `calendar.events`, requested with `access_type=offline`.
  - Our backend runs the authorization-code flow with PKCE.
  - The flow starts from the signed-in app, and a signed, single-use, 10-minute `state` binds it to _that_ user + workspace + integration. That is how the Google account maps to our user.
  - The Google account's id and email become the integration's `accountId` and label. That gives many-to-one: several Google accounts per workspace.
  - The refresh token is sealed in our existing vault (KMS envelope) and never leaves the server.
  - The client id and secret live in **AWS Secrets Manager** per stage. CDK references them; you paste the values.
- **Verification.** Dev and QA stay in Google's _Testing_ mode, with up to 100 listed test users: the closed beta. Prod goes through verification, which is needed for the sensitive `calendar.events` scope.
- **Drive.** `drive.readonly` is a _restricted_ scope, which means a paid security assessment. Prefer `drive.file` plus the Google Picker.

**A queue in front of every Lambda request?**

- Not for the interactive API. HTTP calls need an answer in the same request.
- The synchronous API is protected by API Gateway throttling (a rate and a burst per stage and route), Lambda reserved concurrency (a cap on MongoDB connections) and connection reuse.
- Work that needs no immediate answer (provider syncs) runs as an asynchronous invoke of the same function; emails go straight to SES. No SQS for now (decision in `docs/dashboard/DECISIONS.md`).
