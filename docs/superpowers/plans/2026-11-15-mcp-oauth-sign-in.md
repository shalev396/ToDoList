# MCP Sign-in (OAuth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP clients connect to TodoList by signing in (OAuth 2.1, MCP authorization spec 2025-11-25) or with an agent key, whichever the user picks. Every member can use both.

**Architecture:** TodoList is its own authorization server, inside the existing Express app and Lambda.

- **Storage:** a sign-in ("grant") is an `AgentKey` row with `kind: 'oauth'`, next to keys. The new `classes/AgentKey.ts` owns both.
- **New classes:** `classes/mcp/McpClient.ts` (DCR + CIMD clients) and `classes/mcp/McpAuthorization.ts` (pending requests, codes).
- **Consent:** a page in the SPA, approved through `/api/private`.
- **Discovery:** reachable under `/api/` (the dev/QA WAF gate) and, on prod, at the root.

**Tech Stack:** TypeScript, Express 5, Mongoose, zod, node:test, React 19 + react-router + react-i18next, AWS CDK (CloudFront, API Gateway HTTP API).

**Spec:** `docs/superpowers/specs/2026-11-15-mcp-oauth-sign-in-design.md`. Read it first; this plan argues from it. The spec leaves endpoint names to the builder, so the paths below **replace** the paths in its flow sketch.

## Global Constraints

- **No new AWS service:** no Lambda, queue, schedule, Cognito change or WAF change. The only infra edits are one CloudFront behavior and one API Gateway route (Task 6).
- **Database:** access only from classes under `server/src/classes/`.
  - Add nothing to `server/legacy-db-importers.mjs`. Remove `src/mcp/auth/apiKey.ts` and `src/services/agentKeys.ts` from it in Task 1; the boundary test fails on an entry that's no longer needed.
  - Don't edit `classes/base/**`, `classes/policies/**`, `classes/integration/**`, `classes/workspace/**` or `docs/design/CLASSES.md`. They belong to the other Claude session (`oop-redesign-todolist`).
- **Reuse existing helpers, add no new versions:** `sha256Hex` and `pkceChallenge` (`server/src/services/crypto/hashing.ts`), `assertPublicHttpsUrl` and `isLoopbackHost` (`server/src/services/netGuard.ts`).
  - `AuditLog.record(scope, action, target, meta)` is the only audit writer. Never put a token, code or hash in `meta`.
- **Token formats** (base64url bodies of 32 random bytes = 43 characters; only the SHA-256 is stored):

  | What               | Prefix | Lifetime                                                        |
  | ------------------ | ------ | --------------------------------------------------------------- |
  | Key                | `elk_` | unchanged                                                       |
  | Access token       | `elo_` | 1 hour                                                          |
  | Refresh token      | `elr_` | 90 days from last use (sliding), hard cap 365 days from sign-in |
  | Authorization code | `elc_` | 10 minutes, single use                                          |
  - A refresh token reused after rotation revokes the grant, except the immediately previous one within **30 seconds** of rotation.

- **Scopes:** OAuth scope names = `AGENT_SCOPES` (`server/src/types/domain.ts`) verbatim.
  - **Default when none requested:** `read items:write builder:write`.
  - **Never pre-ticked:** `providers:create`, `builder:publish`.
  - **Allowed:** ⊆ `ROLE_SCOPES[role]`, and ⊆ `READ_ONLY_SCOPES` for the read-only resource (`server/src/mcp/auth/scopes.ts`).
- **Resources:** `https://${environment.domainName}/api/mcp` and `https://${environment.domainName}/api/mcp/readonly`.
- **OAuth URLs** (exact):

  | What                        | URL                                                                                                                                                                                                        |
  | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Issuer                      | `https://${environment.domainName}/api/mcp/oauth`                                                                                                                                                          |
  | Endpoints                   | `{issuer}/authorize` (GET), `{issuer}/token`, `{issuer}/register`, `{issuer}/revoke` (POST)                                                                                                                |
  | AS metadata                 | `{issuer}/.well-known/oauth-authorization-server`, `{issuer}/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server/api/mcp/oauth`, `/.well-known/openid-configuration/api/mcp/oauth` |
  | Protected-resource metadata | `{issuer}/resource-metadata` and `{issuer}/resource-metadata/readonly`; root forms `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-protected-resource/api/mcp/readonly`            |
  | Consent page                | `https://${environment.domainName}/{lng}/authorize-agent?request=<id>`, with `lng` = `he` when `ui_locales` starts with `he`, else `en`                                                                    |
  | Private consent API         | `GET /api/private/mcp-oauth/requests/:id`, `POST …/:id/approve`, `POST …/:id/deny`                                                                                                                         |

- **Redirect URIs:**
  - exact string match;
  - `https:` on any host, or `http:` only on `localhost`, `127.0.0.1`, `[::1]`, where only the port may differ (RFC 8252);
  - no fragments, no other schemes.
- **Cap:** `LIMITS.agentKeysPerUser` (10) counts usable entries of both kinds: not revoked, and `expiresAt` null or in the future. Every sign-in is a new entry; nothing is replaced.
- **Losing access** goes through the existing `Member.endMembership` → `AgentKey` repository `revokeForUser` + `Integration.disconnectAllOf`. Keep `revokeForUser(workspaceId, userId)` as it is, revoking both kinds.
- **No CORS change:** the HTTP API's global CORS stays as is.
- **i18n:** every user-facing string ships in en and he, in the existing voice (plural "you" in Hebrew, as in `settings.ts`).
- **Shared files** (the other session edits them too): `server/src/classes/index.ts`, `server/src/types/api-contracts.ts`, `server/src/types/errorCodes.ts`, `client/src/api/errors.ts`.
  - Edit only your lines, and commit each change promptly in its own small commit.
  - First run `git diff <file>`. If it shows lines you didn't write, stage only your hunk (write a patch of your lines and run `git apply --cached`), then `git commit` without paths. Or wait until the other session commits, or ping it.
  - New error codes (`scope_not_allowed`, `request_expired`, `agent_key_cap`) go in `errorCodes.ts`, with their client messages in `client/src/api/errors.ts` and the i18n `errors` files, under the same rule.
- Commit only this plan's paths with `git commit -- <paths>`. Another session has uncommitted work in the same tree; never stage, reset or format its files.

## Review Focus

1. **Two sign-ins from the same client and user** (two Claude windows) must both keep working. Test in Task 2: two grants, refreshing one leaves the other valid.
2. **A retried refresh after a lost response** (same refresh token twice within seconds) must not log the agent out. Test in Task 2: second use within 30s rotates again; after 31s it revokes.
3. **A user removed from the workspace mid-session:** their access token must fail on the very next MCP call and their refresh token on the next refresh, while other members' agents keep working. Test in Task 5 (HTTP).
4. **An authorization code replayed** (an attacker or a buggy client) must fail and revoke the grant made from it. Test in Task 4.
5. **A redirect URI that differs only by a trailing slash, path or port on a non-loopback host** must be refused, never redirected to. Test in Task 3.

---

### Task 1: `AgentKey` class for keys; members can create keys

**Files:**

- Create: `server/src/classes/AgentKey.ts`, `server/src/classes/AgentKey.test.ts`
- Modify: `server/src/classes/index.ts` (export), `server/src/controllers/agentKeys.ts`, `server/src/routes/private/agentKeys.ts:41` (`requireWorkspace('owner')` → `'viewer'`), `server/src/mcp/auth/apiKey.ts`, `server/legacy-db-importers.mjs` (remove the two entries)
- Delete: `server/src/services/agentKeys.ts`. Move `KEY_PREFIX`, `DEFAULT_EXPIRY_DAYS`, `hashAgentKey` and `toView` into the class file. Update their importers, including `server/src/mcp/__tests__/helpers/agentKeys.ts` if it imports them.
- Test: `server/src/routes/private/agentKeys.http.test.ts` (update the role matrix), `server/src/mcp/__tests__/auth.test.ts` (unchanged, must stay green)

**Interfaces:**

- Produces, in `server/src/classes/AgentKey.ts`:
  - `class AgentKey extends WorkspaceEntity<AgentKeyData> implements Auditable, Revocable, Expirable` with getters `userId`, `name`, `prefix`, `scopes`, `expiresAt`, `lastUsedAt`, `revokedAt`, `kind`, `clientName`, `isUsable(now: Date): boolean` and `auditTarget()` (`AuditTarget.of('agent_key', id)`).
  - `static list(caller: Caller): Promise<AgentKeyView[]>`: owners get everyone's (with `userId`); others get their own.
  - `static create(caller: Caller, input: { name: string; scopes: AgentScope[]; expiresInDays?: number }): Promise<{ key: AgentKey; raw: string }>`: any member. Scopes outside `ROLE_SCOPES[caller role]` → `AppError(400, …, { code: 'scope_not_allowed' })`. At the cap → 409 as today. Audit `agent_key.create`.
  - `static revoke(caller: Caller, id: string): Promise<void>`: owner or the key's user; otherwise 404 as today. Audit `agent_key.revoke`.
  - `static authenticate(raw: string, now: Date, origin: ActorOrigin): Promise<AuthenticatedAgent | null>`: the body of today's `authenticateAgentKey`. Keys only in this task.
  - `export function hashAgentKey(raw: string): string`.
- `mcp/auth/apiKey.ts` keeps `bearerKey`, `sendUnauthorized`, `createMcpAuth`. `authenticateAgentKey` becomes a thin call to `AgentKey.authenticate` (or is removed, with `auth.test.ts` switched to `AgentKey.authenticate`; prefer the thin wrapper so the test is untouched).
- `AgentKeyView` (in `routes/private/agentKeys.ts`) gains `kind: 'key' | 'oauth'` and `clientName: string | null`. Task 2 adds the data fields; until then the class reports `kind: 'key'`, `clientName: null`.

- [ ] **Step 1: Write the failing tests**
  - `agentKeys.http.test.ts` `'role matrix'`: replace the two 403 assertions with:

    ```ts
    assert.equal(
      (await call('viewer', 'POST', '/agent-keys', { name: 'v', scopes: ['read'] })).status,
      201,
    );
    assert.equal(
      (await call('editor', 'POST', '/agent-keys', { name: 'e', scopes: ['items:write'] })).status,
      201,
    );
    const tooMuch = await call('viewer', 'POST', '/agent-keys', {
      name: 'v2',
      scopes: ['items:write'],
    });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.code, 'scope_not_allowed');
    ```

  - Add `'a member's new key appears only in their own list and in the owner's'`: the editor creates a key; the editor's list contains it with no `userId`; the owner's list contains it with `userId` = the editor's id.
  - `AgentKey.test.ts`:
    - `'authenticate resolves a usable key and refuses a revoked one'`: create, authenticate → principal with `scopes ⊆ ROLE_SCOPES[role]`; revoke; authenticate → `null`.
    - `'list never exposes the hash'`: no field of any listed view matches `/hash/i`.

- [ ] **Step 2: Run them and confirm they fail**
  - Run: `cd server && node --import tsx --test src/routes/private/agentKeys.http.test.ts src/classes/AgentKey.test.ts`
  - Expected: FAIL (403 instead of 201; the module `classes/AgentKey.ts` is missing).
- [ ] **Step 3: Implement**
  - Write `AgentKey` per Interfaces, in the style of `classes/workspace/Invite.ts`: private constructor, static operations taking a `Caller`, `WorkspaceEntity` base.
  - Point the controller and `apiKey.ts` at it; delete `services/agentKeys.ts`; remove the two legacy entries; change the route guard to `'viewer'`.
- [ ] **Step 4: Run the suites that touch keys and the boundary**
  - Run: `cd server && node --import tsx --test src/routes/private/agentKeys.http.test.ts src/classes/AgentKey.test.ts src/mcp/__tests__/auth.test.ts src/classes/classBoundary.test.ts src/routes/private/auditOrigin.http.test.ts src/__tests__/secrets/*.test.ts && npx tsc --noEmit -p . && npx eslint src/classes/AgentKey.ts src/mcp/auth src/controllers/agentKeys.ts`
  - Expected: all pass, no type or lint errors.
- [ ] **Step 5: Commit**
  - `git commit -m "refactor(server): AgentKey class owns keys; any member creates keys within their role" -- <the files above>`
  - Tell `oop-redesign-todolist` that `classes/AgentKey.ts` exists, so its Phase 6 builds on it.

### Task 2: Grants on `AgentKey`: issue, refresh, authenticate access tokens

**Files:**

- Modify: `server/src/models/definitions/AgentKey.ts`, `server/src/models/mongoose/AgentKey.ts`, `server/src/classes/AgentKey.ts`, `server/src/services/secretPatterns.ts:34`
- Create: `server/src/classes/AgentKey.grants.test.ts`

**Interfaces:**

- `AgentKeyData` gains `kind: 'key' | 'oauth'` (default `'key'`, existing rows read as `'key'`), `clientId: string | null`, `clientName: string | null`, `resource: string | null`, `accessExpiresAt: Date | null`, `refreshExpiresAt: Date | null`. For grants, `expiresAt` = the 365-day hard cap.
- Repository-only fields (never mapped out): `keyHash` (key, or the current access token), `refreshHash`, `prevRefreshHash`, `prevRotatedAt`, `sourceRequestId` (the authorization request that made it).
- New `IAgentKeyRepository` methods:
  - `createGrant(workspaceId: string, input: CreateGrantInput): Promise<AgentKeyData>`. `CreateGrantInput` = `{ userId, name, scopes, clientId, clientName, resource, keyHash, accessExpiresAt, refreshHash, refreshExpiresAt, expiresAt, sourceRequestId }`.
  - `findByRefreshHash(hash: string): Promise<{ key: AgentKeyData; match: 'current' | 'previous'; prevRotatedAt: Date | null } | null>`.
  - `rotateGrant(id: string, expectedRefreshHash: string, next: { keyHash; accessExpiresAt; refreshHash; refreshExpiresAt; prevRefreshHash; prevRotatedAt }): Promise<boolean>`: atomic; false when the current refresh hash no longer matches.
  - `findBySourceRequest(requestId: string): Promise<AgentKeyData | null>`.
  - `countForUser`: now counts only usable rows (`revokedAt` null and `expiresAt` null or > now).
- `classes/AgentKey.ts` adds:
  - `interface IssuedTokens { accessToken: string; refreshToken: string; expiresIn: number; scope: string }`, where `expiresIn` is 3600 and `scope` is the granted scopes space-joined.
  - `static issueGrant(input: { workspaceId; userId; name; scopes: AgentScope[]; clientId; clientName; resource; sourceRequestId }, actor: Actor): Promise<IssuedTokens>`. Audit `agent_key.oauth_grant`.
  - `static refresh(rawRefresh: string, clientId: string, now?: Date): Promise<IssuedTokens>`. Throws `OAuthError('invalid_grant')` for an unknown, expired, revoked or other-client token. Reuse outside the grace period revokes the grant and audits `agent_key.oauth_reuse`. Audit `agent_key.oauth_refresh` at most once an hour per grant.
  - `static revokeBySource(requestId: string): Promise<void>`.
  - `static revokeByToken(rawToken: string, clientId: string): Promise<void>`: for RFC 7009; unknown tokens are a silent no-op.
  - `authenticate` also accepts `elo_…`. It returns null when `accessExpiresAt <= now`. On success it returns the grant's `resource` on the result, as `AuthenticatedAgent.resource: string | null` (null for keys). Add the field in `mcp/auth/principal.ts`'s `AuthenticatedAgent` (that file is not off-limits).
- `OAuthError` (create `server/src/errors/OAuthError.ts`): `class OAuthError extends AppError` with `oauthCode: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope' | 'access_denied' | 'invalid_redirect_uri' | 'invalid_client_metadata'` and HTTP status 400 (401 for `invalid_client`). Task 5 renders it as RFC 6749 JSON.
- `secretPatterns.ts`: the `agent_key` pattern becomes `/\bel[kocr]_[A-Za-z0-9_-]{16,}/g`.

- [ ] **Step 1: Write the failing tests** in `AgentKey.grants.test.ts` (fake clock through the `now` parameters):
  - `'an issued access token authenticates for an hour, then not'`: `authenticate(access, t0+59min)` ≠ null; `authenticate(access, t0+61min)` = null.
  - `'refresh rotates both tokens; the old access token stops working'`.
  - `'a refresh retried within 30 seconds rotates again; after 31 seconds it revokes the grant'`: after the revoke, the newest access and refresh both fail.
  - `'a refresh token unused for 90 days is refused; the 365-day cap holds even when used daily'`.
  - `'two grants from the same user and client live side by side'`: issue twice with the same `clientId`; refreshing the first leaves the second's access token valid.
  - `'revokeForUser ends grants too'`: then both the access token and the refresh token fail.
  - `'the cap counts usable keys and grants together'`: 9 keys + 1 grant → `AgentKey.create` gives 409; after revoking one, it succeeds.
  - `'a refresh with another clientId is invalid_grant'`.
  - `'list shows a grant with kind oauth and its client name, never a hash'`.
- [ ] **Step 2: Run and confirm they fail**
  - Run: `cd server && node --import tsx --test src/classes/AgentKey.grants.test.ts`
  - Expected: FAIL (`issueGrant` is not a function).
- [ ] **Step 3: Implement** the data fields, the repository methods and the class methods per Interfaces.
  - **Indexes:** `refreshHash` unique-sparse, `prevRefreshHash` sparse, `sourceRequestId` sparse.
  - **Grace window:** a `match: 'previous'` hit within 30s of `prevRotatedAt` rotates from the current state (`expectedRefreshHash` = the current hash). Outside 30s it revokes.
- [ ] **Step 4: Run**
  - Run: `cd server && node --import tsx --test src/classes/AgentKey*.test.ts src/mcp/__tests__/auth.test.ts src/models/__tests__/repositories.test.ts src/__tests__/secrets/*.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(server): OAuth grants on AgentKey: access/refresh tokens, rotation with grace, reuse revokes" -- <files>`

### Task 3: MCP clients: dynamic registration and client ID metadata documents

**Files:**

- Create:
  - `server/src/models/definitions/McpClient.ts`, `server/src/models/mongoose/McpClient.ts` (collection `McpClients`, TTL index on `lastUsedAt` with `expireAfterSeconds: 30 * 86400`);
  - `server/src/classes/mcp/McpClient.ts`, `server/src/classes/mcp/index.ts`, `server/src/classes/mcp/McpClient.test.ts`.
- Modify: `server/src/models/index.ts` (`getMcpClientRepository`, `mongoOnly` like the others), `server/src/classes/index.ts`

**Interfaces:**

- `McpClientData { id; clientName: string; redirectUris: string[]; source: 'dcr' | 'cimd'; lastUsedAt: Date; createdAt: Date }`. CIMD clients aren't stored; they're cached.
- `class McpClient`:
  - getters `id`, `name`, `redirectUris`;
  - `allowsRedirect(uri: string): boolean`;
  - `static register(metadata: unknown, origin: ActorOrigin): Promise<McpClient>`:
    - validates `client_name` (1–100 chars), `redirect_uris` (1–10 entries, rules in Global Constraints);
    - `token_endpoint_auth_method` absent or `none`;
    - `grant_types` ⊆ `['authorization_code','refresh_token']`;
    - `response_types` ⊆ `['code']`;
    - errors are `OAuthError('invalid_redirect_uri' | 'invalid_client_metadata')`;
  - `static resolve(clientId: string): Promise<McpClient>`:
    - an `https:` URL with a path → CIMD: fetch through `assertPublicHttpsUrl(url, { allowLocal: false })`, 5 s timeout, 64 KiB cap, JSON. Require `client_id === url`, plus `client_name` and `redirect_uris` under the same rules. Cache 10 minutes, at most 200 entries;
    - otherwise → stored DCR client, `lastUsedAt` touched at most once an hour;
    - unknown → `OAuthError('invalid_client')`;
  - `static setMetadataFetchForTests(fetcher: ((url: URL) => Promise<unknown>) | null): void`, guarded by `NODE_TEST_CONTEXT` like `setLiveTransportForTests`.

- [ ] **Step 1: Write the failing tests** in `McpClient.test.ts`:
  - `'registers a public client with https and loopback redirects'`.
  - `'refuses http on a public host, a fragment, a custom scheme and a missing client_name'`, each with the right `oauthCode`.
  - `'allowsRedirect: loopback port may differ; path, trailing slash and https port may not'`:

    ```ts
    const c = await McpClient.register(
      { client_name: 'X', redirect_uris: ['http://127.0.0.1:5000/cb', 'https://app.example/cb'] },
      {},
    );
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/cb'), true);
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/cb/'), false);
    assert.equal(c.allowsRedirect('https://app.example/cb/'), false);
    assert.equal(c.allowsRedirect('https://app.example:8443/cb'), false);
    assert.equal(c.allowsRedirect('https://evil.example/cb'), false);
    ```

  - `'resolves a CIMD client whose document names itself'`.
  - `'refuses a CIMD document whose client_id differs'`.
  - `'refuses a CIMD URL on a private address'`: `https://10.0.0.1/c` → `invalid_client`.
  - `'an unknown client_id is invalid_client'`.

- [ ] **Step 2: Run and confirm they fail**
  - Run: `cd server && node --import tsx --test src/classes/mcp/McpClient.test.ts`
  - Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run**
  - Run: `cd server && node --import tsx --test src/classes/mcp/McpClient.test.ts src/classes/classBoundary.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(server): MCP OAuth clients: dynamic registration and client ID metadata documents" -- <files>`

### Task 4: Authorization requests, consent and codes

**Files:**

- Create:
  - `server/src/models/definitions/McpAuthRequest.ts`, `server/src/models/mongoose/McpAuthRequest.ts` (collection `McpAuthRequests`, TTL on `expiresAt`, `expireAfterSeconds: 0`);
  - `server/src/classes/mcp/McpAuthorization.ts`, `server/src/classes/mcp/McpAuthorization.test.ts`.
- Modify: `server/src/models/index.ts` (`getMcpAuthRequestRepository`), `server/src/classes/mcp/index.ts`

**Interfaces:**

- `McpAuthRequestData`:
  - `{ id; clientId; clientName; redirectUri; state: string | null; codeChallenge; resource; requestedScopes: AgentScope[]`
  - `status: 'pending' | 'approved' | 'used' | 'denied'`
  - `userId: string | null; workspaceId: string | null; scopes: AgentScope[]; name: string | null; expiresAt: Date; createdAt }`
  - `codeHash` is repository-only. `markUsed(id, expectedStatus: 'approved'): Promise<boolean>` is atomic.
- `type AuthorizeParams = Record<string, string | undefined>`, the raw query.
- `class McpAuthorization`:
  - `static start(params: AuthorizeParams): Promise<{ redirectTo: string }>`:
    - If `client_id` or `redirect_uri` is invalid, there's nobody safe to redirect to, so it throws `OAuthError('invalid_request' | 'invalid_client')`, which Task 5 renders as a 400 page.
    - Any other error redirects to `redirect_uri?error=…&state=…&iss=<issuer>`.
    - Requires: `response_type=code`; `code_challenge` (43–128 chars); `code_challenge_method=S256` (`plain` → error).
    - `resource` is one of the two resources (absent → the full one).
    - `requestedScopes` = known names from `scope` (or the default three).
    - Stores a pending request for 10 minutes.
    - On success, `redirectTo` = the consent page URL.
  - `static describe(id: string, userId: string): Promise<ConsentView>`, where `ConsentView` = `{ clientName, redirectHost, readonly: boolean, requested: AgentScope[], workspaces: Array<{ id; name; role; allowed: AgentScope[]; preselected: AgentScope[]; atCap: boolean }> }`.
    - `preselected` = `requested ∩ allowed` minus `providers:create` and `builder:publish`.
    - An unknown or expired request, or one no longer pending → 404 `request_expired`.
  - `static approve(id: string, actor: Actor, input: { workspaceId: string; scopes: AgentScope[]; name: string }): Promise<{ redirectTo: string }>`:
    - `Caller.enter` must succeed (else 404);
    - scopes must ⊆ `allowed` (else 400 `scope_not_allowed`), and must not be empty;
    - not at the cap (else 409 `agent_key_cap`);
    - stores `elc_` code hash, user, workspace, scopes, name (1–80 chars);
    - `redirectTo` = `redirect_uri?code=…&state=…&iss=…`.
  - `static deny(id: string, userId: string): Promise<{ redirectTo: string }>` → `error=access_denied`.
  - `static exchange(input: { code; codeVerifier; clientId; redirectUri; resource?: string }): Promise<IssuedTokens>`:
    - the code must exist, be `approved`, not expired, and match the client and redirect URI;
    - `pkceChallenge(codeVerifier) === codeChallenge`;
    - `resource`, when given, must equal the stored one;
    - `markUsed`, then `AgentKey.issueGrant({ …, sourceRequestId: id })`;
    - a code whose request is already `used` → `AgentKey.revokeBySource(id)`, then `invalid_grant`.

- [ ] **Step 1: Write the failing tests** in `McpAuthorization.test.ts`, using `newTeam` (`src/mcp/__tests__/helpers/team.ts`) and a registered client:
  - `'start → describe → approve → exchange issues working tokens'`: the access token authenticates as the editor in the team workspace, with exactly the approved scopes ∩ role.
  - `'describe offers only what the role allows and pre-ticks the defaults'`:
    - viewer: `allowed` = `['read','integrations:read','integrations:connect','workspace:read']`; `preselected` = `['read']` for a request with no scope;
    - owner with `scope=read builder:publish`: `preselected` = `['read']`.
  - `'the readonly resource offers only read scopes'`.
  - `'a viewer approving items:write gets scope_not_allowed'`.
  - `'plain PKCE and a missing challenge redirect with invalid_request'`.
  - `'an unregistered redirect_uri is a 400, never a redirect'`.
  - `'a wrong verifier, an expired code and a resource mismatch are invalid_grant'`.
  - `'a replayed code fails and revokes the grant it made'`: the first exchange's access token is null after the replay.
  - `'deny redirects with access_denied and the state'`.
  - `'approve at the cap is 409 agent_key_cap'`.
- [ ] **Step 2: Run and confirm they fail**
  - Run: `cd server && node --import tsx --test src/classes/mcp/McpAuthorization.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. The issuer and resource strings come from one helper, `server/src/mcp/oauth/urls.ts`:
  - `export const mcpIssuer = (): string => …`
  - `export const mcpResource = (readonly: boolean): string => …`
  - `export const consentPageUrl = (requestId: string, lng: 'en' | 'he'): string => …`

  It's pure and reads `environment.domainName`; Task 5 reuses it.

- [ ] **Step 4: Run**
  - Run: `cd server && node --import tsx --test src/classes/mcp/*.test.ts src/classes/AgentKey*.test.ts src/classes/classBoundary.test.ts && npx tsc --noEmit -p .`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(server): MCP OAuth authorization requests, consent and PKCE codes" -- <files>`

### Task 5: HTTP: discovery, OAuth endpoints, consent API, MCP challenge and audience

**Files:**

- Create:
  - `server/src/mcp/oauth/metadata.ts` (pure: `authorizationServerMetadata()`, `protectedResourceMetadata(readonly: boolean)`);
  - `server/src/routes/mcpOAuth.ts` (exports `mcpOAuthRouter`, mounted at `/api/mcp/oauth`, and `wellKnownRouter`, mounted at `/.well-known`);
  - `server/src/routes/private/mcpOAuth.ts`;
  - `server/src/controllers/mcpOAuth.ts`;
  - `server/src/services/mcpOAuthSchemas.ts` (zod);
  - `server/src/mcp/__tests__/oauth.http.test.ts`.
- Modify:
  - `server/src/app.ts`: mount `/.well-known`, then `/api/mcp/oauth` **before** `/api/mcp`, both with `parseBody`, no `expressAuth`;
  - `server/src/routes/private/index.ts` (`router.use('/', mcpOAuthPrivateRouter)`);
  - `server/src/middlewares/rateLimit.ts` (`export const mcpOAuthLimiter = limiter(30)` for register and token; authorize uses `oauthLimiter`);
  - `server/src/mcp/auth/apiKey.ts` (challenge and audience);
  - `server/src/mcp/index.ts:318` (give `createMcpAuth` the endpoint's resource);
  - `server/src/types/api-contracts.ts` (export the consent types).

**Interfaces:**

- **AS metadata:**

  ```json
  {
    "issuer": "<issuer>",
    "authorization_endpoint": "<issuer>/authorize",
    "token_endpoint": "<issuer>/token",
    "registration_endpoint": "<issuer>/register",
    "revocation_endpoint": "<issuer>/revoke",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["none"],
    "client_id_metadata_document_supported": true,
    "scopes_supported": "<AGENT_SCOPES>"
  }
  ```

- **Protected-resource metadata:** `{ resource: mcpResource(readonly), authorization_servers: [issuer], scopes_supported: readonly ? READ_ONLY_SCOPES : AGENT_SCOPES, bearer_methods_supported: ['header'] }`.
- **Token endpoint:** `application/x-www-form-urlencoded`. The response is plain JSON via `res.json` (not `res.success`): `{ access_token, token_type: 'Bearer', expires_in, refresh_token, scope }`, with `Cache-Control: no-store`. `OAuthError` → `{ error, error_description }` with its status.
- **Register:** JSON in; 201 with `{ client_id, client_name, redirect_uris, token_endpoint_auth_method: 'none', grant_types, response_types }`.
- **Authorize:** GET → 302 `redirectTo`. An `OAuthError` before a safe redirect → 400 with a plain text body.
- **Private:**
  - `GET /mcp-oauth/requests/:id` → `ConsentView`;
  - `POST …/approve` body `{ workspaceId, scopes, name }` → `{ redirectTo }`;
  - `POST …/deny` → `{ redirectTo }`.
- **`createMcpAuth(failures, resourceOf: (req) => string)`:**
  - The 401 `WWW-Authenticate` becomes `Bearer realm="todolist-mcp", resource_metadata="<issuer>/resource-metadata[/readonly]", scope="read items:write builder:write"`, plus `error="invalid_token"` when credentials were presented.
  - A grant whose `resource` ≠ `resourceOf(req)` is unauthorized. A key (`resource` null) works on both endpoints, as today.

- [ ] **Step 1: Write the failing tests** in `oauth.http.test.ts`, using `startApiHarness` + `startMcpHarness` patterns; the browser part is done with `harness.call` and `harness.login`:
  - `'all four AS metadata URLs and both resource-metadata forms answer the same documents'`.
  - `'a 401 from /api/mcp points to resource metadata and suggests the default scopes'`: assert the exact header.
  - `'full flow over HTTP: register → authorize → login → approve → token → tools/list works'`.
  - `'a readonly grant is refused on /api/mcp and works on /api/mcp/readonly'`.
  - `'refresh over HTTP rotates; a malformed grant_type is unsupported_grant_type'`.
  - `'removing the member stops their access token and refresh token at once; another member's grant keeps working'`: two users, one grant each. Owner removes the editor via the members API. The editor's `tools/list` → 401; the editor's refresh → 400 `invalid_grant`; the viewer's `tools/list` → 200.
  - `'revoke endpoint ends a grant; an unknown token still answers 200'`.
  - `'token responses carry no-store and never pass through the {data} envelope'`.
  - `'register is rate limited'`: over the limit → 429.
- [ ] **Step 2: Run and confirm they fail**
  - Run: `cd server && node --import tsx --test src/mcp/__tests__/oauth.http.test.ts`
  - Expected: FAIL (404s).
- [ ] **Step 3: Implement** the routers, controllers, zod schemas, metadata, mounting, limiter, and the challenge and audience change.
- [ ] **Step 4: Run the server gates**
  - Run: `cd server && npm run -s test:unit && npx tsc --noEmit -p . && npx eslint .`
  - Expected: every suite passes (including the existing 213 MCP tests and the secrets suite); no type or lint errors.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(server): MCP OAuth endpoints, discovery under /api and the root, consent API, token audience" -- <files>`

### Task 6: Infra: root discovery route on prod

**Files:**

- Modify: `server/infra/lib/constructs/edge.ts`, `server/infra/lib/constructs/api.ts`, `server/infra/test/stack.test.ts`, `server/infra/composer/template.json` (regenerated the way the repo regenerates it)

**Interfaces:**

- `edge.ts`: `additionalBehaviors['/.well-known/oauth-*']` = the same origin and settings as `'/api/*'`. Extract the `/api/*` behavior object into a `const apiBehavior` and use it for both keys.
- `api.ts` `addRoutes`: `this.httpApi.addRoutes({ path: '/.well-known/{proxy+}', methods: [GET], integration })`, with no authorizer. Add a cdk-nag acknowledgement in `server/infra/lib/nag.ts` only if the synth flags it, with the reason "public discovery documents".

- [ ] **Step 1: Write the failing tests** in `stack.test.ts`:
  - `'routes /.well-known/oauth-* to the HTTP API, uncached'`: the distribution has a cache behavior with `PathPattern: '/.well-known/oauth-*'`, the `/api/*` origin, and the CachingDisabled policy id.
  - `'adds a public GET /.well-known/{proxy+} route without an authorizer'`.
- [ ] **Step 2: Run and confirm they fail**
  - Run: `cd server && npm run -s test:infra`
  - Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run**
  - Run: `cd server && npm run -s test:infra`
  - Expected: PASS, with the composer test updated.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(infra): route /.well-known/oauth-* to the API for MCP discovery on prod" -- <files>`

### Task 7: Consent page

**Files:**

- Create:
  - `client/src/pages/agents/AuthorizeAgentPage.tsx`;
  - `client/src/api/services/mcpOAuthService.ts`;
  - `client/src/features/agents/consent.ts` (pure helpers);
  - `client/src/features/agents/consent.test.ts`;
  - `client/src/i18n/translations/en/agentAuth.ts` and `he/agentAuth.ts`.
- Modify:
  - `client/src/router/routes.ts` (`AUTHORIZE_AGENT: 'authorize-agent'`);
  - `client/src/router/AppRouter.tsx` (in the `FocusLayout` group, beside `ONBOARDING`);
  - `client/src/i18n/translations/en/index.ts` and `he/index.ts` (register `agentAuth`).

**Interfaces:**

- **Service:** `getConsent(requestId)`, `approveConsent(requestId, body: { workspaceId; scopes; name })`, `denyConsent(requestId)`. These return the `ConsentView` / `{ redirectTo }` types from `@api-types/api-contracts`.
- **`consent.ts`:**
  - `initialChoice(view: ConsentView, currentWorkspaceId: string | null): { workspaceId: string; scopes: AgentScope[]; name: string }`: the current workspace if listed, else the first. Its `preselected`. `name` = `view.clientName`.
  - `scopesFor(view, workspaceId): { allowed: AgentScope[]; preselected: AgentScope[] }`.
- **Page:**
  - **Title:** `t('agentAuth.title', { client })`.
  - **Line:** `t('agentAuth.returnsTo', { host })`.
  - **Controls:**
    - a workspace select;
    - a name input (max 80);
    - a checkbox per `allowed` scope, reusing the labels `agentKeys.scopes.<key>.name/hint`;
    - Deny and Allow buttons.
  - **On Allow/Deny:** `window.location.assign(redirectTo)`.
  - **When `atCap`:** Allow is disabled, a message shows, and there's a link to Agent keys.
  - **A 404 `request_expired`:** a message that the sign-in expired, so go back to the agent and try again.
- **Copy (en):**
  - title: "{{client}} wants to work in your TodoList"
  - returnsTo: "After you choose, you go back to {{host}}."
  - workspace: "Workspace"
  - name: "Name"
  - nameHint: "So you can tell your agents apart."
  - access: "Access"
  - roleNote: "Only what your role allows."
  - allow: "Allow"
  - deny: "Deny"
  - revokeNote: "You can revoke this anytime in Settings → Agent keys."
  - atCap: "You have the maximum number of agents here. Revoke one in Agent keys first."
  - expired: "This sign-in expired. Go back to your agent and connect again."
  - failed: "That didn't work. Try again."
  - Hebrew: equivalent, plural "you".

- [ ] **Step 1: Write the failing test** in `consent.test.ts`:
  - `'initialChoice picks the current workspace and its preselected scopes'`;
  - `'initialChoice falls back to the first workspace'`;
  - `'scopesFor returns the workspace's allowed and preselected lists'`.
- [ ] **Step 2: Run and confirm it fails**
  - Run: `cd client && node --import tsx --test src/features/agents/consent.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, service, page, route and strings.
- [ ] **Step 4: Run the client gates**
  - Run: `cd client && npm run -s test:unit && npx tsc -b && npx eslint src/pages/agents src/features/agents src/router src/i18n/translations/*/agentAuth.ts`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(client): consent page for agents signing in" -- <files>`

### Task 8: Agent keys page: members create keys; sign-ins listed

**Files:**

- Modify: `client/src/pages/settings/AgentKeysPage.tsx`, `client/src/i18n/translations/en/settings.ts`, `client/src/i18n/translations/he/settings.ts`
- Do not edit `client/src/i18n/translations/*/connect.ts` (the other session's). Stop using `agentKeys.emptyBodyViewer` and use `agentKeys.emptyBody` for everyone.

**Interfaces:**

- **"New key":** shown to every member. The dialog lists only `ROLE_SCOPES[role]`. Mirror the server table as `client/src/features/agents/roleScopes.ts`, with a test asserting it equals the server's for all three roles, by importing `@api-types` if `ROLE_SCOPES` is exported there; otherwise a fixture copied from `server/src/mcp/auth/scopes.ts`.
- **List rows:**
  - a grant (`kind === 'oauth'`) shows `t('settings.mcp.signedInWith', { client: clientName })` instead of the `elk_…` prefix;
  - the name shows as today;
  - revoke as today.
- **New strings** in `settings.mcp`:
  - en `signedInWith`: "Signed in with {{client}}"
  - en `signInNote`: "Agents that support sign-in only need the address: they open TodoList for you to approve. Otherwise, use a key."
  - Hebrew equivalents.
  - Render `signInNote` above `howTo` in `ConnectAgent`.

- [ ] **Step 1: Write the failing test** `client/src/features/agents/roleScopes.test.ts`: `'role scopes match the server table'`.
- [ ] **Step 2: Run and confirm it fails**
  - Run: `cd client && node --import tsx --test src/features/agents/roleScopes.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** the page changes and strings.
- [ ] **Step 4: Run**
  - Run: `cd client && npm run -s test:unit && npx tsc -b && npx eslint src/pages/settings src/features/agents`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - `git commit -m "feat(client): every member creates agent keys; sign-ins listed with their client" -- <files>`

### Task 9: Plugin, docs, privacy

**Files:**

- Modify:
  - `agent-plugin/.claude-plugin/plugin.json` (`agent_key.required` → false; description: "Leave empty to sign in instead.");
  - `agent-plugin/README.md`;
  - `agent-plugin/hooks/hooks.test.mjs` (assert `agent_key.required !== true`);
  - `docs/dashboard/MCP.md` (§4 option B = this design, §13 sign-in steps, §14 Q2 answered);
  - `client/src/i18n/translations/en/legal.ts` and `he/legal.ts` (MCP privacy paragraph: agents can sign in; we store the client's name, its redirect address and token hashes, never the tokens; revocable anytime);
  - `client/src/pages/legal/LegalDocument.tsx` (`LAST_UPDATED`).

- [ ] **Step 1: Verify the plugin behaviour before editing**
  - Run: `claude mcp add --transport http todolist-signin-test https://dev.todolist.shalev396.com/api/mcp` in a scratch directory, then `claude mcp list`.
  - Expected: the server shows as needing authentication (sign-in offered).
  - Then check the plugin path: enable the plugin with an empty `agent_key` and see whether Claude Code sends `Bearer ` and fails, or offers sign-in.
  - If it fails, keep `agent_key` required. The README then documents sign-in as the `claude mcp add` command, and the test change is skipped.
  - Remove the test server afterwards with `claude mcp remove todolist-signin-test`.
- [ ] **Step 2: Update the test** to match the result of Step 1, and run: `node --test agent-plugin/hooks/*.test.mjs && claude plugin validate ./agent-plugin`. Expected: PASS.
- [ ] **Step 3: Edit the docs and privacy text**, then run: `cd client && npm run -s test:unit && npx tsc -b`. Expected: PASS.
- [ ] **Step 4: Commit**
  - `git commit -m "docs: MCP sign-in in the plugin, MCP.md and the privacy policy" -- <files>`
- [ ] **Step 5: Send `oop-redesign-todolist`** the classes to document in CLASSES.md: `AgentKey` (keys and grants), `McpClient`, `McpAuthorization`, with one line each from their file headers.

### Task 10: Dev deploy and live check

- [ ] **Step 1: Ask Shalev for the go to deploy dev**, and confirm with `oop-redesign-todolist` which commit is safe (only reviewed commits). Check AWS with `aws sts get-caller-identity`; if it's expired, use the phone device-code flow.
- [ ] **Step 2: Deploy dev** from a clean clone at the agreed commit: `npm run deploy:backend -- dev && npm run deploy:frontend -- dev`. Expected: both OK.
- [ ] **Step 3: Live checks**
  - `curl -s https://dev.todolist.shalev396.com/api/mcp/oauth/.well-known/openid-configuration` → the metadata JSON.
  - A `POST /api/mcp` with no token → 401 with `resource_metadata`.
  - Claude Code: `claude mcp add --transport http todolist-dev https://dev.todolist.shalev396.com/api/mcp`, then `/mcp` → authenticate → the consent page (behind the dev password, which Shalev's browser has) → Allow → `tools/list` works.
  - The entry shows in Agent keys as "Signed in with Claude Code"; revoke it, and the next call fails.
- [ ] **Step 4: Report to Shalev** what passed and failed, with output. Prod waits for his go.
