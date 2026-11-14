# DEPLOY-PLAN.md

How to take TodoList from the local build to AWS, dev first.

> **Status: NONE of these steps have been executed.** TodoList has never been deployed and never pushed. No AWS resource, Atlas user, domain, certificate, GitHub repository, environment, secret or variable exists yet. Every step below is a plan.
>
> Steps marked **NEEDS SHALEV** require his account, a decision or his explicit go. Nothing here is run without that go. Only variable and secret **names** appear in this file, never values.

## 0. What a deploy creates (from the infra code)

Per stage `todolist-<stage>`:

- ONE Lambda function, `todolist-<stage>-api`, with its two layers, one log group and ONE role (`todolist-<stage>-api`, the ARN Atlas maps). It serves the HTTP API (public routes, private routes, and `ANY /api/mcp` without a Cognito authorizer: agents use hashed agent keys), the direct-invoke actions, and the background syncs: a sync is an async invocation of the function by itself (`{"action":"sync-run",…}` or `{"action":"gcal-run",…}`), so the role may invoke that one function;
- the frontend hosting (CloudFront, the two buckets) and the SES identity with its DKIM records (no verification function: the user pool waits for the distribution, which waits for the DKIM records);
- one KMS CMK, alias `alias/todolist-<stage>-credentials`, rotation on; RETAIN on qa/prod, DESTROY with a 7-day window on dev;
- read access for the role to the stage's app secrets: `secretsmanager:GetSecretValue` on `todolist/<stage>/*` only. The secrets themselves are made by hand (step 12); the stack holds no value.

No queue, no worker function, no alarm and no schedule (C0-ARCH, like Elytra). `sync-dispatch`, `gcal-dispatch` and `purge` run only when the function is invoked with them directly, until a schedule is added back. The infra is stage-generic. `npm run test:infra` synthesizes all three stages offline.

## 1. Dev stage

Run the steps in order. A reviewer should read the synthesized template (`npm run synth:composer` and the CDK diff) before the first `deploy:backend`.

### Step 1. Domain and certificates (NEEDS SHALEV)

1. Choose the dev hostname (no www alias: a stage serves `DOMAIN_NAME` only).
2. Create or import an ACM certificate for it (CloudFront certificates live in `us-east-1`).
3. Point DNS at the stack once it exists.
4. Record the values in the `dev` GitHub environment (step 5): variable `DOMAIN_NAME`; secret `CERTIFICATE_ARN`. Both are optional; without them dev runs on the default CloudFront and API URLs.

### Step 2. MongoDB Atlas user for `todolist-dev-api` (NEEDS SHALEV)

1. In Atlas, create a project or cluster for dev, on AWS.
2. Add a database user of type AWS IAM mapped to the role `todolist-dev-api`, with `readWrite` on the dev database only (suggested name `todolist_dev`). It is the stack's only role (HTTP, actions and background syncs all run in the one function), so nothing else needs a user.
3. Set Network Access to what the Lambda needs.
4. Put the connection string, without a password, in the `dev` environment secret `DATABASE_URL`.
5. After the first deploy, run `sync-db` once against dev to create indexes. Never `reset-db` against a deployed stage.

### Step 3. KMS CMK per stage (created by the deploy; NEEDS SHALEV approval)

1. The CDK creates the key; there is nothing to create by hand.
2. Approve the first `deploy:backend` knowing it creates a KMS key (and no queue, schedule, alarm or second Lambda).
3. Confirm the deploy role can manage it (see step 6).
4. Confirm `KMS_KEY_ID` is on the function (wired by CDK). The key policy stays the default; the API role gets the grant through its identity policy, limited to the encryption context keys `workspaceId`, `integrationId`, `provider`.
5. qa and prod keys are retained on stack deletion; dev's is destroyed after 7 days.

### Step 4. Alarm destination (not needed now)

There is no queue, DLQ or alarm (C0-ARCH), so there is nothing to route to SNS. A background sync that still fails after Lambda's two retries is dropped; its run shows `failed` in the app (or stays `running` until a `purge`).

### Step 5. GitHub repository, environments, variables and secrets (NEEDS SHALEV)

1. Create the GitHub repository and push `main` and `dev` (a push is a remote change and needs his go; the local branches are `main` for the raw import and `local/dashboard` for all work).
2. Create the GitHub environments `dev`, `qa`, `prod`. Add required reviewers on `qa` and `prod`.
3. Names the workflows read:
   - repository secret: `AWS_ACCOUNT_ID`;
   - repository variable: `AWS_ROLE_NAME` (the deploy role name), optional `AWS_REGION` (default `us-east-1`);
   - per-environment secrets: `DATABASE_URL`, optional `CERTIFICATE_ARN`, optional `WAF_WEB_ACL_ARN`, `BASIC_AUTH_PASSWORD` (dev gate, step 7);
   - per-environment variables: optional `DOMAIN_NAME`.
4. No new secrets or variables are required for sync, KMS or MCP: CDK wires them. App secrets (OAuth clients, API keys) are not GitHub secrets either: they live in Secrets Manager (step 12).

### Step 6. OIDC role, scope `todolist-*` (NEEDS SHALEV)

1. Create the GitHub OIDC provider in the AWS account if it is missing.
2. Create the deploy role named in `AWS_ROLE_NAME`, trusted by this repository only.
3. Scope its permissions to resources named `todolist-*`. It needs at least: CloudFormation/CDK and `kms:*Key` and alias actions (no SQS, Scheduler, CloudWatch alarm or event source mapping permissions: the stack has none). It must not reach any Elytra stack.
4. The runtime roles are created by the stack (`todolist-<stage>-api`).

### Step 7. WAF basic-auth gate for dev (NEEDS SHALEV)

1. Dev holds only dummy data, but it is public. Put a WAF web ACL with HTTP basic auth in front of it.
2. Store the ACL ARN in the `dev` secret `WAF_WEB_ACL_ARN` and the password in `BASIC_AUTH_PASSWORD`.
3. Cognito handles real sign-in behind the gate.

### Step 8. Provider sync (no switch)

1. Every stage syncs live: there is no sync-mode setting. Recorded provider fixtures remain only as a test utility (tests force them in code); the dev stage no longer replays them.
2. A new workspace on dev or qa can load demo data on creation (`loadDemoData`, `seedWorkspace`); prod refuses it.

### Step 8b. Creating to-dos in providers (H5, D19)

1. Creating a to-do in a user's own Jira, ClickUp, Linear, GitHub or Google Calendar is always on, on every stage. It is an explicit user action, audit-logged, and there is no setting to turn it off.
3. The GitHub App needs **Issues: Read & write**, the Atlassian app `write:jira-work`, the Linear app `issues:create`. See `INTEGRATIONS-SETUP.md`. Used only when a user creates a to-do there.
4. Every create is audit-logged (`provider.create`: integration, provider, resulting key or id; never a title or a token) and limited to 30 per user per provider per hour (`PLAN_LIMITS.providerCreatesPerHour`), counted per user and provider across workspaces by an atomic counter reserved before the provider is called.

### Step 9. Google Calendar sync (OAuth)

1. The two-way Google Calendar sync uses the user's own Google sign-in (OAuth) and is always available on every stage; there is no switch. A calendar write happens only when a user configures a push and confirms it. No schedule runs it for now: the `gcal-dispatch` action starts one push + pull per eligible calendar when the function is invoked with it directly. A schedule comes back later.
2. The Google OAuth client lives in Secrets Manager as `todolist/<stage>/google-calendar-oauth` (step 12). See `INTEGRATIONS-SETUP.md`.
3. The Apps Script bridge is gone: no script, no hook route, no shared secret.
4. With H5 (D19) a user may also create one item at their own provider (Step 8b). Both are audit-logged.

### Step 10. First deploy and checks (NEEDS SHALEV go)

1. Merge to `dev` triggers `push-dev.yml`: lint, build, the unit and infra tests, then deploy.
2. Check the dashboard loads, onboarding creates a workspace with demo data, and the integrations page shows fixture syncs.
3. There are no schedules yet: invoke `sync-dispatch`, `gcal-dispatch` or `purge` directly when they should run (the purge is meant to run nightly once a schedule exists).
4. Note: invite links put a token in the URL (accepted risk). On AWS the invite goes through SES, which needs a verified sender (NEEDS SHALEV).

### Step 11. Load protection and email (config, no secrets)

Set per stage in `server/infra/lib/config.ts` (`STAGE_LIMITS`); nothing to configure at deploy time.

| | dev | qa | prod |
| --- | --- | --- | --- |
| Stage default throttle (rate / burst, per second) | 10 / 20 | 10 / 20 | 100 / 200 |
| `/api/public/auth/*` | 2 / 5 | 2 / 5 | 10 / 20 |
| `/api/mcp`, `/api/mcp/*` | 5 / 10 | 5 / 10 | 20 / 40 |
| Function reserved concurrency (HTTP and background syncs together) | 10 | 15 | 55 |

Each route key has its own throttle bucket. A throttled request gets a 429 from API Gateway before it reaches Lambda.

**Atlas connection math.** Each warm Lambda execution environment keeps one Mongo pool of at most `maxPoolSize: 2` connections (`server/src/config/providers/mongoose.ts`), plus a monitoring connection per server. One environment serves one request or one sync job at a time, so the connections a stage can open are about `function concurrency x 2`, plus a few monitors:

- dev: 10 x 2 = 20
- qa: 15 x 2 = 30
- prod: 55 x 2 = 110

Atlas limits per tier: M0/Flex 500, M10 1500. A cluster shared by all three stages stays at about 160 plus monitors, well inside those. Each stage's count includes 5 for background syncs (they had a worker function with 5 of its own before C0-ARCH); syncs and HTTP requests share the pool, so a burst of syncs can take those slots from requests. If prod concurrency is raised, keep the total times 2 under about 80% of the tier limit. Lambda also needs at least 10 unreserved executions account-wide: on a new account whose concurrency quota is still 10, reserving anything fails until a quota increase is approved (NEEDS SHALEV: check Service Quotas, Lambda, concurrent executions).

**Email.** Invite emails are sent straight through SES by the request that creates the invite (no queue, like Elytra). A failed send is logged and does not fail the invite; the inviter still has the link. It is not retried.

**Local server against dev AWS.** `server/src/local.ts` reads the stack outputs (Cognito ids, assets bucket, KMS key id) and derives the app-secret prefix `todolist/<stage>/` from the stage, so the local server reads the stage's app secrets (step 12) from Secrets Manager with the developer's own AWS credentials. They need `secretsmanager:GetSecretValue` on `todolist/<stage>/*`. A background sync ("Sync now") runs inline in the local process, and emails go through SES with the same credentials.

### Step 12. App secrets in Secrets Manager (NEEDS SHALEV, per stage)

App secrets are this app's own credentials: a provider's OAuth client, an API key. Users' provider tokens are not app secrets; they stay sealed in the credential vault in the database.

**Naming.** Each secret is one JSON secret named `todolist/<stage>/<name>`, in the stack's region, encrypted with the default `aws/secretsmanager` key. A customer-managed key would also need `kms:Decrypt` on the API role. The names are an allow-list, `APP_SECRETS` in `server/src/services/appSecrets.ts`, which also lists the fields each JSON must carry:

| Name | JSON fields | Used by |
| --- | --- | --- |
| `google-calendar-oauth` | `clientId`, `clientSecret` | Google Calendar OAuth (`INTEGRATIONS-SETUP.md` §1) |
| `openrouter` | `apiKey` | OpenRouter (not used by any code yet) |
| `oauth-github` | `clientId`, `clientSecret` (plus `appId`, `privateKey` for the GitHub App) | GitHub OAuth (§3) |
| `oauth-jira` | `clientId`, `clientSecret` | Jira OAuth (§4) |
| `oauth-clickup` | `clientId`, `clientSecret` | ClickUp OAuth (§5) |
| `oauth-linear` | `clientId`, `clientSecret` | Linear OAuth (§6) |

For example, dev's Google Calendar client is `todolist/dev/google-calendar-oauth`, holding `{"clientId":"…","clientSecret":"…"}`.

**How the server reads them.**

- The app derives the prefix `todolist/<stage>/` from `ENV` (`appSecretsPrefix` in `server/infra/lib/constants.ts`); CDK passes nothing and never holds a value.
- The function's role (the stack's only one) gets `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:<region>:<account>:secret:todolist/<stage>/*`, and on no other secret.
- The server reads a secret by name on first use and keeps it in memory for an hour. A new value is picked up within the hour, or at the next cold start.
- A missing secret only switches its feature off. For example, Google Calendar answers 409 `oauth_unavailable`. It never fails a deploy.
- A value is never written to CloudFormation, Lambda environment variables, logs or errors.

**Create or rotate a secret.**

1. In the console, open Secrets Manager → **Store a new secret** → **Other type of secret** → **Plaintext**, and paste the JSON.
2. Keep the encryption key `aws/secretsmanager`. Name the secret exactly `todolist/<stage>/<name>`, and leave rotation off.
3. Repeat for each stage, with that stage's own values.
4. To rotate, open the secret → **Retrieve secret value** → **Edit**, and save. Running Lambdas use the new value within the hour.

With the CLI, write the JSON to a file, run `aws secretsmanager create-secret --name todolist/<stage>/<name> --secret-string file://secret.json`, then delete the file. Never put the JSON on the command line, where shell history keeps it.

**Ask by name, never by partial ARN.** `oauth-github` and `oauth-linear` end in a hyphen and six letters, which Secrets Manager's partial-ARN lookup can mistake for the random suffix it adds to every ARN. The server always asks by name; scripts should too.

**Moving from the old name.** Earlier versions of these docs named the Google Calendar client `todolist/<stage>/oauth/google-calendar`. The server no longer reads that name. If you created it, store the same JSON as `todolist/<stage>/google-calendar-oauth` (Secrets Manager cannot rename a secret), check that connecting Google Calendar works, then delete the old secret. Until the new one exists, connecting answers 409 `oauth_unavailable`, and existing Google Calendar connections cannot refresh their tokens.

**Add a new secret (code).**

1. Add its name and the fields the code reads to `APP_SECRETS` in `server/src/services/appSecrets.ts`. Use lowercase words joined by hyphens.
2. Read it with `getAppSecret<{ … }>('<name>')`. If the feature should simply be off without it, catch `AppSecretError` with reason `missing`. Never log the value or return it.
3. Add the name to the allow-list test in `server/src/services/appSecrets.test.ts`.
4. Leave CDK alone: the `todolist/<stage>/*` grant already covers the new name. Create the secret on each stage (above).

**Local API.** `npm run dev` runs against a deployed stage and reads the same Secrets Manager secrets with your AWS credentials. There is no environment-variable fallback: `APP_SECRET_*` and `GOOGLE_OAUTH_CLIENT_*` variables are not read.

## 2. qa and prod checklist

qa and prod stay as the template configured them until Shalev asks. Before either:

- [ ] Dev ran clean for a while: sync runs end `succeeded` or `partial`, none stays `running`.
- [ ] Steps 1 to 6 repeated per stage with its own environment, `DATABASE_URL`, Atlas IAM user for `todolist-<stage>-api`, and certificate. NEEDS SHALEV.
- [ ] Only read-only provider tokens are ever entered: a fine-grained read-only PAT per GitHub owner, plus a classic `read:project` PAT for personal boards. Users enter them in the app; they are never put in GitHub or in code. NEEDS SHALEV.
- [ ] New orgs start empty with the "connect your first source" checklist (no demo data).
- [ ] Required reviewers on the `qa` and `prod` GitHub environments.
- [ ] KMS key retention confirmed.
- [ ] A schedule for `sync-dispatch`, `gcal-dispatch` and `purge` decided and added (none exists for now).
- [ ] SES sender verified for invites.
- [ ] Account Lambda concurrency quota raised if needed (step 11).
- [ ] App secrets created under `todolist/<stage>/`, with that stage's own values (step 12). NEEDS SHALEV.
- [ ] Open questions in REPORT.md answered (Moodle tokens, cadence, retention).
- [ ] The full local and E2E suites pass on the commit to be deployed (REPORT.md, "Test suites").
- [ ] `secrets:scan` clean and `git remote -v` reviewed before the first push.
