# TodoList Frontend E2E Tests (Playwright + Python)

[← Back to main README](../../README.md)

Run these against the local API (`cd server && npm run dev`, which runs against a deployed stage) + Vite, or against the deployed qa site. For the full list of hardcoded URLs to change, see [Getting Started → Change Hardcoded URLs](../../README.md#2-change-hardcoded-urls-and-branding) in the main README.

> [!WARNING]
> **Resetting a stage deletes everything in it.** The suite itself never resets anything. To start from an empty stage, run the reset first:
>
> ```bash
> cd server && npm run reset:db -- dev   # or qa; refused for prod
> ```
>
> It deletes **the database, all S3 user uploads and every Cognito user** of that stage. It is a direct invoke of the stage's API function (`{"action":"reset-db"}`), not an HTTP route, so it needs AWS credentials for the account; nobody can trigger it through the API. CI runs it before each suite: `_test-local.yml` resets **qa** on every PR into qa, and `_test-qa.yml` resets **qa** before testing the deployed QA site.
>
> There is no offline mode: every account is a real Cognito user. Don't reset when using a pre-existing account (`E2E_TEST_EMAIL`, see [Mail.tm](#mailtm-and-auth-dependent-tests)): it would delete that user.

---

## Run Locally

**One-time setup** (from `client/`):

```bash
npm run test:install
```

This creates `.venv`, installs dependencies, and Playwright Chromium. Cross-platform (Windows, Mac, Linux).

**Before every test run**, in separate terminals:

1. **Server** (from `server/`): `npm run start:local -- --stage dev --no-rate-limits` (the local API on :3000 against the `dev` stage; `--stage qa` for qa). It needs `server/.env.<stage>` with the stage's `DOMAIN_NAME` and `DATABASE_URL`, and AWS credentials; Cognito, S3 and KMS come from the stage's stack outputs. `--no-rate-limits` turns the in-app rate limits off in that process only: every test request comes from one address, and a full run goes far past them. CI starts it the same way. Without the flag (`npm run dev`) the limits stay on, as on a deployed stage.
2. **Client** (from `client/`): `npm run dev`

**Run tests** (from `client/`):

```bash
npm run test
```

Runs pytest via `.venv` with `BASE_URL=http://localhost:5173`, `API_BASE_URL=http://localhost:3000/api`. Translations are exported automatically before tests (conftest fixture). Accounts are pooled (below) instead of one per test: each signup costs a Mail.tm inbox, an SES email and 15 to 25 seconds.

### Accounts and data

Every account is a real Cognito user, made the way Elytra makes them: a Mail.tm inbox, signup, the emailed code, login (about 15 to 25 seconds and one SES email each). So tests share accounts, and what a test owns is a **workspace**, the isolation boundary ([`tests/helpers/users.py`](helpers/users.py)):

| Fixture / helper               | What it is                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared_test_user`             | One account for the whole run (`authenticated_page`)                                                                                                                               |
| `fresh_owner`                  | The worker's pooled `owner` account plus a **new workspace** (deleted after the test). Returns `(user, workspace)`                                                                 |
| `second_user`                  | The worker's pooled `member` account, for two-user flows (invites, members). Pass `workspace_id=` to `open_as` / `sign_in` to open a given workspace, as it joins many             |
| `new_workspace(user, name, …)` | Factory for more workspaces; they are deleted at teardown (a user may own only 5)                                                                                                  |
| `fresh_user`                   | A brand-new account with no workspace (it lands on onboarding). One signup per test, so only the onboarding, invite and sharing tests use it                                       |
| `pooled_user(api, "other")`    | Any further pooled role. Pools are per xdist worker, so two workers never share an account                                                                                         |
| `new_mailbox()`                | A real empty Mail.tm address for an invite to someone who does not exist (no bounce)                                                                                               |
| `loadDemoData`                 | `create_workspace(..., loadDemoData=True)` loads the demo data through the API (dev and qa; refused on prod). Suites that need it make one workspace per module (`demo_workspace`) |

Invite links come from the API response (`create_invite`) or, for an invite sent through the UI, from the invitee's Mail.tm inbox (`wait_for_invite_path`). If signups ever become the bottleneck, an `AdminCreateUser` shortcut (the CI role) can replace the Mail.tm signup in `create_test_user`; Elytra uses Mail.tm only.

### What the browser does not cover

A stage talks to the real providers, so the suites that needed a provider stand-in are not browser tests: the OAuth handshakes (Google Calendar, Linear, ClickUp), creating a to-do in providers and a working "Test connection" or sync. Their logic is covered by the server tests with injected provider fakes (see the list in [`integrations/test_cards.py`](e2e/integrations/test_cards.py)). The browser keeps the provider-free checks: cards, forms, secret handling, sharing and read-only states.

### Parallel workers

Tests run in parallel on pytest-xdist workers, one per CPU up to 4 (`E2E_WORKERS=2 npm run test` to change, `E2E_WORKERS=0` for a single process). Each worker drives its own Chromium: private-repo GitHub runners have only 2 vCPUs, and more workers than CPUs (plus Vite and the local API) left pages stuck on the route spinner. `--headed` with 4 workers opens 4 browsers.

The shared test user and the translations export still happen once per run (`_run_once` in `conftest.py`, guarded by a file lock). Tests that change state other tests read (accounts, profile data) are listed in `SHARED_STATE_TESTS` in `conftest.py`; with `--dist loadgroup` they run on one worker, in order. Add a test there when it changes such state.

### Reduced motion

Every test browser prefers reduced motion (`browser_context_args` in `conftest.py`), so animations such as `FadeContent` render in their final state. CI browsers have no GPU and little CPU; animations there slow pages down and make axe contrast checks flaky. A test of an animation opts back in with:

```python
@pytest.mark.browser_context_args(reduced_motion="no-preference")
def test_fade_in(page): ...
```

Accessibility tests also call `wait_for_fade_in(page)` from `tests/helpers/animations.py` right before `Axe().run`, so axe never measures contrast mid-fade or scans a route that is still showing its loading spinner.

### Rules for writing tests

- **Never add `--browser` to `pytest.ini`.** `run-tests.ts` already passes `--browser chromium`; pytest-playwright parameterizes each test once per occurrence, so a second copy runs the whole suite twice.
- **Never set context-wide extra HTTP headers** (`browser_context_args` `extra_http_headers`, `context.set_extra_http_headers`). They are sent to every origin, including S3: the browser then preflights the presigned upload with headers the bucket's CORS rules don't allow, and every UI upload fails. Add a header to the requests that need it through `page.route` / `context.route`. The WAF gate's basic auth goes through origin-scoped `http_credentials` instead (see [URLs and Environment Variables](#urls-and-environment-variables)).
- **Prefer `wait_until="load"` plus a content selector over `networkidle`.** Long-lived requests and request storms keep `networkidle` from ever firing, and on a busy CPU it can fire before a lazy route chunk is even requested.
- **Fail, don't skip, on auth problems.** Use `assert "/auth/login" not in page.url, "Authentication failed: redirected to login page"` so a broken login shows up red, not as green skips.

## Scripts

| Script                 | What it does                                    |
| ---------------------- | ----------------------------------------------- |
| `npm run test:install` | Create .venv, install deps, playwright chromium |
| `npm run test`         | Run all E2E tests (Vite + local API on a stage) |
| `npm run test:qa`      | Run tests against QA URLs                       |

### URLs and Environment Variables

Tests use `BASE_URL` (frontend) and `API_BASE_URL` (backend). Defaults:

- **Local API on a stage** (`npm run test`): `BASE_URL=http://localhost:5173`, `API_BASE_URL=http://localhost:3000/api`. No basic-auth password needed.
- **Running pytest directly**: set both yourself. There are no fallbacks, so a run never lands on someone else's dev server by accident; `npm run test` honours them too.
- **QA** (`npm run test:qa`): loads the gitignored `server/.env.qa` without overriding variables already set (shell and CI win). `BASE_URL` and `API_BASE_URL` default to `https://<DOMAIN_NAME>` and `https://<DOMAIN_NAME>/api`.

QA also needs `BASIC_AUTH_PASSWORD`, the password of the WAF gate in front of the qa pages ([Staging access](../../docs/staging-access.md)); the run exits without it. The username is the host (`DOMAIN_NAME`), and `/api/` is not gated. Locally, put it in `server/.env.qa`; never commit it. In CI, the workflow sets `BASE_URL` and `API_BASE_URL` from `vars.DOMAIN_NAME` and `BASIC_AUTH_PASSWORD` from the `qa` environment secret. The deploy reads `WAF_WEB_ACL_ARN` (repository secret) to attach the gate.

Every browser context answers the gate's 401 challenge itself (`browser_context_args` in `conftest.py`, [`tests/helpers/basic_auth.py`](helpers/basic_auth.py)), only for the site's origin and only when challenged, so Bearer calls and S3 uploads are untouched. A test that calls `browser.new_context` itself must pass `http_credentials=gate_http_credentials()` when it returns a value.

---

## Page × Test Category Matrix

| Page            | Route                     | Smoke | Accessibility | Visual | Responsive   | Security |
| --------------- | ------------------------- | ----- | ------------- | ------ | ------------ | -------- |
| Landing         | `/`                       | ✓     | ✓             | ✓      | ✓            | ✓        |
| Dashboard       | `/dashboard`              | ✓     | ✓             | ✓      | ✓            | ✓        |
| Pricing         | `/pricing`                | ✓     | ✓             | ✓      | ✓            | ✓        |
| Profile         | `/profile`                | ✓     | ✓             | ✓      | ✓            | ✓        |
| Profile Edit    | `/profile/edit`           | ✓     | ✓             | ✓      | ✓            | ✓        |
| Login           | `/auth/login`             | ✓     | ✓             | ✓      | ✓            | ✓        |
| Signup          | `/auth/signup`            | ✓     | ✓             | ✓      | ✓            | ✓        |
| Forgot Password | `/auth/forgot-password`   | ✓     | ✓             | ✓      | ✓            | ✓        |
| Reset Password  | `/auth/reset-password`    | ✓     | ✓             | ✓      | ✓            | ✓        |
| Confirm Signup  | `/auth/confirm-signup`    | ✓     | ✓             | ✓      | ✓            | ✓        |
| Privacy         | `/legal/privacy`          | ✓     | ✓             | ✓      | ✓            | ✓        |
| Terms           | `/legal/terms`            | ✓     | ✓             | ✓      | ✓            | ✓        |
| 404             | invalid routes            | ✓     | ✓             | ✓      | ✓            | ✓        |
| App             | —                         | ✓     | —             | —      | —            | —        |
| App shell       | `/dashboard`, `/t/:topic` | ✓     | ✓             | —      | ✓            | —        |
| Onboarding      | `/onboarding`             | ✓     | ✓             | —      | ✓            | —        |
| Settings        | `/settings`               | ✓     | ✓             | —      | ✓            | —        |
| Members         | `/settings/members`       | ✓     | ✓             | —      | ✓ (settings) | —        |
| Invite accept   | `/invites/:token`         | ✓     | —             | —      | —            | —        |

_(App: translations, translation_pages, and `smoke.py`: Home Screen meta tags, manifest and icons, the failing-logo request loop, `theme-color` following the theme.)_

---

## Test Categories

- **Smoke**: Page loads, critical elements visible
- **Accessibility**: axe-core scans, form labels, heading hierarchy
- **Visual**: Screenshot baselines (`artifacts/`)
- **Responsive**: Mobile, tablet, desktop viewports
- **Security**: Protected-route redirects, token leakage checks
- **Flows/critical**: Sign up, login, forgot password, edit profile, export, delete
- **Translation (E2E)**: Visit each page in en and he; assert no i18n keys visible and text differs

### Test Categories Explained

**Smoke** — Page loads and critical elements are visible. Covers redirects for protected pages (e.g. unauthenticated → login), key headings, main CTAs, core form fields, app shell (navigation, footer, main), hero section, navbar, footer links on landing.

**Accessibility** — axe-core scans for WCAG violations (some rules may be disabled per page); all inputs have associated labels; heading hierarchy with visible h1; Delete Account modal uses alertdialog with focus management.

**Visual** — Page loads at 1440×900 viewport. Verifies URL after load; screenshots on failure. No pixel-perfect comparison.

**Responsive** — Key content visible at 7 viewports (320→2560): mobile_small, mobile_mid, mobile_large, tablet, laptop, laptop_large, desktop. Tests fail if horizontal scrollbar/overflow is detected.

**Security** — Protected routes redirect unauthenticated users to login; guest routes redirect authenticated users (e.g. login → dashboard); no `idToken` or `refreshToken` leakage in visible DOM.

---

## Flows (critical.py)

| Flow                                                   | What it tests                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `test_signup_flow`                                     | Create temp email → sign up via API → confirm → tokens obtained              |
| `test_login_flow`                                      | Shared user logs in → Dashboard loads                                        |
| `test_forgot_password_form_submits`                    | Forgot-password form accepts email and submits (redirect to forgot or reset) |
| `test_forgot_password_redirects_to_reset`              | Forgot → reset page with email prefilled; fails if the redirect never occurs |
| `test_edit_profile_flow`                               | Login → Profile → Edit Profile → change name → save → back to Profile        |
| `test_export_data_flow`                                | Login → Profile → Export data → success toast and a `.zip` download starts   |
| `test_guest_redirects_to_dashboard_when_authenticated` | Logged-in user visits login → redirected to Dashboard                        |
| `test_delete_account_flow`                             | Login → Profile → Delete Account → confirm → home page, tokens cleared       |

---

## Flows (sharing.py)

`test_owner_shares_college_with_a_classmate`: a fresh owner creates a workspace on onboarding and
invites a second real account as a viewer, on Members. The invite email reaches the classmate's
Mail.tm inbox; the classmate logs in, opens the link and accepts: every topic in the sidebar,
"Workspace (Viewer)" instead of Settings, read-only settings and members. In two workspaces, the
classmate switches with the switcher, and each workspace's members and topics stay its own.

## Folder Structure

Aligned with [routes.ts](../src/router/routes.ts). Each route/page has its own folder.

```
tests/
  e2e/
    landing/           HOME (/)
    dashboard/         /dashboard
    pricing/           /pricing
    profile/           /profile
    profile_edit/      /profile/edit
    auth_login/        /auth/login
    auth_signup/       /auth/signup
    auth_forgot_password/   /auth/forgot-password
    auth_reset_password/    /auth/reset-password
    auth_confirm_signup/    /auth/confirm-signup
    legal_privacy/      /legal/privacy
    legal_terms/        /legal/terms
    page_404/           invalid routes
    flows/              critical.py (cross-page: signup, login, edit-profile, delete, etc.)
    app/                smoke.py, translations.py, translation_pages.py
  scripts/
  helpers/
  fixtures/
```

Each page folder contains: `smoke.py`, `accessibility.py`, `visual.py`, `responsive.py`, `security.py` (as applicable).

---

## Translation E2E Tests

`tests/e2e/app/translation_pages.py` visits each page in English and Hebrew and verifies:

1. **No untranslated keys** — i18next shows keys when translations are missing; tests assert none appear
2. **Text differs between languages** — Catches pages that don't switch language correctly

Protected pages use `authenticated_page`; public pages use `page`.

---

## Mail.tm and Auth-Dependent Tests

Tests that create users (sign up, login flow, profile flows) use [Mail.tm](https://mail.tm) for temporary email. These require:

- Backend API running
- Network access to api.mail.tm
- Initial 12s wait for email delivery (first poll), then a look every 8 s, for up to a minute

Mail.tm is free and shared, and answers 429 when an address sends too much (GitHub runners share addresses). Every call goes through `mailtm_request` ([`tests/helpers/mailtm.py`](helpers/mailtm.py)): at most one call per worker every half second (four workers stay under Mail.tm's 8 a second), a 429 retried after its `Retry-After` or an exponential backoff with jitter (up to 7 calls and 2 minutes of waiting), and the active domain looked up once per worker. `tests/e2e/mailtm/test_retry.py` checks that logic offline.

Optionally set `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`, `E2E_TEST_ID_TOKEN`, `E2E_TEST_REFRESH_TOKEN` to use an existing account and skip user creation. Don't run `npm run reset:db` in this mode (it would delete that account); the run uses whatever data the stage already has.

Otherwise each run creates one fresh Mail.tm user for the whole run (all workers) and sends one SES confirmation email; `test_signup_flow` and `test_delete_account_flow` each create one more, every pytest worker creates its pooled accounts on first use (`owner`, `member`, sometimes `demo` and `other`: see [Accounts and data](#accounts-and-data)), and each test that uses `fresh_user` creates one. If SES or Mail.tm rejects the request (quota, 429), `shared_test_user` **fails** the run instead of skipping: a skip would turn every auth-dependent test into a green skip and hide a broken login. The trade-off is that, together with the reset on every run, each run spends SES quota; on a tight quota, use the `E2E_TEST_*` variables.
