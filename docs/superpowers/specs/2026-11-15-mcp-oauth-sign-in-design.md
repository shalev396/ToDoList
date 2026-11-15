# MCP sign-in for agents (OAuth), next to agent keys

**Status:** approved by Shalev 2026-11-15, with two additions folded in: many agents per workspace, and losing access logs everything out. **Date:** 2026-11-15.

## Why

Agents (Claude, Claude Code, Cursor, VS Code) are the point of TodoList's MCP server: they add to-dos, manage dashboards and fix logic on blocks. Today the only way in is an agent key the user creates, copies and pastes. Shalev wants the same choice the provider integrations give: **sign in (OAuth) or a key, and the user picks.** With sign-in, the agent shows Connect, the user logs in to TodoList, approves, and is done.

## Goals

- Every MCP client that follows the MCP authorization spec (2025-11-25) can connect by signing in. That includes Claude's two automatic options ("Claude's published identity" and "Register automatically"), Claude Code, Cursor and VS Code.
- Agent keys keep working unchanged, for any client that can send a header.
- **Anyone in a workspace can connect an agent, either way** (Shalev's decision "B"). The agent never exceeds the person's role: a viewer's agent can only read. This uses the existing rule, effective scopes = granted scopes ∩ role.
- **Members can create agent keys too** (today owner only), so "the user will choose" holds for every role. This is my call, flagged to Shalev.
- **Many agents per workspace** (Shalev): any number of members, each with any number of agents, in any mix of keys and sign-ins. For example, two agents from one user and one from another. Every sign-in is its own entry, even from the same client, up to the existing per-user cap.
- **An agent's access is the user's access** (Shalev). It is checked on every request, so a role change applies to the agent's next call. When a user loses access to a workspace (removed, leaves, or deletes the account), **everything of theirs there is logged out at once**: agent keys, agent sign-ins (their refresh tokens stop working too), and every provider integration (Jira, ClickUp, Linear, GitHub, Google Calendar).
- One place to see and revoke access: Settings → Agent keys lists keys and sign-ins together.

## Non-goals

- Using TodoList as a login provider for other apps. This only authorizes MCP access.
- Confidential clients (client secrets) and grant types other than authorization code + refresh token.
- Any change to the Cognito user pool or the app's own login.

## Anti-goals (a failure even if it works)

- A new AWS service: no new Lambda, queue, schedule, Cognito hosted UI or WAF change. The infra stays Elytra-shaped.
- An agent ending up with more access than the user chose on the consent page, or more than their role.
- A sign-in that sends the authorization code anywhere except a redirect URI the client registered.
- Touching the shared WAF (`shalev396-shared-acl`), which serves Shalev's other projects.

## Constraints found in the code

- **Login:** the app's own page signs in with Cognito SRP, and Cognito's OAuth/hosted UI is off (`server/infra/lib/constructs/auth.ts`, `disableOAuth: true`). The SPA holds the Cognito tokens, and `/api/private/*` checks them.
- **Routing:** CloudFront sends `/api/*` to the HTTP API and everything else to the SPA bucket (`server/infra/lib/constructs/edge.ts`). API Gateway has routes for `/api/public/*`, `/api/private/*` (JWT authorizer) and `/api/mcp*` (auth in the app).
- **Dev/QA password gate:** the shared WAF blocks every path on `dev.` and `qa.todolist.shalev396.com` that doesn't start with `/api/`, unless the request carries the stage's basic-auth header. Prod has no gate. So anything an agent must reach without a browser has to live under `/api/`. The consent page is in the SPA, and the user's browser handles the gate there.
- **Agent auth today:** `server/src/mcp/auth/apiKey.ts`. The key is `elk_` + 43 base64url characters; its SHA-256 hash is looked up in `AgentKeys`. `resolvePrincipal` builds a `Caller` with effective scopes. 401 answers `WWW-Authenticate: Bearer realm="todolist-mcp"`.
- **Shared code to reuse:** `sha256Hex` and `pkceChallenge` (`server/src/services/crypto/hashing.ts`); `assertPublicHttpsUrl` / `isLoopbackHost` (`server/src/services/netGuard.ts`); `AuditLog.record` (the only audit writer); `Actor`/`Caller`; `express.urlencoded` is already in `parseBody`.
- **OOP rules** (the other Claude session, `docs/design/CLASSES.md`):
  - Database access only through classes under `server/src/classes/`; nothing new goes on `server/legacy-db-importers.mjs`.
  - Use `Entity`/`WorkspaceEntity`, the policies, and `AuditLog.record`.
  - Off-limits without asking that session: `classes/base/**`, `classes/policies/**`, `classes/integration/**`, `classes/workspace/**`, `docs/design/CLASSES.md`.
  - Its Phase 6 turns `AgentKey` into `classes/AgentKey.ts` and moves the lookups in `apiKey.ts` into `AgentKey.authenticate`. **Agreed with that session:** this work creates `classes/AgentKey.ts` first, in that session's style, with keys and grants both on it. Phase 6 waits until this is committed, then builds on it.
  - `revokeForUser` is called from `classes/workspace/Member.ts`, which is off-limits. It keeps its name and signature and revokes keys and sign-ins alike, so `Member.ts` needs no change.
- **Routes:** a `FocusLayout` + `ProtectedRoute` route group exists (onboarding, invites). A signed-out visitor goes to login with `?next=` and comes back (`client/src/router/next.ts`).
- **Key cap:** 10 non-revoked keys per user per workspace (`PLAN_LIMITS.agentKeysPerUser`).

## Approaches

|                                                               | How                                                                                                                      | Trade-off                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. TodoList runs the authorization server itself (picked)** | Express endpoints on the existing Lambda. The SPA hosts the consent page. Grants are stored next to agent keys in Mongo. | One login (the app's own). The workspace and access choice is ours. Every registration style works. No new AWS service. Costs: we implement the OAuth flow ourselves and must get the security details right. |
| B. Cognito managed login + pre-registered clients             | Turn on Cognito's hosted UI and register one app client per agent.                                                       | A second, Cognito-styled login page. No automatic registration, so Claude users paste a client ID by hand. Cognito tokens don't carry workspace or access. Breaks one-click.                                  |
| C. Cognito + our own registration shim                        | Our `/register` creates Cognito app clients through the AWS API.                                                         | Still Cognito's page and still no workspace or access choice. Adds IAM rights and app-client limits. More parts for a worse result.                                                                           |

Shalev handed over the how; A is the only approach that meets the goals and anti-goals.

## The design

### Flow

```
Agent ──POST /api/mcp (no token)──▶ 401  WWW-Authenticate: Bearer resource_metadata="<PRM url>", scope="…"
Agent ──GET PRM──▶ { resource, authorization_servers: [issuer], scopes_supported }
Agent ──GET AS metadata (discovery, below)──▶ endpoints, PKCE S256, CIMD + DCR supported
Agent ──(DCR) POST /api/public/oauth/register──▶ client_id          (or client_id = its CIMD URL)
Browser ─GET /api/public/oauth/authorize?client_id&redirect_uri&code_challenge&state&scope&resource
        ──▶ validate, store a pending request (10 min) ──302──▶ /{lng}/authorize-agent?request=<id>
SPA (logged in; login first if not): "Claude wants to work in your TodoList"
        workspace ▾ · access ☑ · [Allow] [Deny]
SPA ──POST /api/private/oauth/requests/:id/approve {workspaceId, scopes}──▶ { redirectUrl }  (code + state)
Browser ──▶ client redirect_uri?code=…&state=…
Agent ──POST /api/public/oauth/token (authorization_code + code_verifier + resource)──▶ access + refresh
Agent ──POST /api/mcp  Authorization: Bearer <access token>──▶ works as an agent key does
```

### Discovery (works on prod and behind the dev/QA gate)

- **Issuer:** `https://<domain>/api/oauth`. It has a path, so MCP clients try, in order:
  1. `/.well-known/oauth-authorization-server/api/oauth`
  2. `/.well-known/openid-configuration/api/oauth`
  3. `/api/oauth/.well-known/openid-configuration`

  The server answers all of them, plus `/api/oauth/.well-known/oauth-authorization-server`, with the same RFC 8414 metadata. The `/api/...` forms pass the dev/QA gate.

- **Protected-resource metadata (RFC 9728)** is served under `/api/` (for example `/api/mcp/.well-known/oauth-protected-resource`, plus a `/readonly` twin), and every 401 points to it with `resource_metadata`, which clients use first. `resource` is `https://<domain>/api/mcp` or `https://<domain>/api/mcp/readonly`.
- **Prod robustness:** one CloudFront behavior, `/.well-known/oauth-*` → the same HTTP API origin as `/api/*`, and one API Gateway route `/.well-known/{proxy+}`. This lets clients that only try the root forms work on prod. On dev/QA the gate still blocks the root forms, and that's accepted: spec-following clients fall through to form 3. This is the only infra change.

### Client registration

- **CIMD** (Claude's "published identity", VS Code): `client_id` is an https URL. The server fetches it through `assertPublicHttpsUrl` (public host only, short timeout, small size cap, cached briefly). It requires `client_id` to equal the URL, a `client_name`, and `redirect_uris`.
- **DCR** (`POST /api/public/oauth/register`, RFC 7591): public clients only (`token_endpoint_auth_method: none`), stored in Mongo, rate limited per IP. It returns an opaque `client_id`. Clients that register again simply get a new id; unused registrations expire after 30 days (Mongo TTL on `lastUsedAt`).
- **Redirect URIs:** exact match against the registered list. `https://` anywhere, or `http://` only on a loopback host (`localhost`, `127.0.0.1`, `[::1]`), where the port may differ per RFC 8252. Anything else is refused at registration and at authorize. The consent page shows the redirect host.

### Consent page (`/{lng}/authorize-agent`)

```
┌───────────────────────────────────────────────┐
│  Claude wants to work in your TodoList        │
│  It will send you back to claude.ai           │
│                                               │
│  Workspace   [ Shalev's workspace ▾ ]         │
│  Access      ☑ Read your to-dos and pages     │
│              ☑ Create and edit to-dos         │
│              ☑ Edit dashboards                │
│              ☐ Publish dashboards  (owner)    │
│              …only what your role allows      │
│                                               │
│  You can revoke this in Settings → Agent keys │
│              [ Deny ]   [ Allow ]             │
└───────────────────────────────────────────────┘
```

- Protected route in the `FocusLayout` group, so a signed-out user logs in and comes back (`next`). A user with no workspace goes to onboarding first.
- **Workspace:** the user's workspaces; defaults to the current one.
- **Access:**
  - It starts from the scopes the agent requested. OAuth scope names are the `AgentScope` names verbatim; `scopes_supported` lists them all, or only the read scopes for `/readonly`. Unknown names are ignored.
  - When the agent requests none (or only unknown names), it starts from `read items:write builder:write`, the work agents are for: to-dos and dashboards. The 401 challenge's `scope="…"` hint is the same three.
  - It offers only scopes the user's role permits, and only read scopes when `resource` is `/readonly`.
  - `providers:create` and `builder:publish` start unticked, matching today's key defaults. The user can change any box.
  - The workspace setting "Let agents publish dashboards" still applies at use time, as it does for keys.
- **Allow** calls the private approve endpoint, which checks again on the server. **Deny** returns `error=access_denied` to the client.
- Labels reuse the agent-key scope strings, in en and he.

### Tokens and the grant

- **A grant is an `AgentKey` row** with a new `kind: 'oauth'` (existing rows are `kind: 'key'`). It also holds `clientId`, `clientName`, `resource`, the current access-token hash, the access expiry and the refresh-token hash. `name` is the client name ("Claude"). The same row feeds the Agent keys list, the cap and revocation.
- **Access token:** opaque, a distinct prefix (for example `elo_` + 43 base64url characters), 1 hour, only the SHA-256 hash stored. `mcpAuth` accepts both prefixes and checks the token's `resource` against the endpoint it was sent to (RFC 8707). A `/readonly` grant is refused on `/api/mcp`.
- **Refresh token:**
  - opaque and rotated on every use;
  - valid 90 days from its last use (sliding), with a hard cap of 365 days from the sign-in (the key maximum), after which the user signs in again;
  - no expiry picker on the consent page: revocation ends it anytime;
  - presenting an already-rotated refresh token revokes the whole grant (reuse detection), except the immediately previous one within 30 seconds of its rotation. That one rotates again, so a retried or doubled refresh after a lost response doesn't kill the grant. The grant stores that one previous hash and its rotation time.
- **Authorization code:**
  - single use, 10 minutes, stored hashed;
  - bound to client, redirect URI, PKCE challenge (S256 only; `plain` refused), user, workspace, scopes and resource;
  - `pkceChallenge` from the shared helper verifies it.
- **Every sign-in is a new grant**, including a second sign-in from the same client: two Claude instances, or Claude on two machines. Nothing is replaced.
  - The consent page has a name field, prefilled with the client name ("Claude"), so the user can tell them apart ("Claude on laptop").
  - Grants count toward the 10-per-user cap, which counts only usable entries (not revoked, not past their hard cap). At the cap, the consent page says so and points to Agent keys.
- **Revocation:**
  - revoking one entry in Agent keys ends that agent alone;
  - **losing access logs out everything of that user in that workspace.** This is already how keys and integrations work: `Member` (remove/leave) calls `revokeForUser` and `Integration.disconnectAllOf`, which hard-delete credentials for Jira, ClickUp, Linear, GitHub and Google Calendar. `revokeForUser` must revoke sign-ins too, and a revoked grant's access token and refresh token fail on their next use, not after the hour. Account deletion goes through the same path. No change to `Member.ts` is needed;
  - every MCP request already re-checks membership and role (`resolvePrincipal`), so this holds even before revocation finishes;
  - an optional RFC 7009 `POST /api/public/oauth/revoke` lets clients disconnect.
- **Audit log** (`AuditLog.record`): grant created, refreshed (at most once per hour per grant, like `lastUsedAt`), revoked, refresh reuse detected. No tokens are ever logged.

### Agent keys page

- Members (any role) can create keys; the dialog shows only scopes their role permits. Owners still see and revoke everyone's keys and sign-ins; other members see and revoke only their own (today's list rule). The builder greps for other owner-only assumptions about keys (copy, docs, tests) and updates them.
- Sign-ins appear in the same list as "Signed in with <client name>", with their access, last use and Revoke.
- The "Connect an agent" section adds one line: agents that support sign-in only need the address; the key is the alternative.

### Plugin and docs

- **Claude Code plugin:**
  - `agent_key` becomes optional, so leaving it empty means "sign in".
  - The builder must verify Claude Code then uses OAuth rather than sending an empty `Bearer` header.
  - If it doesn't, ship sign-in as the documented `claude mcp add --transport http todolist <address>` and keep the plugin key-based.
- **MCP.md:**
  - §4: phase 2 is this design (our own authorization server, not Cognito);
  - §13: client steps;
  - §14 Q2: answered.
- **Privacy policy (en, he):** agents can sign in. We store the client's name and redirect address and token hashes, never the tokens, and the user can revoke them anytime.
- **CLASSES.md:** send the new classes to the other session, which documents them.

### Where the code goes

- **Classes** under `server/src/classes/` for every database touch:
  - the OAuth client registry;
  - pending requests and codes;
  - the grant (on `AgentKey`). Either we create `classes/AgentKey.ts` in the other session's style, or we coordinate with its Phase 6. Agree with that session before writing.
- **Routes and controllers:**
  - public: discovery, register, authorize, token, revoke;
  - private: request details, approve, deny.
    Mount the discovery paths so they reach Express from `/.well-known/*` and from `/api/...`.
- **Rate limits** on register, authorize and token, like `mcpLimiter`.
- **No CORS change.** The HTTP API's CORS is global and allows only the site and localhost. Claude, Claude Code, Cursor and VS Code call the token and register endpoints from their own servers or apps, not from a web page, so they don't need CORS. A browser-only client can use a key.
- **Mongo TTL indexes** clean up requests, codes and unused registrations. No schedule is needed.
- The exact file list goes to the other session before any code is written.

### Testing

- Unit and integration tests through the existing harnesses, covering:
  - discovery documents;
  - CIMD and DCR, including refused redirect URIs and SSRF-blocked metadata URLs;
  - the authorize → approve → token round trip with PKCE;
  - a wrong verifier, a reused code, an expired code, a `resource` mismatch;
  - refresh rotation and reuse detection;
  - role-capped scopes, a viewer's agent being read-only, revocation;
  - several agents at once: two sign-ins from one user (same client) and one from another user, all working side by side, and revoking one leaves the others;
  - removing a member: their keys, sign-ins (access and refresh) and integrations all stop at once, while other members' agents keep working;
  - the cap.
- Existing key tests stay green unchanged.
- **Live:** Claude Code and Claude (web) against dev (through the gate's `/api` fallbacks), then prod after release, both connecting and revoking.

## Left to the builder

- Endpoint path names, the exact token prefix and response shapes, within the spec.
- CIMD cache length, fetch limits, rate-limit numbers.
- How the private endpoints represent a pending request, and the UI copy (en/he) in the existing voice.
- Whether `/revoke` ships in the first cut.

## Calls made for Shalev to check

1. Members can create keys too, not only sign in.
2. Access token 1 hour. Refresh: 90 days sliding, 365-day hard cap, rotated, reuse revokes (30-second grace for a retried refresh), no expiry picker.
3. Every sign-in is its own named entry (no replacing). Entries count toward the 10-per-user cap (Shalev: many agents per workspace, per user).
4. Consent defaults: what the agent asked for, or `read`, `items:write`, `builder:write` when it asked for nothing. `providers:create` and `builder:publish` start unticked.
5. Dev/QA: no change to the shared WAF. Clients that only try root discovery URLs can sign in on prod but not on dev/QA; keys work everywhere.
6. No CORS change: the agents that matter don't need it.
