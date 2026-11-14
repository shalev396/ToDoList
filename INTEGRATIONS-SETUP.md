# INTEGRATIONS-SETUP: operator runbook for the OAuth apps

You (Shalev) create the OAuth apps once, by hand. End users never create apps: they click "Connect with <Provider>" on the Integrations page. This runbook is written so you can redo any step later.

Providers: **Google Calendar, GitHub, Jira, ClickUp, Linear**. **Moodle** shows as "coming soon" (section 2): nothing to set up.

Checked against the providers' official docs on 2026-11-14. Consoles change; where a doc did not state something, this file says so ("not stated in the docs: verify").

## What you need to do (checklist)

You need these accounts. All are free; none needs a paid plan for the setup itself.

| Account                 | Why                                    | Needs a workspace/site/org to create the app?                                |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| Google account          | Google Cloud project + OAuth client    | No. A Google Cloud project only.                                             |
| GitHub personal account | GitHub App                             | No. A personal account can own the app.                                      |
| Atlassian account       | Atlassian developer console            | **No Jira site needed to create the app.** A site is needed only to test it. |
| ClickUp account         | ClickUp app                            | **Yes, in practice.** You must be Owner or Admin of a ClickUp Workspace.     |
| Linear account          | Linear OAuth app                       | **Yes, in practice.** You need a Linear workspace (and admin rights in it).  |
| AWS access (CLI)        | Secrets Manager, region `il-central-1` | n/a                                                                          |

Do this, in order:

1. App naming in every console: "ToDoList-Dev", "ToDoList-QA", "ToDoList-Prod".
2. For each provider, create **three** apps (dev, qa, prod). One per stage keeps data apart. Sections 1 and 3 to 6 give a table per stage.
3. For each app, add its keys (e.g. `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) to that stage's one secret, `todolist-<stage>-app-secrets` (Conventions).
4. Verify per stage (section 7).
5. Before real users on prod: get **Google** verification (section 1, "Prod verification: TO DO") and submit the **Atlassian** sharing details (section 4). Both take time. Start them early.
6. Test accounts: you need a Jira site (a free one is enough), a ClickUp workspace, a Linear workspace and a GitHub repo of your own to try the flow end to end.

### Your questions, answered

**Does a Jira (Atlassian) OAuth app need a Jira site?** No. You create it in the Atlassian developer console, under an OAuth 2.0 (3LO) integration. The console is not tied to a site. At consent time, the user picks the site(s) they can access. New apps are private (only you can use them); to let anyone use it, open **Distribution** and turn on **Sharing**, which asks for a vendor name and a privacy policy URL. After that, users of any Atlassian site can authorize it. Source: [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/). A general app like Slack's Jira integration works the same way.

**ClickUp.** You create the app in ClickUp's Settings, Apps, and the docs say only a Workspace **Owner or Admin** can. So you need a Workspace, but any (even free, even private) is enough. The docs say users authorize "one or more Workspaces" during the flow, and do not say whether the app is limited to the creator's Workspace. The OAuth flow itself has no such limit. Test it with a second ClickUp account once. Source: [ClickUp authentication](https://developer.clickup.com/docs/authentication).

**Linear.** You create the app at Settings, API, OAuth applications. Linear recommends a dedicated workspace for the app because every admin of that workspace gets access to it. By default the app is private; turn on **Public** so other workspaces can install it (third-party guides describe this switch; Linear's own manifest docs list `private`/`public`, default `private`). Sources: [Linear OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication), [OAuth app manifests](https://linear.app/developers/oauth-app-manifests).

**GitHub.** No org needed. The code uses a **GitHub App** (not an OAuth App), which a personal account can own. Set "Where can this GitHub App be installed?" to **Any account**. Source: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

**Google.** No workspace. A Google Cloud project and a consent screen. Any Google account can connect once the app is published (users outside your test list can connect only after publishing, section 1). Source: [OAuth 2.0 for web server apps](https://developers.google.com/identity/protocols/oauth2).

**Where a provider cannot offer a general app:** none of the five blocks it outright. What can block a user is not the app but their side: a Jira site admin, GitHub org owner or Linear workspace admin who refuses the app (section 8). The fallback the product already supports is the **user's own API token**, a secondary option on the Integrations page:

| Provider        | Fallback in the UI                                                                                        | What works with just the API key                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira            | Atlassian email + API token (`api_token_basic`)                                                           | Read sync (projects, issues) from **one** site: the URL is typed in, there is no site picker. "Also create in" Jira issues on that site. No multi-site, no revoke from the app (delete the token at Atlassian). |
| ClickUp         | Personal API token (`personal_token`)                                                                     | Read sync of lists and the tasks assigned to you, in all your workspaces (no workspace picker). Create tasks.                                                                                                   |
| Linear          | Personal API key (`personal_api_key`)                                                                     | Read sync of projects and the issues assigned to you. Create issues (team, project, status). No revoke from the app.                                                                                            |
| GitHub          | Personal access token (`fine_grained_pat`), plus an optional classic token with `read:project` for boards | Read sync of repos, issues and PRs, plus Projects boards with the second token. Create issues (existing labels only).                                                                                           |
| Google Calendar | None (OAuth only)                                                                                         | Nothing: Google offers no personal API key for private calendars.                                                                                                                                               |

With any method, the app never edits, closes or comments on anything at the provider. It reads, and creates new items only when a user asks ("Also create in"), and only when the integration is set to read & write.

## Conventions (all providers)

- **Stages and URLs.** Stack `todolist-<stage>`, region `il-central-1`.

  | Stage | Domain                               | Name in every console |
  | ----- | ------------------------------------ | --------------------- |
  | dev   | `https://dev.todolist.shalev396.com` | ToDoList-Dev          |
  | qa    | `https://qa.todolist.shalev396.com`  | ToDoList-QA           |
  | prod  | `https://todolist.shalev396.com`     | ToDoList-Prod         |

- **Callback URL** (from the server code: `server/src/services/oauth/service.ts` `providerCallbackPath`, `googleCalendarOAuth.ts` `OAUTH_CALLBACK_PATH`, `routes/public/oauth.ts`): `https://<stage domain>/api/public/oauth/<provider>/callback`, where `<provider>` is `google-calendar`, `github`, `jira`, `clickup`, `linear`. The host is the stage's own `DOMAIN_NAME`. Local development uses the **dev** apps and the dev callback.
- **Secret:** ONE Secrets Manager secret per stage, `todolist-<stage>-app-secrets` (same pattern as auto-content-creation), holding a flat JSON object. `npm run deploy:backend -- <stage>` creates it as `{}` when it is missing and never writes it after (`server/scripts/app-secret.ts`); the stack does not own it, so destroying a stack keeps the keys. The keys the code reads (`APP_SECRETS` in `server/src/services/appSecrets.ts`):

  | Provider        | Keys                                                                   |
  | --------------- | ---------------------------------------------------------------------- |
  | Google Calendar | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`           |
  | GitHub          | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, optional `GITHUB_APP_SLUG` |
  | Jira            | `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`                                 |
  | ClickUp         | `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`                           |
  | Linear          | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`                             |
  | OpenRouter      | `OPENROUTER_API_KEY`                                                   |

  A provider with none of its keys shows as not configured. Its keys must all be non-empty strings, or that provider (only) shows as not configured. Other keys are ignored. `GITHUB_APP_SLUG` is letters/digits/hyphen.

- **Add or change keys.** `put-secret-value` **replaces the whole JSON**, so merge: read it, add the keys, write it back. In Git Bash, placeholders only:

  ```bash
  S=todolist-<STAGE>-app-secrets; F=$(mktemp)
  aws secretsmanager get-secret-value --secret-id $S --region il-central-1 --query SecretString --output text \
    | python -c "import sys,json; d=json.load(sys.stdin); d.update({'<KEY>':'<VALUE>','<KEY2>':'<VALUE2>'}); print(json.dumps(d))" > "$F"
  aws secretsmanager put-secret-value --secret-id $S --secret-string "file://$(cygpath -w "$F")" --region il-central-1
  rm -f "$F"
  ```

  Or in the console: Secrets Manager, the secret, Retrieve secret value, Edit, add the rows, Save.

- **Tokens of users** are sealed in the credential vault, never in this secret. The stage Lambda can read only `todolist-<stage>-app-secrets`.
- **Adding a new secret name** (code change first): `docs/dashboard/DEPLOY-PLAN.md`, "App secrets in Secrets Manager".
- **Fallback.** If you skip a provider on a stage, its "Connect with" button shows as not configured and the user can still paste their own token.

---

## 1. Google Calendar

Scopes the code requests (`GOOGLE_CALENDAR_OAUTH_SCOPES` in `server/src/services/googleOAuthClient.ts`): `openid`, `email`, `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. The last two are required: if the user unticks one, the connection fails with `oauth_scope_missing`. Also sent: `access_type=offline`, `prompt=consent`, PKCE S256.

**Setup.** Google Cloud Console: <https://console.cloud.google.com/>. App type: **Web application** OAuth client. **Three Google Cloud projects**, because the consent screen (name, publishing status) belongs to the project. dev and qa stay in **Testing**; prod is published and verified.

**Done (2026-11-14).** All three projects are set up as below, and each stage's keys are in its `todolist-<stage>-app-secrets`.

| Stage | Project name  | Project ID             | Name on the consent screen | Status                                 |
| ----- | ------------- | ---------------------- | -------------------------- | -------------------------------------- |
| dev   | ToDoList-Dev  | `todolist-dev-514720`  | ToDoList-Dev               | Testing, test user: the owner's Gmail  |
| qa    | ToDoList-QA   | `todolist-qa`          | ToDoList-QA                | Testing, test user: the owner's Gmail  |
| prod  | ToDoList-Prod | `todolist-prod-514721` | ToDoList                   | Testing until verified (no test users) |

Project IDs are unique across all of Google Cloud and can never be renamed: `todolist-dev` and `todolist-prod` were taken, so the console added numbers. Users never see an ID. In the console, always open pages with `?project=<id>`: the console otherwise opens another project of the account.

Per stage:

1. Create the project ("ToDoList-Dev" and so on). Enable **Google Calendar API** (APIs & Services, Library).
2. **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>), then:
   - **Branding**: app name ("ToDoList-Dev", "ToDoList-QA"; prod: "ToDoList"), support email, privacy policy `https://<stage domain>/en/legal/privacy`, terms `https://<stage domain>/en/legal/terms`, prod also the homepage `https://todolist.shalev396.com`. The authorized domain `shalev396.com` is added by itself when you add the redirect URI (step 3). No logo on dev/qa: a logo makes Google ask for verification.
   - **Audience**: **External**. dev/qa: leave **Testing** and add your test users. prod: **Publish app** only as part of verification (below).
   - **Data access**: add the four scopes above. Google labels `calendar.events` sensitive; the other three are non-sensitive.
3. **Clients, Create client, Web application**, name as the project. Authorized redirect URI (exactly one):

   | Stage | Authorized redirect URI                                                        |
   | ----- | ------------------------------------------------------------------------------ |
   | dev   | `https://dev.todolist.shalev396.com/api/public/oauth/google-calendar/callback` |
   | qa    | `https://qa.todolist.shalev396.com/api/public/oauth/google-calendar/callback`  |
   | prod  | `https://todolist.shalev396.com/api/public/oauth/google-calendar/callback`     |

   No JavaScript origins needed (the browser never calls Google with the client).

4. Google shows the client secret **once**, in the "OAuth client created" dialog. Add `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` to `todolist-<stage>-app-secrets` (Conventions). Lost it? Add a new secret on the client and replace the key.
5. **Prod only: verify.** See "Prod verification: TO DO" below.

### Prod verification: TO DO

Not started. Until it passes, prod stays in **Testing**: only listed test users can connect Google Calendar on prod. Sources: [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Brand verification](https://support.google.com/cloud/answer/13463073), [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).

**Console setup**

- [ ] Search Console: `shalev396.com` verified as a Domain property (TXT record at the apex in Route 53) by the project owner's account.
- [ ] Branding on prod: homepage, privacy and terms links.
- [x] Branding on prod: app name "ToDoList", support and developer email, authorized domain `shalev396.com`.
- [x] Data access on prod: the four scopes.

**Before submitting (code and content)**

1. **Prod is live and public**: `https://todolist.shalev396.com` opens without a login or a basic-auth prompt, and so do `/en/legal/privacy` and `/en/legal/terms`.
2. **Homepage** says what the app does and why it asks for Google Calendar, and links to the privacy policy. Google checks it on its own; a page that only shows a sign-in form fails.
3. **Same name everywhere.** The consent screen says "ToDoList"; the site says "TodoList" (`APP_DISPLAY_NAME`). Pick one spelling and use it on both, or brand verification can bounce.
4. **Privacy policy** (`client/src/i18n/translations/en/legal.ts`): it already says what is read from Google Calendar and when the app writes. Add Google's Limited Use statement, word for word: "TodoList's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements." Also say how long Google data is kept and how a user deletes it (disconnect, delete account).
5. Optional: a 120x120 PNG logo for the consent screen (on prod only; it is part of the review).

**Submit (Google Cloud console, project `todolist-prod-514721`)**

1. **Demo video.** Record the whole flow in English and upload it to YouTube as **Unlisted**:
   - sign in to TodoList on prod and click Connect with Google Calendar;
   - Google's consent screen, with the **client ID visible in the address bar** (zoom on the URL) and the app name;
   - tick the scopes and come back to the app;
   - show each scope in use: the calendar list (pick a calendar: `calendar.calendarlist.readonly`), events read into the app, and an event the app creates when you set up a push (`calendar.events`).
2. **Audience**: Publish app (Testing to In production). Confirm the dialog.
3. **Verification Center**: Prepare for verification. Fill in:
   - scope justification for `calendar.events`, e.g.: "ToDoList shows a user's calendar events next to their to-dos, and, only when the user sets up a push, creates and updates the calendar events for the to-dos they choose. A read-only scope is not enough because the app writes those events.";
   - scope justification for `calendar.calendarlist.readonly` if asked: "To let the user choose which of their calendars to sync.";
   - the YouTube link;
   - contact email.
4. Submit, then watch the developer contact inbox: Google's Trust & Safety team replies on that email thread and often asks for changes. Answer on the same thread.

**Timing.** Brand verification: a few business days. Sensitive scopes: up to about 10 business days, longer with back-and-forth. While it is in review, the app works for test users; anyone else sees the "unverified app" screen and the 100-user cap applies.

**After approval.** No warning screen and no user cap. Changing the scopes, the app name or the logo later starts a new review.

**Making it available to any user.** Only published (In production) apps accept any Google account. A published but **unverified** app shows a warning screen and is capped at 100 users (Google's support pages; verify the current cap in the console). Verified apps have no cap.

**Limitations.**

- **Testing status**: only the listed test users (100 max) can connect, and refresh tokens **expire after 7 days**, so dev/qa users must reconnect weekly. Source: [Google OAuth 2.0 docs, refresh token expiration](https://developers.google.com/identity/protocols/oauth2).
- Other refresh-token limits: unused for 6 months, user revokes access, and **100 refresh tokens per Google account per client id** (the oldest is silently invalidated). Same source.
- `calendar.events` ("view and edit events on all calendars") needs Google verification for production. Google's pages do not label scope sensitivity in the pages checked; the Data access screen in the console shows the label. Expect "sensitive". Source: [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth).
- Authorized domains must be top-level private domains: use `shalev396.com`, not the subdomains.
- Rate limits: Calendar API quotas are per project and per user per minute; the defaults are ample for this app. See <https://developers.google.com/workspace/calendar/api/guides/quota>.

## 2. Moodle (coming soon)

Shows as "coming soon". Nothing to set up and no secret. Moodle has no OAuth app to register (per-school tokens). Do not document or provision anything now.

## 3. GitHub

The code uses a **GitHub App**, not an OAuth App: `server/src/services/oauth/providers.ts` sends **no scopes** (the app's permissions decide), uses PKCE S256, and expects an 8-hour access token with a rotating refresh token.

**Console:** <https://github.com/settings/apps/new> (personal account; no org needed). App type: **GitHub App**.

Per stage:

1. **GitHub App name**: "ToDoList-Dev" / "ToDoList-QA" / "ToDoList-Prod". Names are unique across all of GitHub: if taken, add a suffix ("ToDoList-Dev-<yourname>"). Homepage URL: the stage domain.
2. **Callback URL** (one is enough; GitHub allows up to 10):

   | Stage | Callback URL                                                          |
   | ----- | --------------------------------------------------------------------- |
   | dev   | `https://dev.todolist.shalev396.com/api/public/oauth/github/callback` |
   | qa    | `https://qa.todolist.shalev396.com/api/public/oauth/github/callback`  |
   | prod  | `https://todolist.shalev396.com/api/public/oauth/github/callback`     |

3. Tick **Request user authorization (OAuth) during installation**. Keep **Expire user authorization tokens** on. **Webhook**: untick Active.
4. **Permissions** (from the previous runbook, unchanged by the code): Repository: Metadata (read), Issues (**read and write**; the write is used only when a user creates a to-do in GitHub), Pull requests (read). Organization: Projects (read).
5. **Where can this GitHub App be installed?**: **Any account**.
6. Create the app. Copy the **Client ID**, then **Generate a new client secret**.
7. Add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_SLUG` to `todolist-<stage>-app-secrets` (Conventions). `GITHUB_APP_SLUG` is the last part of the app's public URL `github.com/apps/<slug>`; it is optional and only makes the "install" link open your app.

**Making it available to any user.** "Any account" is the setting. A user connects, then installs the app on the repos/orgs they want (the card shows the install link). The user token reaches only repos where the app is installed and that the user can access.

**Limitations.**

- GitHub App vs OAuth App: Apps have fine-grained permissions and expiring tokens; OAuth Apps use broad scopes (`repo`). The code needs the App. Source: [Differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).
- **One app per stage**, so three apps. Callback URLs are not the blocker (up to 10 per App). Up to 100 apps per account. Source: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
- **Org installs**: a non-owner who tries to install the app on an organization only sends a request; an **organization owner must install or approve** it. Orgs can also block repo admins from installing apps. This is the user's org, not yours. Source: [Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).
- Rate limit: a user token draws on the user's 5,000 requests/hour (shared with their other tokens); secondary limits include 900 points/min per REST endpoint and 100 concurrent requests. Source: [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- The `DELETE /applications/{client_id}/token` revoke is not used: on disconnect the user removes the app at github.com/settings/apps/authorizations.
- Fallback: personal token.

## 4. Jira (Atlassian OAuth 2.0 3LO)

Scopes the code requests (`providers.ts`): `read:jira-work`, `read:jira-user`, `read:me`, `offline_access`. Later, when a user turns on creating to-dos in Jira, a second consent adds `write:jira-work`. Also sent: `audience=api.atlassian.com`, `prompt=consent`. No PKCE; token requests are JSON.

**Console:** <https://developer.atlassian.com/console/myapps/>. App type: **OAuth 2.0 integration**. Prerequisite: an Atlassian account only (no Jira site).

Per stage:

1. **Create, OAuth 2.0 integration**. Name "ToDoList-Dev" / "ToDoList-QA" / "ToDoList-Prod". Accept the terms.
2. **Permissions**: add **Jira API** (configure) and enable `read:jira-work`, `read:jira-user` and `write:jira-work` (the last one so the later consent works); add **User identity API** (configure) with `read:me`. `offline_access` is requested in the URL, not enabled here.
3. **Authorization**: add the callback URL (one field; it must equal the `redirect_uri` the server sends):

   | Stage | Callback URL                                                        |
   | ----- | ------------------------------------------------------------------- |
   | dev   | `https://dev.todolist.shalev396.com/api/public/oauth/jira/callback` |
   | qa    | `https://qa.todolist.shalev396.com/api/public/oauth/jira/callback`  |
   | prod  | `https://todolist.shalev396.com/api/public/oauth/jira/callback`     |

4. **Distribution**: Edit, set status **Sharing**, enter the vendor name and the privacy policy URL (reported as required; the docs page says only "enable sharing"), and save. Without this the app is private and nobody but you can connect.
5. **Settings**: copy the **Client ID** and **Secret**.
6. Add `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` to `todolist-<stage>-app-secrets` (Conventions).

**Making it available to any user.** After sharing is on, any Atlassian user can authorize it and picks the site(s) at consent. The app lists the sites of the grant; the owner chooses which to read.

**Limitations.** Source for all unless noted: [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/).

- Refresh tokens **rotate**: each use returns a new one and disables the old. They expire after **90 days of inactivity**; a 10-minute reuse window covers concurrent calls. The server stores the new one on every refresh. `invalid_grant` means the user must reconnect.
- Users installing an app Atlassian has not approved see a warning. Review can be requested through the Marketplace process (a rich listing is not required). Sharing does not list you on the Marketplace.
- One callback URL field per app, so three apps are required (this fits the plan).
- Site admins see authorized apps in Connected apps (admin.atlassian.com) and can uninstall the app, so a site admin can lock your app out of their site. Not under your control.
- Rate limits (enforced since 2026-03-02): the default Global Pool is **65,000 points per hour shared across all tenants**, plus 100 requests/s burst per tenant per endpoint. A 429 carries `Retry-After`. Per-tenant pools need Atlassian review. Source: [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/). Watch this when many users connect.
- Fallback: Atlassian email + API token.

## 5. ClickUp

No scopes (ClickUp has none; the app can do what the user can in the chosen Workspaces). No PKCE, no refresh: the token currently does not expire (the docs say that may change). Callback: one URL per app is the minimum; the docs do not state a maximum.

**Console:** ClickUp, avatar (top right), **Settings, Apps, Create new app** (<https://app.clickup.com/settings/apps>). Prerequisite: Workspace **Owner or Admin**. App type: OAuth app.

Per stage:

1. **Create new app**, name "ToDoList-Dev" / "ToDoList-QA" / "ToDoList-Prod".
2. **Redirect URL(s)**:

   | Stage | Redirect URL                                                           |
   | ----- | ---------------------------------------------------------------------- |
   | dev   | `https://dev.todolist.shalev396.com/api/public/oauth/clickup/callback` |
   | qa    | `https://qa.todolist.shalev396.com/api/public/oauth/clickup/callback`  |
   | prod  | `https://todolist.shalev396.com/api/public/oauth/clickup/callback`     |

3. Copy the **client id** and **secret**.
4. Add `CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET` to `todolist-<stage>-app-secrets` (Conventions).

**Making it available to any user.** There is no publish or sharing step in the docs: the user picks the Workspaces to authorize on ClickUp's page. The docs do not say whether users outside your Workspace can authorize: **test with a second account** before relying on it. If a user cannot, they use the personal API token fallback.

**Limitations.** Source: [ClickUp authentication](https://developer.clickup.com/docs/authentication).

- No read-only scope: the app can act as the user.
- Non-SSL redirect URIs "may not be supported in the future". All ours are https.
- Rate limits are per token and per plan: 100 req/min on Free, Unlimited and Business; 1,000 on Business Plus; 10,000 on Enterprise. 429 on excess. Source: [Rate limits](https://developer.clickup.com/docs/rate-limits). Keep the 650 ms request spacing the sync already uses.
- Fallback: personal API token.

## 6. Linear

Scopes the code requests: `read` (comma separated in the URL). Later consent adds `issues:create` when a user turns on creating to-dos in Linear. PKCE S256. The grant must carry a refresh token.

**Console:** <https://linear.app/settings/api/applications/new>. Prerequisite: a Linear workspace where you are admin. Linear recommends a **dedicated workspace** for the apps, since every admin of that workspace gets access to them. App type: OAuth application.

Per stage:

1. **New OAuth application**: name "ToDoList-Dev" / "ToDoList-QA" / "ToDoList-Prod", developer name, developer URL, description, logo.
2. **Callback URLs**:

   | Stage | Callback URL                                                          |
   | ----- | --------------------------------------------------------------------- |
   | dev   | `https://dev.todolist.shalev396.com/api/public/oauth/linear/callback` |
   | qa    | `https://qa.todolist.shalev396.com/api/public/oauth/linear/callback`  |
   | prod  | `https://todolist.shalev396.com/api/public/oauth/linear/callback`     |

3. Turn **Public** on, so other workspaces can install it. Default is private. Not stated in Linear's own docs beyond the manifest `private`/`public` field: confirm in the form.
4. If the form has a **refresh tokens** switch, turn it on (a third-party guide says apps created before March 2026 needed it; verify).
5. Copy the **Client ID** and **Client secret**.
6. Add `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` to `todolist-<stage>-app-secrets` (Conventions).

**Making it available to any user.** Public on. A workspace admin may need to approve the app for their workspace (not stated in the docs: verify).

**Limitations.** Source: [Linear OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication).

- Access token 24 h; refresh token 30 days, **rotating**. If a refresh response is lost, the same refresh token can be retried for 30 minutes.
- Rate limits: 5,000 requests/hour and 2,000,000 complexity points/hour per user (2x for Business, 5x for Enterprise). Source: [Rate limiting](https://linear.app/developers/rate-limiting).
- Fallback: personal API key.

---

## 7. Verify (per stage)

After storing a secret:

1. Open the Integrations page of the stage and sign in. A configured provider shows **Connect with <Provider>**. The server reports this in `GET /api/private/workspaces/:wid/integrations/oauth/providers`: per provider, `configured` is `true` when the secret exists and is valid. It lists GitHub, Jira, ClickUp, Linear and Google Calendar, and carries only `provider`, `configured` and `installUrl` (no setup details, no secret). A secret that cannot be read or has the wrong shape shows as `configured: false` for that provider only. Compare the `callbackUrl` with what you registered, character for character.
2. Click **Connect with <Provider>**, finish the consent, and you land back on `/<lng>/integrations?connected=...`. `?oauth_error=<code>` means it failed (for example `oauth_denied`, `oauth_scope_missing`, `oauth_failed`).
3. A provider whose secret is missing shows **Signing in with <Provider> isn't available yet** and a disabled button; clicking Connect would answer 409 `oauth_unavailable`.
4. Then check the sync once (Jira: pick a site; ClickUp: the Workspaces).

**Redeploy or wait?** (`server/src/services/appSecrets.ts`)

- **First time (secret did not exist): no redeploy, no wait.** A "missing" answer and any failed read are never cached, so the next request reads again.
- **Replacing a value that was already read: up to one hour.** A successful read is cached for 60 minutes per secret per Lambda container. To apply sooner, redeploy the stage or force a new Lambda container (a config change); otherwise wait.
- Secrets are never read from environment variables.

## 8. Limitations that affect the three-apps plan (summary)

Nothing blocks three apps per provider. What you handle yourself:

| Item                            | Provider                                                     | What you do                                                                                                  |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Verification before real users  | Google (prod)                                                | Privacy policy, homepage, verified domain `shalev396.com`, demo video, justification. Allow 10+ days.        |
| Testing mode                    | Google (dev, qa)                                             | Add test users; refresh tokens last 7 days; reconnect weekly.                                                |
| Distribution details            | Jira                                                         | Vendor name + privacy policy on Distribution for each of the 3 apps. Optional review for the warning screen. |
| Unique app name                 | GitHub                                                       | Names are global: add a suffix if "ToDoList-Dev" is taken.                                                   |
| Admin approval on the user side | Jira site admins, GitHub org owners, Linear workspace admins | Not yours to fix. The user falls back to their own API token.                                                |
| Cross-workspace test            | ClickUp, Linear                                              | Test once with an account outside your workspace.                                                            |
| Pooled quota                    | Jira                                                         | 65,000 points/hour shared by all users; watch it as usage grows.                                             |

## 9. Code follow-ups (not changed here)

1. **Section numbers in code comments.** `appSecrets.ts` and `providers.ts` refer to "INTEGRATIONS-SETUP.md section 1 and sections 3 to 6". This file keeps those numbers (Google 1, GitHub 3, Jira 4, ClickUp 5, Linear 6). Section 2 is now Moodle. Update the comments if you renumber.
2. **Google verification.** `calendar.events` needs a production review (about 10 days). If a narrower scope would do, use it; the code requires both calendar scopes today (`REQUIRED_CALENDAR_SCOPES`).
3. **Jira write consent.** `write:jira-work` is requested later by re-consent; it must already be enabled under the app's Permissions or the consent fails. It is in step 2 of section 4.
4. **GitHub write.** The Issues write permission is set at the app level. Changing it later makes GitHub ask each installation to accept the new permission.
5. **Moodle** is listed as a provider in the plan but has no OAuth code or secret name. Correct: nothing to add.
6. **Drive** is no longer documented here. The `google-drive*` secret names, if any exist in AWS from the earlier runbook, are unused and can be deleted.
