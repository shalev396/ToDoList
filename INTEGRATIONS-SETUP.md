# INTEGRATIONS-SETUP: registering proper auth on each platform

What **you** (Shalev) do in each provider's console, once per environment group, so TodoList can connect with real OAuth instead of pasted tokens. Things that may have moved in a console since this was written are marked _verify_.

## Conventions (all providers)

- **Callback URL per stage:** `https://<stage-domain>/api/public/oauth/<provider>/callback`. Register the dev, QA and prod domains. Local runs against **dev**, so local uses the dev callback.
- **Client id and secret go in AWS Secrets Manager**, never in code or env files. Each is an _app secret_ named `todolist/<stage>/<name>`, holding JSON `{ "clientId": "…", "clientSecret": "…" }`. GitHub adds `appId` and `privateKey`.
  - The names are an allow-list in `server/src/services/appSecrets.ts`: `google-calendar-oauth`, `oauth-github`, `oauth-jira`, `oauth-clickup`, `oauth-linear` (and `openrouter`, an API key). For example: `todolist/dev/oauth-jira`.
  - CDK grants the Lambda read access to `todolist/<stage>/*` only and passes just that prefix. The server reads a secret on first use and keeps it in memory for an hour.
  - Adding a new one (a name in the allow-list, then the secret on each stage): `docs/dashboard/DEPLOY-PLAN.md`, step 12.
- **Users' tokens** (access and refresh) are sealed in our credential vault (KMS envelope, AES-256-GCM, bound to workspace + integration + provider). They are write-only and never returned to the browser, the MCP, logs or errors.
- **Dev and QA = closed beta.** Use each provider's "testing / unlisted" mode with explicitly listed users. **Prod** goes through the provider's review or verification.
- **Many-to-one.** Each successful OAuth connection becomes its own Integration in the workspace, keyed by the provider account id, so you can connect several Google, Jira or GitHub accounts.

---

## 1. Google Calendar (first to implement)

Sign-in with Google (Cognito) and Calendar access are **separate apps**. See TODO.md, "Answers".

1. In Google Cloud Console, create a project. Suggestion: one project for **dev + QA** (stays in Testing) and one for **prod** (gets verified). Keep them apart from any Cognito sign-in project.
2. Go to **APIs & Services → Library** and enable **Google Calendar API**.
3. Go to **Google Auth Platform**:
   - **Branding.** App name "TodoList", support email, logo (optional while testing). App domain links: homepage, privacy policy, terms. Authorized domain: your domain.
   - **Audience.** External, **Testing**. Add the beta users as _test users_ (100 max).
   - **Data access.** Add the scopes `https://www.googleapis.com/auth/calendar.events` (sensitive), `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `openid` and `email`. The last two identify the connected account.
4. Go to **Clients → Create client → Web application**. Authorized redirect URIs: `https://<stage-domain>/api/public/oauth/google-calendar/callback` for the dev and QA domains (the prod project gets the prod callback). Copy the client id and secret into Secrets Manager `todolist/<stage>/google-calendar-oauth` as `{"clientId":"…","clientSecret":"…"}`, in the stack's region. CDK already gives the Lambda GetSecretValue on that stage's `todolist/<stage>/*` secrets only. If you stored it earlier as `todolist/<stage>/oauth/google-calendar`, move it to the new name: `docs/dashboard/DEPLOY-PLAN.md`, step 12.
5. **Prod.** Publish the app, then submit for verification:
   - scope justification;
   - a demo video showing the consent screen and how events are used;
   - links to the privacy policy and terms (F10 must be done first).

   Expect days to weeks.

⚠️ In **Testing** mode, Google expires refresh tokens after **7 days**, so closed-beta users must reconnect weekly. Production (verified) tokens don't have this limit.

## 2. Google Drive (Notability backup)

- **Option A (recommended for now): service-account share.** What's built today, and it needs no OAuth review.
  1. Create a service account in a Google Cloud project with the Drive API enabled.
  2. Put its key in Secrets Manager.
  3. Each user shares their Notability folder (read-only) with the service-account email.
- **Option B: OAuth.** Use `drive.file` with the **Google Picker**, both non-restricted:
  1. Enable the Picker API.
  2. Create an API key restricted to the Picker.
  3. Use the same OAuth client pattern as Calendar.

  _Verify_ whether picking a folder grants access to the files inside it. It historically didn't: `drive.file` covers only the items the user picks.

- **Avoid `drive.readonly`.** It is a _restricted_ scope, which requires a yearly paid CASA security assessment for prod.

## 3. GitHub (built: GitHub App sign-in)

Verified against GitHub's docs. A **GitHub App** (fine-grained, read-only), not an OAuth App.

1. **Settings → Developer settings → GitHub Apps → New GitHub App.**
   - Callback URL: `https://<stage-domain>/api/public/oauth/github/callback` (the setup guide on the Integrations page shows the exact one).
   - Tick "Request user authorization (OAuth) during installation". Keep "Expire user authorization tokens" on (access token 8 h, rotating refresh token 6 months).
   - Webhook: off.
2. **Permissions**: Repository: Metadata (read-only), **Issues: Read & write**, Pull requests (read-only). The write on Issues is used only when a user creates a to-do in GitHub (H5); the sync never writes. Without it creating an issue answers 403 and the app tells the user to allow it at github.com/settings/installations.
   Organization: Projects (read-only). Account: _verify_ whether user-owned Projects (v2) are readable; if not, the token connection stays for personal boards.
3. "Where can this app be installed?": **Any account**. Users choose repositories and organizations through the install link the card shows.
4. Copy the client id, generate a client secret. Store `{"clientId","clientSecret"}` in `todolist/<stage>/oauth-github`. Optionally add `"appSlug"` (the name in the app's GitHub URL) so the install link opens your app.
5. The sign-in uses PKCE S256 and no scopes (the app's permissions decide). `accountId` = the user's login. GitHub does have a revoke call (`DELETE /applications/{client_id}/token`, Basic auth with the client id and secret), but our provider client sends only GET and POST, so it is not used yet: on disconnect the card tells the user to remove the app at github.com/settings/apps/authorizations.

## 4. Jira (built: Atlassian OAuth 2.0 3LO)

1. developer.atlassian.com → Developer console → Create → **OAuth 2.0 integration**.
2. **Permissions**: Jira API with `read:jira-work` and `read:jira-user`; User identity API with `read:me`. The sign-in also asks for `offline_access` (refresh tokens). `write:jira-work` is asked for only when a user creates a to-do in Jira (H5): the app answers `needs_permission` and the user consents again; the sync never writes. Add it to the app's permissions now so that consent works.
3. **Authorization**: callback URL `https://<stage-domain>/api/public/oauth/jira/callback`.
4. **Distribution**: turn sharing on (vendor and privacy details), so people outside your Atlassian organization can sign in.
5. Copy the client id and secret into `todolist/<stage>/oauth-jira`.

How it works: one grant = one integration (`accountId` = the Atlassian account id). After the grant, its accessible sites are listed and the owner picks which to read (`config.sites`); each site is read through `https://api.atlassian.com/ex/jira/<cloudId>`. Refresh tokens **rotate** (90 days unused, 10-minute reuse leeway): every refresh stores the new one with a compare-and-set on the credential version, so concurrent refreshes never lose a rotation; a refused refresh token is `auth_failed` (the owner reconnects). Atlassian has no revoke call: the card points to id.atlassian.com/manage-profile/apps.

## 5. ClickUp (built: OAuth code flow)

1. ClickUp → Settings → Apps → **Create new app**; redirect URL `https://<stage-domain>/api/public/oauth/clickup/callback`.
2. Copy the client id and secret into `todolist/<stage>/oauth-clickup`.
3. The user picks the Workspaces to authorize on ClickUp's page; the owner can narrow them later in the card (`config.teamIds`). Tokens currently don't expire (no refresh). ClickUp has **no read-only scope**: the app can do whatever the user can in the chosen workspaces; TodoList reads, and creates a task only when a user creates a to-do in ClickUp (H5; ClickUp has no write scope to ask for). No revoke call: the card points to ClickUp's Apps page. Rate limit: keep the 650 ms spacing.

## 6. Linear (built: OAuth 2 with PKCE)

1. Linear → Settings → API → **OAuth applications → New**; callback `https://<stage-domain>/api/public/oauth/linear/callback`.
2. Scope `read`; `issues:create` is asked for only when a user creates a to-do in Linear (H5): the app answers `needs_permission` and the user consents again; the sync never writes.
3. Copy the client id and secret into `todolist/<stage>/oauth-linear`.
4. Access tokens last 24 h; refresh tokens rotate (30 days). Disconnect revokes at `https://api.linear.app/oauth/revoke`.
5. A workspace admin may need to approve the app.

## 7. Moodle (per school, no OAuth)

Moodle web services use **per-user tokens**. There is no OAuth app to register.

1. The school's admin must have **Web services** and the **Moodle mobile web service** enabled. If the Moodle mobile app works for students, it's on.
2. Each user gets a token from **Preferences → Security keys** on the school's site (if the school allows it), and pastes it into TodoList's write-only field together with the site URL.
3. Don't collect passwords. `login/token.php` with a password exists, but it's off-limits, and it doesn't work with SSO (Microsoft) logins anyway.
4. For SSO schools, the mobile-app "launch" flow is the only token route. It is complex; treat it as a later feature.
5. Braude: check whether Security keys is available to students. If not, a manual token from the mobile app's settings may be the path. _Verify_.

---

## What I (the build) do once the secrets exist

For each provider, in this order (Google Calendar first):

1. Add OAuth `start` and `callback` routes. The flow uses a signed, single-use, 10-minute `state` bound to user + workspace + integration, plus PKCE.
2. Seal tokens in the vault, and refresh them inside the vault callback.
3. Switch the adapter to OAuth tokens.
4. Add the "Connect with <provider>" button, which can be used again to connect another account.
5. Add a disconnect that revokes the token at the provider where an API exists.
6. The server tests run the same flows against **mock OAuth servers** (test seams). Real logins are tested on dev once the secrets are in Secrets Manager.
