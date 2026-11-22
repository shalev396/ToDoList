> Spec deltas since this doc was written live in [REPORT.md](REPORT.md) under "Spec deltas".

# BACKEND.md — Elytra personal dashboard API

Status: **built and deployed** (dev). The architecture below is the original design, kept current where the build differs; the code is organised around classes (`server/src/classes/`, see [CLASSES.md](../design/CLASSES.md)): controllers, routes and MCP tools are thin and call a class, and only classes touch the database. Elytra's repo is read-only input (`shalev396/Elytra`, `main` @ `e382dc5`, 2026-10-09).
Companion docs: `DATA.md` (MongoDB model: **DATA.md wins on any naming conflict**; collections below use its PascalCase plural names and UUID string ids), `FRONTEND.md`, `BUILDER.md`, `MCP.md`, `OVERVIEW.md`.

---

## 1. What Elytra already gives us (reuse as-is)

| Area | Elytra today (from repo) | Reuse |
|---|---|---|
| Language | TypeScript, ESM, Node ≥22 (Lambda `NODEJS_24_X`, `ARM_64`) | yes |
| API | Express 5 on **one Lambda** via `serverless-http`, behind API Gateway **HTTP API**, CloudFront `/api/*` | yes |
| Auth | Cognito user pool; `/api/public/auth/*` (signup, login, refresh…), `/api/private/*` JWT checked by `expressAuth` + API GW JWT authorizer | yes, unchanged |
| DB | `DATABASE_URL` scheme picks Mongoose (`mongodb+srv://`) or Sequelize; Mongoose pool tuned for Lambda (`maxPoolSize: 2`, reused across invokes) | yes, **Mongoose only** |
| Pattern | repository interfaces (`models/definitions` + `models/mongoose`), controllers, routes declare request/response types → `types/api-contracts.ts` | yes, new repos per collection |
| Envelope | success `{ data }`, error `{ message }`, status code = truth | yes |
| Rate limit | `express-rate-limit` per surface (private 200 / 15 min / IP) | yes |
| Infra | AWS CDK, one stack per stage (`dev`/`qa`/`prod`), cdk-nag, deps layer + code layer, Composer drawing | yes, add constructs |
| Ops | direct-invoke actions (`sync-db`, `reset-db`) not reachable over HTTP | yes, same pattern for sync |
| Tests | `node:test` unit, Postman collection, Playwright, `openapi.yaml` | yes, extend |
| CI | GitHub Actions + OIDC, branch → stage | yes |

New pieces: integrations, credentials crypto, the sync job runner and a KMS key. The infra stays one Lambda, with no queue, worker or schedule constructs.

---

## 2. Language: TypeScript vs Python (UNDECIDED)

| Factor | TypeScript | Python |
|---|---|---|
| Elytra stack | native: zero rewrite, same CDK/tests/CI | rewrite API + auth + tests |
| Shared types with React frontend | direct (`api-contracts.ts`) | needs OpenAPI codegen |
| Lambda cold start | ~similar (both fast on ARM; bundle size matters more) | similar |
| Provider SDKs | `@linear/sdk`, `jira.js`, `googleapis`, ClickUp/Moodle = plain REST | official `jira`, `google-api-python-client`; Linear/ClickUp/Moodle = REST |
| Data/AI scripting later | ok | nicer |

**Recommendation: TypeScript** (Elytra is already TS end-to-end; shared types). Marked **undecided** until Shalev confirms.

---

## 3. AWS architecture (AWS first)

```
CloudFront ──/api/*──> API Gateway HTTP API ──> ApiFn (Express, the one function todolist-<stage>-api)
                                                   │ POST /sync → creates a queued SyncRun, then invokes ApiFn itself
                                                   │   (InvocationType Event, {action:"sync-run"|"gcal-run", …})
                                                   ▼
                                       the same function runs the job (sync/worker.ts)
                                         ├─ KMS Decrypt (data key)
                                         ├─ provider APIs (read only)
                                         └─ MongoDB upsert (Items, Containers, SyncStates, SyncRuns)
ApiFn ──"Sync to Google Calendar"──> Google Calendar API (the user's own OAuth connection; the one two-way sync)
Invites ──> SES directly from the request
```

- **ApiFn**: one Lambda (one role, two layers, one log group), 5 minute timeout. Provider secrets are decrypted here only for `test connection`, the sync jobs and the calendar push, through the `Credential` class, only from an `Integration`'s read or write session (see §6).
- **Background jobs**: there is no queue or worker function. A failed job is retried by Lambda's asynchronous invoke (two retries) and then dropped; the run shows `failed`. Maintenance actions (`sync-dispatch`, `gcal-dispatch`, `purge`) run only on a direct invoke.
- **No schedules for now**: no EventBridge rule exists. Bringing back one schedule (sync dispatch and purge) before prod is a TODO.md item.
- **Secrets**: `DATABASE_URL` is an environment variable of the stage. One **KMS CMK per stage** for credential envelope encryption. **All per-user secrets live encrypted in the `Credentials` collection (DATA.md §3.5)**; app-level secrets (OAuth client secrets) live in AWS Secrets Manager, in one secret per stage, `todolist-<stage>-app-secrets`.
- **MongoDB**:

| Option | Pros | Cons |
|---|---|---|
| **Atlas on AWS (recommended)** | Elytra already targets it; free/flex tier; no VPC needed; full Mongo features | external vendor; IP allowlist / PrivateLink for hardening |
| DocumentDB | AWS-native, IAM/KMS | VPC-only → Lambdas in VPC + NAT cost; not 100% Mongo-compatible; no free tier |

  Connection reuse: keep Elytra's `connectMongo()` (module scope, readyState check, `maxPoolSize: 2`). 

---

## 4. Frontend-facing API (`/api/private/*` unless noted)

All responses `{ data }` / `{ message }`. All routes workspace-scoped and checked against membership role (DATA.md).

**Auth / session** (existing Elytra, unchanged)
- `POST /api/public/auth/signup | confirm | login | refresh | forgot-password | reset-password`
- `GET /me`, `PUT /me`, existing account/export/delete routes

**Workspaces & sharing**
- `GET /workspaces` · `POST /workspaces` · `PATCH /workspaces/:wid` · `DELETE /workspaces/:wid` (owner)
- `GET /workspaces/:wid/members` · `POST /workspaces/:wid/invites` (email + role) · `POST /invites/:token/accept`
- `PATCH /workspaces/:wid/members/:uid` (role) · `DELETE /workspaces/:wid/members/:uid`

**Items** (polymorphic, see DATA.md)
- `GET /workspaces/:wid/items?kind&provider&topicId&containerId&status&dueFrom&dueTo&q&cursor&limit` (`limit` 1-100, default 50) (mirrored + local)
- `GET /workspaces/:wid/items/:id`
- `POST /workspaces/:wid/items` · `PATCH …/:id` · `DELETE …/:id`: a **local** item is edited and deleted in full. A **mirrored** item's `PATCH` is split by the server (`ItemEdit#split`): the provider fields its integration lists as writable (`writableFields`) are written back to the provider when the integration is `read_write` and the caller owns it (otherwise 409 `integration_read_only` / 403 `integration_not_owner`), and the rest are local overrides in `overlay.overrides` (a `null` clears one). Deleting a mirrored item is 409 with the source link (`openIn`).
- `PATCH …/:id/overlay`: TodoList's own fields on any item (pin, note, hidden, topic override, calendar sync, planned date, attributes; never written to a provider). With `disabled` (and `scope`: `occurrence` | `series`, `occurrenceStart`) it disables or enables the item or occurrences of its series (DATA.md §3.6, "Disabled and cancelled"): a Google series is marked on its master and every exception row at once; 400 `not_an_occurrence` for a start that is none of a series' slots, 400 for one occurrence of a series disabled as a whole, or for a travel leg. The request is checked whole first: a 400 writes nothing, its other fields included.
- `GET /workspaces/:wid/facets` → distinct providers/projects/topics/courses for filters (drives UI, no hard-coded lists)

**Views / dashboards / blocks**
Collections: `Dashboards`, `DashboardVersions`, `Views` (DATA.md §3.11–3.13). Block/dashboard schema and ops are owned by BUILDER.md (Logic Bridge, `server/src/builder/`).
- `GET|POST /workspaces/:wid/dashboards` · `GET|PATCH|DELETE /workspaces/:wid/dashboards/:id`
- `PUT …/dashboards/:id/layout` (block positions) (a block is type + query + display config, stored as data; blocks change through `ops`, there is no per-block route). All writes take `expectedVersion`; mismatch → `409` with the current version.
- `POST …/dashboards/:id/ops` (`{expectedVersion, dryRun, ops[]}`, BUILDER.md §6) · `GET …/dashboards/:id/versions` · `POST …/dashboards/:id/{undo,revert,publish}`
- `GET …/builder/catalog` · `POST …/builder/validate` · `POST …/builder/instantiate` (template → dashboard)
- `GET|POST /workspaces/:wid/views` · `GET|PATCH|DELETE …/views/:id`
- **`POST /workspaces/:wid/query`** → runs a query server-side through the Logic Bridge compiler (field whitelist + DATA.md §5 base filter). Body is **exactly one of**:
  - `{ "savedQueryId": "<Views id>" }` or `{ "dashboardId": "…", "blockId": "…" }` (the saved block query), or
  - `{ "draft": { …FRONTEND.md §4 query JSON… } }` (an unsaved editor/agent draft, for preview),

  plus optional `"vars": { "$page.topic": "work", "$page.provider": "jira", "$page.range": "this_week" }` = **runtime cross-block filter values**, and `"preview": true` (caps at 20 rows, 2 s timeout, never writes). Response: `{ rows | groups, total, appliedVars, warnings[] }`. Every row carries `source.url` for "Open in <provider>".

**Integrations**
- `GET /workspaces/:wid/integrations` → `[{ id, provider, accountLabel, status: "connected"|"expired"|"error", expiresAt, lastSyncAt }]`. **That is the whole shape**: no token, no masked hint, no last-4, no prefix. Sanitized error details live on `GET /sync-runs`.
- `POST /workspaces/:wid/integrations` (provider + non-secret config) · `PUT /workspaces/:wid/integrations/:iid/credential` (the secret; **write-only**, returns `204`, never echoed, body excluded from logs)
- `POST /workspaces/:wid/integrations/:iid/test` → `{ ok, accountLabel }`
- `PATCH /workspaces/:wid/integrations/:iid` body `{mode?, label?, topicId?, config?, expiresAt?}` (at least one; its owner only). `mode` is `read` (the default, nothing is ever changed at the provider) or `read_write` (audited as `integration.mode`). Rotating the secret is `PUT …/credential`, not this route.
- `DELETE /workspaces/:wid/integrations/:iid` (its owner; wipes the ciphertext, then soft-deletes its items and containers). The only flag is `?removeAdded=true` (Google Calendar, read & write): first deletes what TodoList pushed to the calendar. Answers `204`, or `200` with the clean-up's counts when `removeAdded` ran, or `409 cleanup_incomplete` (out of time; the integration stays connected, call again). Audited as `integration.cleanup`.

**Sync**
- `POST /workspaces/:wid/sync` (all) · `POST /workspaces/:wid/integrations/:iid/sync` → creates a queued run, starts the background job and returns `{ runId }` (`202`)
- `GET /workspaces/:wid/sync-runs?integrationId&limit` → status, counts, sanitized error

**Primary calendar** (the owner's choice of where dated items are pushed)
- `GET|PUT|DELETE /workspaces/:wid/primary-calendar`: the workspace's one primary calendar (`settings.primaryCalendar`), set by the workspace owner from a read & write Google Calendar integration they own. `POST …/integrations/:iid/remove-pushed` removes what a push added, on request only.

**Sync to Google Calendar** (the two-way sync, OAuth only, once the integration is read & write)
- `POST /workspaces/:wid/gcal-sync` body `{ integrationId, confirm? }` (a dry run unless `confirm`) → the Logic Bridge diffs the dated items its owner may see against `CalendarLinks`, then ApiFn pushes through the Google Calendar API with the integration's OAuth connection. Only the integration the primary calendar is on pushes (409 `calendar_not_primary` for any other); the target calendar is the workspace's primary calendar, not a request field.
  - **Auth:** the refresh token is opened by `Credential` inside the integration's write session. Idempotent via deterministic event ids and `extendedProperties.private.origin`.
  - Events changed in Google are pulled back on the next push (with echo, last-write-wins and tombstone handling).
  - Every write is recorded in `AuditLogs` (`action: "gcal.write"`) and counted in `SyncRuns`.
  - There are no inbound hook routes: the Apps Script bridge was removed.

**Agent keys** (for MCP, MCP.md §4)
- `GET|POST /workspaces/:wid/agent-keys` · `DELETE …/agent-keys/:id`. `POST` returns the raw `elk_…` key **once**; only `keyHash` is stored in `AgentKeys`. MCP clients can also sign in with OAuth (TodoList is its own authorization server under `/api/mcp/oauth`: authorize, token, register, revoke and the metadata documents; the consent page calls `/api/private/mcp-oauth/requests/:id`), which creates a grant row in the same collection (MCP.md §4).

---

## 5. Sync jobs (the mirror into the app)

| Provider | Auth | Pulls | Topic rule |
|---|---|---|---|
| Google Calendar (personal) | Google OAuth | events in window | by calendar |
| Jira | API token + email (basic) — expires ≤ 365 d | issues assigned/watched, JQL `updated >= lastCursor` | Work |
| ClickUp | personal `pk_` token | tasks assigned, `date_updated_gt` | Work |
| Linear | personal API key (read-only scope) | issues/projects, `updatedAt > cursor` | Personal |
| Moodle (Braude) | web service token (if allowed; fallback: mobile app token) | courses, assignments, calendar events | College |
| GitHub (optional) | fine-grained PAT, read-only | issues/PRs | by repo name rule |

Rules:
1. **Upsert by source key** `{workspaceId, source.provider, source.accountId, source.externalId}` (unique index, DATA.md §4/§6). Store `source.updatedAtSource` and `source.hash`; skip no-op writes (only `lastSeenAt` is bumped).
2. **Closed-at-source**: status mapped to `done`/`cancelled` with `closedAt` (item kept). Items missing from a full sweep get `deletedAt` (soft delete), hard-deleted 30 days later (DATA.md §4).
3. **Sync never writes.** The sync's HTTP clients are GET-only by construction (a wrapper refuses non-GET except allow-listed GraphQL reads). Writing to a provider is a separate path: every connection starts read-only, and only its owner can switch it to read & write; then provider writes (a create, a write-back, the calendar push) go through `Integration#withWriteSession`, the one gate that refuses demo data and read-only integrations, using the writers under `classes/integration/writers/` (`writePaths.test.ts` pins every call site). Every write is audit-logged.
4. **Source link** on every item: `source: { provider, url, externalId }` → "Open in <provider>" buttons. The sync job fails the item (not the run) if no URL can be built.
5. **Topic classification** (data, not code): a container whose name matches a rule in `settings.topicRules` (e.g. `shalev396/*`) goes to that topic; otherwise the integration's topic; otherwise Unsorted. Rules live in workspace settings.
6. **AutoDS included**: no provider/project exclusion in the app. The "AutoDS mute" applies only to Remi's assistant messages, never to API/data.
7. Cursor per integration × resource in `SyncStates` (`cursor`/`syncToken`, `lastFullSyncAt`) + one `SyncRuns` doc per run with counts.
8. **Slack: out of scope** for the app (AI uses it via MCP).

---

## 6. Token handling — HARD RULE

- **Encrypt at rest**: envelope encryption. Per credential: `KMS GenerateDataKey` → AES-256-GCM encrypt token with random 96-bit IV, AAD = `workspaceId|integrationId|provider`. Store `{ciphertext, iv, authTag, encryptedDataKey, kmsKeyId, v}` only. Plaintext data key discarded immediately.
- **One sanctioned decrypt path** (DATA.md §3.5): the `Credential` class (`classes/integration/Credential.ts`), reached only through an `Integration`'s read and write sessions, for outbound calls (sync jobs, `test connection`, write-back, the calendar push). Plaintext is scoped to a single function call; never cached on module scope, never written to disk or the DB. `vaultImports.test.ts` fails if any other module (including `server/src/mcp/**`) imports it, and `adapterSecrets.test.ts` that an adapter names a secret.
- IAM: the function role gets `kms:Decrypt` with an encryption-context condition. ApiFn gets `GenerateDataKey` for saving.
- **Never returned** in any form, to the user, UI, logs or agents: Mongoose `select: false` on `enc` + a `toJSON` transform that deletes it; the integration DTO is built from an allow-list: `{id, provider, accountLabel, status, expiresAt, lastSyncAt}`. **No `tokenHint`, no last-4, no prefix.**
- **Log redaction**: one logger wrapper replaces `console.*`; redacts keys matching `/token|secret|authorization|password|key|cookie/i` and values matching known token shapes (`pk_…`, `lin_api_…`, `ATATT…`, `Bearer …`). Provider error bodies are reduced to `{provider, status, code}` before logging or storing as `lastError`.
- ⚠️ Elytra's `errorHandler` returns `error.message` to the client: wrap provider errors in a sanitized `AppError` so a raw provider message can never leak.
- **Tests (CI-blocking)**: (a) create integration → every route response JSON-scanned for the plaintext token = must be absent; (b) logger unit test with token fixtures → redacted; (c) DB doc contains no plaintext; (d) tamper AAD → decrypt fails; (e) Postman test asserting `GET /integrations` has no `token`/`credential` fields.

---

## 7. Project constraints carried into the backend

- **Minimal hard-coded text**: API returns data + keys only; labels/titles come from source data or saved dashboard config. Enum labels are i18n keys (Elytra already has `client/src/i18n`).
- **Every item has `source.url` + `source.provider`** (local items: deep link into the app).
- **AutoDS**: included in all data/views (muted only in Remi's messages).
- **Personal vs Work**: by project name containing his name (`shalev396/*`), data-driven rule.
- **College** = Moodle courses/assignments/events.
- **Sources of truth** = providers; the sync mirrors them into the app. Writes back to a provider happen only for a read & write integration through the write gate (§5 rule 3). `local` items are owned by the app, and Google Calendar has the two-way push to the workspace's primary calendar (audit-logged).
- Google Calendar uses OAuth (a separate Google app, see INTEGRATIONS-SETUP.md). Long-lived tokens for the rest (Linear key, ClickUp `pk_`, Jira API token ≤365 d, Moodle web service token).

---

## 8. Folder structure (additions to `server/`)

```
server/src/
  classes/                           # the object model (CLASSES.md): the only code that touches the database
    base/ policies/ integration/ item/ workspace/ calendar/ sync/ dashboard/ mcp/
    AgentKey.ts AuditLog.ts ConnectLink.ts User.ts Media.ts
  routes/ controllers/               # thin: parse input, call a class, toView()
  models/{definitions,mongoose}/     # repository interfaces and Mongoose models (used by classes only)
  migrations/                        # data migrations run by sync-db (frozen raw scripts)
  builder/                           # Logic Bridge (BUILDER.md): schema, catalog, compile, ops, lint (pure)
  mcp/                               # MCP server: tools, auth, OAuth metadata, pipeline
  services/crypto/                   # envelope (KMS + AES-256-GCM), key providers, hashing
  services/                          # pure helpers, zod schemas, the logger, invite delivery, stage maintenance
  sync/                              # dispatcher, worker, read-only HTTP client, provider adapters, fixtures
  gcal/                              # diff (pure) and the scheduled push entry
  jobs/                              # purge, seed
  seed/                              # the demo workspace, through classes
server/class-boundary.mjs            # what may load the database (ESLint + classBoundary.test.ts)
server/infra/lib/constructs/…        # one function and role, KMS CMK (no queue, worker or schedule)
```

## 9. Env / config

Deploy files hold only `AWS_ACCOUNT_ID`, `CERTIFICATE_ARN`, `WAF_WEB_ACL_ARN`, `AWS_ROLE_NAME`, `AWS_REGION`, `DATABASE_URL`, `BASIC_AUTH_PASSWORD` (dev, qa) and `DOMAIN_NAME`. Nothing else is configurable by an environment variable: behaviour is fixed in code. CDK sets the plumbing on the function (`ENV`, `DATABASE_URL`, `DOMAIN_NAME`, the bucket, Cognito ids and `KMS_KEY_ID`). Provider tokens are **never** env vars or Secrets Manager entries: they are per-integration encrypted `Credentials` docs.

## 10. Local dev

- Same as Elytra: `npm run dev` (Express on :3000 against the deployed `dev` stack: its Cognito, database and resources). There is no offline mode and no local database.
- Background jobs run in-process in the local API.
- Provider fixtures for unit tests (mapping + topic rules): no live calls in CI.

## 11. Deploy tool

| Tool | Verdict |
|---|---|
| **CDK (recommended)** | already Elytra's; tests + cdk-nag + Composer exist; just add constructs |
| SAM | simpler YAML, but second IaC stack |
| Serverless Framework | v4 needs a license for orgs; extra dependency |

Deploy stays `npm run deploy:backend -- <stage>` and branch-push CI.

## 12. Errors, rate limits, backoff

- API: `AppError(statusCode, safeMessage)`; 4xx for validation/permission, 409 for mirrored edit, 502 for provider failure (sanitized).
- Sync jobs: per-item failures recorded, run continues; integration status → `error` after N consecutive failed runs; `auth_failed` (401/403) stops retries and surfaces "reconnect".
- Lambda's asynchronous invoke retries a failed job twice; after that it is dropped and the run shows `failed`. There is no dead-letter queue.
- Shared backoff: exponential + full jitter, honor `Retry-After` / reset headers.

| Provider | Limit to respect | Handling |
|---|---|---|
| Linear | 2,500 req/h per key + query complexity | paginate 50–100; watch `X-RateLimit-*` headers |
| ClickUp | 100 req/min per token (≤ Business plan) | throttle ~1.5 req/s; `X-RateLimit-Reset` |
| Jira Cloud | burst/per-endpoint, 429 + `Retry-After` | honor header; JQL incremental |
| Moodle | admin-defined | low concurrency (1), small batches |
| Google Calendar | per-user and per-project quotas | batch upserts, back off on 403/429 |
| GitHub | 5,000 req/h per PAT | conditional requests (ETag) |

---

### Open questions
1. TS confirmed? 2. Atlas vs DocumentDB? 3. Which schedule returns first (sync dispatch and purge, before prod)? 4. Braude Moodle token availability (unverified). 5. On disconnect: keep or purge mirrored items?
