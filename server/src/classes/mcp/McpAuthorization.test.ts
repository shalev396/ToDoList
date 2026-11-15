/** McpAuthorization: authorization requests, consent, and single-use PKCE codes. */
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import { OAuthError, type OAuthErrorCode } from '../../errors/OAuthError.js';
import { newTeam } from '../../mcp/__tests__/helpers/team.js';
import { pkceChallenge } from '../../services/crypto/hashing.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { AgentKey as AgentKeyClass } from '../AgentKey.js';
import { Actor } from '../base/Actor.js';
import { AuditLog } from '../AuditLog.js';
import type * as UrlsModule from '../../mcp/oauth/urls.js';
import type { McpAuthorization as McpAuthorizationClass } from './McpAuthorization.js';
import type { McpClient as McpClientClass } from './McpClient.js';

let db: TestDatabase;
let AgentKey: typeof AgentKeyClass;
let McpAuthorization: typeof McpAuthorizationClass;
let McpClient: typeof McpClientClass;
let urls: typeof UrlsModule;

const REDIRECT = 'https://claude.example/cb';

before(async () => {
  db = await startTestDatabase('todolist_mcp_authorization_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  ({ AgentKey } = await import('../AgentKey.js'));
  ({ McpAuthorization } = await import('./McpAuthorization.js'));
  ({ McpClient } = await import('./McpClient.js'));
  urls = await import('../../mcp/oauth/urls.js');
});

after(async () => {
  await db.stop();
});

type Team = Awaited<ReturnType<typeof newTeam>>;

async function newClient(): Promise<string> {
  const client = await McpClient.register(
    { client_name: 'Claude Desktop', redirect_uris: [REDIRECT] },
    {},
  );
  return client.id;
}

function entryOf(
  view: Awaited<ReturnType<typeof McpAuthorizationClass.describe>>,
  workspaceId: string,
): Awaited<ReturnType<typeof McpAuthorizationClass.describe>>['workspaces'][number] {
  const found = view.workspaces.find((w) => w.id === workspaceId);
  assert.ok(found !== undefined);
  return found;
}

function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}

interface Started {
  clientId: string;
  verifier: string;
  requestId: string;
}

async function start(
  extra: Record<string, string | undefined> = {},
  verifier = newVerifier(),
): Promise<Started> {
  const clientId = extra['client_id'] ?? (await newClient());
  const { redirectTo } = await McpAuthorization.start({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'st-1',
    ...extra,
  });
  const url = new URL(redirectTo);
  const requestId = url.searchParams.get('request');
  assert.equal(url.pathname, '/en/authorize-agent');
  assert.ok(requestId !== null);
  return { clientId, verifier, requestId };
}

async function approved(
  team: Team,
  extra: Record<string, string | undefined> = {},
  scopes: Parameters<typeof McpAuthorization.approve>[2]['scopes'] = ['read', 'items:write'],
): Promise<Started & { code: string }> {
  const started = await start(extra);
  const { redirectTo } = await McpAuthorization.approve(
    started.requestId,
    Actor.user(team.editor.id),
    { workspaceId: team.workspace.id, scopes, name: 'My Claude' },
  );
  const code = new URL(redirectTo).searchParams.get('code');
  assert.ok(code !== null);
  return { ...started, code };
}

async function oauthCode(promise: Promise<unknown>): Promise<OAuthErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OAuthError, String(error));
    return error.oauthCode;
  }
  return assert.fail('expected an OAuthError');
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error;
  }
  return assert.fail('expected an AppError');
}

describe('McpAuthorization', () => {
  it('start → describe → approve → exchange issues working tokens', async () => {
    const team = await newTeam('mcpauth-flow');
    const verifier = newVerifier();
    const { requestId, clientId } = await start({ scope: 'read items:write sync' }, verifier);

    const view = await McpAuthorization.describe(requestId, team.editor.id);
    assert.equal(view.clientName, 'Claude Desktop');
    assert.equal(view.redirectHost, 'claude.example');
    assert.equal(view.readonly, false);
    const mine = entryOf(view, team.workspace.id);
    assert.equal(mine.role, 'editor');

    // The editor ticks sync too, but the viewer-only ones would be refused; here: all allowed.
    const { redirectTo } = await McpAuthorization.approve(requestId, Actor.user(team.editor.id), {
      workspaceId: team.workspace.id,
      scopes: ['read', 'items:write', 'sync'],
      name: 'My Claude',
    });
    const back = new URL(redirectTo);
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'st-1');
    assert.equal(back.searchParams.get('iss'), urls.mcpIssuer());
    const code = back.searchParams.get('code') ?? '';
    assert.match(code, /^elc_[A-Za-z0-9_-]{43}$/);

    const tokens = await McpAuthorization.exchange({
      code,
      codeVerifier: verifier,
      clientId,
      redirectUri: REDIRECT,
    });
    const agent = await AgentKey.authenticate(tokens.accessToken, new Date(), {});
    assert.ok(agent !== null);
    assert.equal(agent.principal.userId, team.editor.id);
    assert.equal(agent.principal.workspaceId, team.workspace.id);
    assert.deepEqual([...agent.principal.scopes].sort(), ['items:write', 'read', 'sync']);
    assert.equal(agent.resource, urls.mcpResource(false));
  });

  it('describe offers only what the role allows and pre-ticks the defaults', async () => {
    const team = await newTeam('mcpauth-describe');
    const plain = await start();
    const asViewer = await McpAuthorization.describe(plain.requestId, team.viewer.id);
    const viewerEntry = entryOf(asViewer, team.workspace.id);
    assert.deepEqual(viewerEntry.allowed, [
      'read',
      'integrations:read',
      'integrations:connect',
      'workspace:read',
    ]);
    assert.deepEqual(viewerEntry.preselected, ['read']);
    assert.equal(viewerEntry.atCap, false);
    assert.deepEqual(asViewer.requested, ['read', 'items:write', 'builder:write']);

    const publish = await start({ scope: 'read builder:publish providers:create bogus' });
    const asOwner = await McpAuthorization.describe(publish.requestId, team.owner.id);
    const ownerEntry = entryOf(asOwner, team.workspace.id);
    assert.deepEqual(asOwner.requested, ['read', 'providers:create', 'builder:publish']);
    assert.ok(ownerEntry.allowed.includes('builder:publish'));
    assert.deepEqual(ownerEntry.preselected, ['read']);
  });

  it('the readonly resource offers only read scopes', async () => {
    const team = await newTeam('mcpauth-readonly');
    const { requestId } = await start({
      resource: urls.mcpResource(true),
      scope: 'read items:write workspace:read',
    });
    const view = await McpAuthorization.describe(requestId, team.owner.id);
    assert.equal(view.readonly, true);
    const entry = entryOf(view, team.workspace.id);
    assert.deepEqual(entry.allowed, ['read', 'integrations:read', 'workspace:read']);
    assert.deepEqual(entry.preselected, ['read', 'workspace:read']);
    const refusal = await appError(
      McpAuthorization.approve(requestId, Actor.user(team.owner.id), {
        workspaceId: team.workspace.id,
        scopes: ['read', 'items:write'],
        name: 'x',
      }),
    );
    assert.equal(refusal.code, 'scope_not_allowed');
  });

  it('a viewer approving items:write gets scope_not_allowed', async () => {
    const team = await newTeam('mcpauth-viewer');
    const { requestId } = await start();
    const refusal = await appError(
      McpAuthorization.approve(requestId, Actor.user(team.viewer.id), {
        workspaceId: team.workspace.id,
        scopes: ['read', 'items:write'],
        name: 'Claude',
      }),
    );
    assert.equal(refusal.statusCode, 400);
    assert.equal(refusal.code, 'scope_not_allowed');
    // The request is still pending: a corrected approval works.
    const ok = await McpAuthorization.approve(requestId, Actor.user(team.viewer.id), {
      workspaceId: team.workspace.id,
      scopes: ['read'],
      name: 'Claude',
    });
    assert.ok(new URL(ok.redirectTo).searchParams.has('code'));
  });

  it('approve refuses empty scopes, a bad name, and a non-member', async () => {
    const team = await newTeam('mcpauth-approve-bad');
    const stranger = await newTeam('mcpauth-approve-other');
    const { requestId } = await start();
    const actor = Actor.user(team.editor.id);
    const input = { workspaceId: team.workspace.id, scopes: ['read' as const], name: 'ok' };
    assert.equal(
      (await appError(McpAuthorization.approve(requestId, actor, { ...input, scopes: [] })))
        .statusCode,
      400,
    );
    assert.equal(
      (await appError(McpAuthorization.approve(requestId, actor, { ...input, name: ' ' })))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await appError(
          McpAuthorization.approve(requestId, actor, { ...input, name: 'x'.repeat(81) }),
        )
      ).statusCode,
      400,
    );
    const outsider = await appError(
      McpAuthorization.approve(requestId, actor, { ...input, workspaceId: stranger.workspace.id }),
    );
    assert.equal(outsider.statusCode, 404);
  });

  it('plain PKCE and a missing challenge redirect with invalid_request', async () => {
    const clientId = await newClient();
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 'abc',
    };
    const challenge = pkceChallenge(newVerifier());
    const cases: Record<string, string>[] = [
      { ...base, code_challenge: challenge, code_challenge_method: 'plain' },
      { ...base, code_challenge: challenge },
      { ...base, code_challenge_method: 'S256' },
      { ...base, code_challenge: 'short', code_challenge_method: 'S256' },
      { ...base, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'token' },
    ];
    for (const params of cases) {
      const { redirectTo } = await McpAuthorization.start(params);
      const url = new URL(redirectTo);
      assert.equal(`${url.origin}${url.pathname}`, REDIRECT);
      assert.equal(url.searchParams.get('error'), 'invalid_request');
      assert.equal(url.searchParams.get('state'), 'abc');
      assert.equal(url.searchParams.get('iss'), urls.mcpIssuer());
    }
    const badResource = await McpAuthorization.start({
      ...base,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://evil.example/api/mcp',
    });
    assert.equal(new URL(badResource.redirectTo).searchParams.get('error'), 'invalid_request');
  });

  it('an unregistered redirect_uri is a 400, never a redirect', async () => {
    const clientId = await newClient();
    const params = {
      response_type: 'code',
      client_id: clientId,
      code_challenge: pkceChallenge(newVerifier()),
      code_challenge_method: 'S256',
    };
    assert.equal(
      await oauthCode(
        McpAuthorization.start({ ...params, redirect_uri: 'https://evil.example/cb' }),
      ),
      'invalid_request',
    );
    assert.equal(await oauthCode(McpAuthorization.start({ ...params })), 'invalid_request');
    assert.equal(
      await oauthCode(
        McpAuthorization.start({ ...params, client_id: 'nobody', redirect_uri: REDIRECT }),
      ),
      'invalid_client',
    );
  });

  it('a wrong verifier, an expired code and a resource mismatch are invalid_grant', async () => {
    const team = await newTeam('mcpauth-grant-bad');
    const a = await approved(team);
    const exchange = (
      from: { code: string; clientId: string },
      over: Partial<Parameters<typeof McpAuthorization.exchange>[0]> = {},
      now?: Date,
    ): Promise<unknown> =>
      McpAuthorization.exchange(
        {
          code: from.code,
          codeVerifier: a.verifier,
          clientId: from.clientId,
          redirectUri: REDIRECT,
          ...over,
        },
        now,
      );
    assert.equal(await oauthCode(exchange(a, { codeVerifier: newVerifier() })), 'invalid_grant');
    assert.equal(await oauthCode(exchange(a, { codeVerifier: 'short' })), 'invalid_grant');
    assert.equal(
      await oauthCode(exchange(a, { resource: urls.mcpResource(true) })),
      'invalid_grant',
    );
    assert.equal(
      await oauthCode(exchange(a, { redirectUri: 'https://evil.example/cb' })),
      'invalid_grant',
    );
    assert.equal(await oauthCode(exchange(a, { clientId: await newClient() })), 'invalid_grant');
    assert.equal(
      await oauthCode(exchange({ ...a, code: `elc_${'A'.repeat(43)}` })),
      'invalid_grant',
    );
    assert.equal(
      await oauthCode(exchange(a, {}, new Date(Date.now() + 11 * 60_000))),
      'invalid_grant',
    );
    // None of those used it up: the right call still works, with the resource named.
    const tokens = await exchange(a, { resource: urls.mcpResource(false) });
    assert.ok(tokens !== null && typeof tokens === 'object');
  });

  it('a replayed code fails and revokes the grant it made', async () => {
    const team = await newTeam('mcpauth-replay');
    const a = await approved(team);
    const input = {
      code: a.code,
      codeVerifier: a.verifier,
      clientId: a.clientId,
      redirectUri: REDIRECT,
    };
    const first = await McpAuthorization.exchange(input);
    assert.ok((await AgentKey.authenticate(first.accessToken, new Date(), {})) !== null);
    assert.equal(await oauthCode(McpAuthorization.exchange(input)), 'invalid_grant');
    assert.equal(await AgentKey.authenticate(first.accessToken, new Date(), {}), null);
    const rows = (await AuditLog.list(team.workspace.id, {}, 50)).filter(
      (e) => e.action === 'agent_key.oauth_code_reuse',
    );
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows.at(0)?.meta), /el[kocr]_|hash/i);
  });

  it('the grant audit carries the token request origin', async () => {
    const team = await newTeam('mcpauth-origin');
    const a = await approved(team);
    await McpAuthorization.exchange(
      { code: a.code, codeVerifier: a.verifier, clientId: a.clientId, redirectUri: REDIRECT },
      new Date(),
      { ip: '203.0.113.9', userAgent: 'claude-test' },
    );
    const rows = (await AuditLog.list(team.workspace.id, {}, 50)).filter(
      (e) => e.action === 'agent_key.oauth_grant',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows.at(0)?.ip, '203.0.113.9');
    assert.equal(rows.at(0)?.userAgent, 'claude-test');
  });

  it('two concurrent exchanges of one code: exactly one succeeds', async () => {
    const team = await newTeam('mcpauth-race');
    const a = await approved(team);
    const input = {
      code: a.code,
      codeVerifier: a.verifier,
      clientId: a.clientId,
      redirectUri: REDIRECT,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => McpAuthorization.exchange(input)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) {
      if (r.status === 'rejected') assert.ok(r.reason instanceof OAuthError);
    }
  });

  it('deny redirects with access_denied and the state', async () => {
    const team = await newTeam('mcpauth-deny');
    const { requestId } = await start({ state: 'keep-me' });
    const { redirectTo } = await McpAuthorization.deny(requestId, team.editor.id);
    const url = new URL(redirectTo);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('state'), 'keep-me');
    assert.equal(url.searchParams.get('iss'), urls.mcpIssuer());
    const gone = await appError(McpAuthorization.describe(requestId, team.editor.id));
    assert.equal(gone.statusCode, 404);
    assert.equal(gone.code, 'request_expired');
    const again = await appError(McpAuthorization.deny(requestId, team.editor.id));
    assert.equal(again.code, 'request_expired');
  });

  it('an unknown request is 404 request_expired', async () => {
    const team = await newTeam('mcpauth-unknown');
    const refusal = await appError(McpAuthorization.describe('no-such-request', team.owner.id));
    assert.equal(refusal.statusCode, 404);
    assert.equal(refusal.code, 'request_expired');
  });

  it('approve at the cap is 409 agent_key_cap', async () => {
    const team = await newTeam('mcpauth-cap');
    for (let i = 0; i < LIMITS.agentKeysPerUser; i += 1) {
      const a = await approved(team);
      await McpAuthorization.exchange({
        code: a.code,
        codeVerifier: a.verifier,
        clientId: a.clientId,
        redirectUri: REDIRECT,
      });
    }
    const { requestId } = await start();
    const view = await McpAuthorization.describe(requestId, team.editor.id);
    assert.equal(entryOf(view, team.workspace.id).atCap, true);
    const refusal = await appError(
      McpAuthorization.approve(requestId, Actor.user(team.editor.id), {
        workspaceId: team.workspace.id,
        scopes: ['read'],
        name: 'One too many',
      }),
    );
    assert.equal(refusal.statusCode, 409);
    assert.equal(refusal.code, 'agent_key_cap');
  });

  it('the cap holds at exchange: two approved codes, one slot', async () => {
    const team = await newTeam('mcpauth-cap-exchange');
    for (let i = 0; i < LIMITS.agentKeysPerUser - 1; i += 1) {
      const a = await approved(team);
      await McpAuthorization.exchange({
        code: a.code,
        codeVerifier: a.verifier,
        clientId: a.clientId,
        redirectUri: REDIRECT,
      });
    }
    const first = await approved(team);
    const second = await approved(team);
    const asInput = (a: typeof first): Parameters<typeof McpAuthorization.exchange>[0] => ({
      code: a.code,
      codeVerifier: a.verifier,
      clientId: a.clientId,
      redirectUri: REDIRECT,
    });
    await McpAuthorization.exchange(asInput(first));
    assert.equal(await oauthCode(McpAuthorization.exchange(asInput(second))), 'access_denied');
    const { getAgentKeyRepository } = await import('../../models/index.js');
    const keys = await getAgentKeyRepository();
    assert.equal(
      await keys.countForUser(team.workspace.id, team.editor.id),
      LIMITS.agentKeysPerUser,
    );
  });

  it('a role dropped after approval makes the exchange invalid_grant', async () => {
    const team = await newTeam('mcpauth-demoted');
    const a = await approved(team);
    const { getMembershipRepository } = await import('../../models/index.js');
    await (
      await getMembershipRepository()
    ).update(team.workspace.id, team.editor.id, { role: 'viewer' });
    assert.equal(
      await oauthCode(
        McpAuthorization.exchange({
          code: a.code,
          codeVerifier: a.verifier,
          clientId: a.clientId,
          redirectUri: REDIRECT,
        }),
      ),
      'invalid_grant',
    );
  });

  it('approve rejects malformed scopes with 400, and answered or expired requests are 404', async () => {
    const team = await newTeam('mcpauth-misc');
    const actor = Actor.user(team.editor.id);
    const input = { workspaceId: team.workspace.id, scopes: ['read' as const], name: 'ok' };
    const { requestId } = await start();
    for (const scopes of ['read', null, [1], undefined]) {
      const bad = await appError(
        McpAuthorization.approve(requestId, actor, { ...input, scopes } as never),
      );
      assert.equal(bad.statusCode, 400);
    }
    await McpAuthorization.approve(requestId, actor, input);
    const again = await appError(McpAuthorization.approve(requestId, actor, input));
    assert.equal(again.statusCode, 404);
    assert.equal(again.code, 'request_expired');

    const stale = await start();
    const { McpAuthRequestMongoModel } = await import('../../models/mongoose/McpAuthRequest.js');
    await McpAuthRequestMongoModel.updateOne(
      { _id: stale.requestId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const late = await appError(McpAuthorization.describe(stale.requestId, team.editor.id));
    assert.equal(late.code, 'request_expired');
    const lateApprove = await appError(McpAuthorization.approve(stale.requestId, actor, input));
    assert.equal(lateApprove.statusCode, 404);
    assert.equal(lateApprove.code, 'request_expired');
  });
});
