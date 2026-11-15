/**
 * OAuth sign-in for GitHub, Jira, ClickUp and Linear, end to end against the in-process mock
 * provider server (testing/mockOAuthProviders.ts): the authorize URL, the state's lifecycle, the
 * code exchange, the integration it creates, refresh and rotation (also two at once), the
 * allow-list, and that no token, code or client secret reaches a response, a redirect or a log.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import type { ActorRef } from '../../classes/base/Actor.js';
import type { WorkspaceContext } from '../../classes/base/Caller.js';
import type { SealInput, SecretJson } from '../../classes/integration/Credential.js';
import type { OAuthConnection } from '../../classes/integration/index.js';
import type { HttpRequest, HttpResponse } from '../../sync/http.js';
import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import {
  mockClientFor,
  MOCK_OAUTH_PROVIDERS,
  startMockOAuth,
  type MockOAuth,
  type MockOAuthProvider,
} from '../../testing/mockOAuthProviders.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';
import { setOAuthBaseUrlForTests } from '../../sync/providers/oauthEndpoints.js';
import { setAppSecretsForTests, type AppSecretsForTests } from '../appSecrets.js';

forceSyncModeForTests('fixtures');

let api: ApiHarness;
let mock: MockOAuth;
let models: typeof Models;
let token: string;
let ownerId: string;
let wid: string;
let viewerToken: string;
let outsiderToken: string;
let editorToken: string;
let editorId: string;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const START = (provider: string): string =>
  `/api/private/workspaces/${wid}/integrations/oauth/${provider}/start`;
/** The app secrets in place: each provider's FAKE client (the mock's). */
const secrets: AppSecretsForTests = {};

function configure(provider: MockOAuthProvider): void {
  secrets[`oauth-${provider}`] = mockClientFor(provider);
  setAppSecretsForTests({ ...secrets });
}

/** Everything a test run printed through the logger: no secret may be in it. */
const logged: string[] = [];

before(async () => {
  mock = await startMockOAuth({ port: 0 });
  const sink: Record<'warn' | 'error', (...args: unknown[]) => void> = console;
  for (const level of ['warn', 'error'] as const) {
    const original = sink[level].bind(console);
    sink[level] = (...args: unknown[]): void => {
      logged.push(args.map((arg) => JSON.stringify(arg)).join(' '));
      original(...args);
    };
  }
  api = await startApiHarness('todolist_oauth_providers_unit');
  setOAuthBaseUrlForTests(mock.url);
  for (const provider of MOCK_OAUTH_PROVIDERS) configure(provider);
  // The mock sends the browser back to the API under test.
  const { setCallbackOriginForTests } = await import('./common.js');
  setCallbackOriginForTests(api.baseUrl);
  models = await import('../../models/index.js');
  const login = await api.login('prov-owner@example.test');
  token = login.token;
  const me = await api.call('GET', '/api/private/me', { token });
  ownerId = (me.body?.['data'] as { id: string }).id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Prov', slug: `prov-${randomUUID().slice(0, 8)}`, ownerId });
  wid = workspace.id;
  await (await models.getMembershipRepository()).create(wid, { userId: ownerId, role: 'owner' });
  const viewer = await api.login('prov-viewer@example.test');
  viewerToken = viewer.token;
  const viewerMe = await api.call('GET', '/api/private/me', { token: viewerToken });
  await (
    await models.getMembershipRepository()
  ).create(wid, { userId: (viewerMe.body?.['data'] as { id: string }).id, role: 'viewer' });
  outsiderToken = (await api.login('prov-outsider@example.test')).token;
  editorToken = (await api.login('prov-editor@example.test')).token;
  const editorMe = await api.call('GET', '/api/private/me', { token: editorToken });
  editorId = (editorMe.body?.['data'] as { id: string }).id;
  await (await models.getMembershipRepository()).create(wid, { userId: editorId, role: 'editor' });
});
after(async () => {
  await api.stop();
  await mock.close();
});

interface Started {
  state: string;
  nonce: string;
  url: URL;
}

async function start(
  provider: string,
  body: Record<string, unknown> = {},
  as: string = token,
): Promise<Started> {
  const response = await fetch(`${api.baseUrl}${START(provider)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const url = new URL((JSON.parse(text) as { data: { authorizeUrl: string } }).data.authorizeUrl);
  const nonce = /todolist_oauth=([A-Za-z0-9_-]{43})/.exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  assert.ok(nonce !== undefined);
  return { state: url.searchParams.get('state') ?? '', nonce, url };
}

async function callback(
  provider: string,
  query: Record<string, string>,
  cookie: string | null,
): Promise<{ status: number; location: string }> {
  const response = await fetch(
    `${api.baseUrl}/api/public/oauth/${provider}/callback?${new URLSearchParams(query).toString()}`,
    { redirect: 'manual', headers: cookie === null ? {} : { cookie: `todolist_oauth=${cookie}` } },
  );
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

/** The provider's side: the browser follows the authorize URL, and gets the callback query. */
async function consent(url: URL): Promise<Record<string, string>> {
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return Object.fromEntries(new URL(response.headers.get('location') ?? '').searchParams);
}

/** The whole flow, as `as` (default: the owner); returns the integration id. */
async function connectThrough(provider: MockOAuthProvider, as: string = token): Promise<string> {
  const { url, nonce } = await start(provider, {}, as);
  const query = await consent(url);
  const result = await callback(provider, query, nonce);
  assert.equal(result.status, 302);
  const connected = /^\/en\/integrations\?connected=([\w-]+)$/.exec(result.location);
  assert.ok(connected, result.location);
  return connected[1] ?? '';
}

const EXPECTED: Record<MockOAuthProvider, { accountId: string; label: string }> = {
  github: { accountId: 'mock-user', label: 'Mock-User' },
  jira: { accountId: 'mock-atlassian-account', label: 'mock@example.test' },
  clickup: { accountId: '4242', label: 'mock-clickup' },
  linear: { accountId: 'mock-linear-user', label: 'Mock Linear' },
};

/** Integration.connectOAuth by the name the shared connect function had. */
async function connectThroughClass(): Promise<{
  connectOAuthIntegration: (
    ctx: WorkspaceContext,
    actor: ActorRef,
    conn: OAuthConnection,
  ) => Promise<unknown>;
}> {
  const { Integration } = await import('../../classes/integration/index.js');
  const { Caller } = await import('../../classes/base/Caller.js');
  return {
    connectOAuthIntegration: (ctx, actor, conn) =>
      Integration.connectOAuth(Caller.fromContext(ctx, actor), conn),
  };
}

/** The credential's two doors, by the names the vault and the writer had. */
async function credentialDoors(): Promise<{
  decryptForSync: <T>(id: string, fn: (secret: SecretJson) => Promise<T>) => Promise<T>;
  storeCredential: (input: SealInput) => Promise<void>;
}> {
  const { Credential } = await import('../../classes/integration/Credential.js');
  return {
    decryptForSync: (id, fn) => Credential.of(id).open(fn),
    storeCredential: (input) => Credential.seal(input),
  };
}

describe('the authorize URL', () => {
  for (const provider of MOCK_OAUTH_PROVIDERS) {
    it(`${provider}: its endpoint, client id, redirect URI, state, scopes and PKCE`, async () => {
      const { url, state, nonce } = await start(provider);
      assert.equal(`${url.origin}${url.pathname}`, `${mock.url}/${provider}/authorize`);
      const params = url.searchParams;
      assert.equal(params.get('client_id'), mockClientFor(provider).clientId);
      assert.equal(
        params.get('redirect_uri'),
        `${api.baseUrl}/api/public/oauth/${provider}/callback`,
      );
      assert.match(state, /^[A-Za-z0-9_-]{43}$/);
      const pkce = provider === 'github' || provider === 'linear';
      assert.equal(params.get('code_challenge_method'), pkce ? 'S256' : null);
      const record = await (await models.getOAuthStateRepository()).findByStateHash(sha256(state));
      assert.ok(record);
      assert.equal(record.provider, provider);
      assert.equal(record.userId, ownerId);
      assert.equal(record.workspaceId, wid);
      assert.equal(record.browserHash, sha256(nonce));
      if (pkce) {
        const challenge = createHash('sha256').update(record.codeVerifier).digest('base64url');
        assert.equal(params.get('code_challenge'), challenge);
      } else {
        assert.equal(params.get('code_challenge'), null);
      }
      assert.ok(!url.href.includes(record.codeVerifier), 'the verifier never leaves the server');
      const scope = params.get('scope');
      if (provider === 'jira') {
        assert.equal(scope, 'read:jira-work read:jira-user read:me offline_access');
        assert.equal(params.get('audience'), 'api.atlassian.com');
        assert.equal(params.get('prompt'), 'consent');
      } else if (provider === 'linear') {
        assert.equal(scope, 'read');
      } else {
        assert.equal(scope, null);
      }
      assert.ok(!(scope ?? '').includes('write'), 'read-only by default');
    });
  }
});

describe('a full connection', () => {
  for (const provider of MOCK_OAUTH_PROVIDERS) {
    it(`${provider}: creates an active OAuth integration with a sealed credential`, async () => {
      const iid = await connectThrough(provider);
      const integration = await (await models.getIntegrationRepository()).findById(wid, iid);
      assert.ok(integration);
      assert.equal(integration.provider, provider);
      assert.equal(integration.authMethod, 'oauth');
      assert.equal(integration.accountId, EXPECTED[provider].accountId);
      assert.equal(integration.label, EXPECTED[provider].label);
      assert.equal(integration.status, 'active');
      assert.equal(integration.connectedBy, ownerId);
      assert.equal(integration.mode, 'read');
      const meta = await (await models.getCredentialRepository()).findMeta(wid, iid);
      assert.equal(meta?.kind, 'oauth');
      if (provider === 'jira') {
        assert.equal((integration.config['sites'] as unknown[]).length, 1);
      }
      if (provider === 'clickup') assert.deepEqual(integration.config['teamIds'], ['9001']);
      // Reconnecting the same account is the same integration.
      assert.equal(await connectThrough(provider), iid);
    });
  }

  it('the status view and a listing never carry a token', async () => {
    const list = await api.call('GET', `/api/private/workspaces/${wid}/integrations`, { token });
    assert.ok(!list.text.includes('FAKE-'), 'no fixture token in the listing');
  });
});

describe('the state: single use, 10 minutes, its provider, its browser', () => {
  const later = (minutes: number): Date => new Date(Date.now() + minutes * 60 * 1000);

  it('single use: the second callback is refused', async () => {
    const { url, nonce } = await start('linear');
    const query = await consent(url);
    assert.match((await callback('linear', query, nonce)).location, /connected=/);
    assert.equal(
      (await callback('linear', query, nonce)).location,
      '/en/integrations?oauth_error=oauth_state_used',
    );
  });

  it('expired after 10 minutes', async () => {
    const { state, nonce } = await start('jira');
    const service = await import('./service.js');
    assert.equal(
      await service.completeProviderOAuth('jira', { state, code: 'c' }, nonce, later(10.5)),
      '/en/integrations?oauth_error=oauth_state_expired',
    );
  });

  it('another provider’s state is refused, with the state left unused', async () => {
    const { url, nonce, state } = await start('linear');
    const query = await consent(url);
    assert.equal(
      (await callback('github', query, nonce)).location,
      '/en/integrations?oauth_error=oauth_state_invalid',
    );
    const record = await (await models.getOAuthStateRepository()).findByStateHash(sha256(state));
    assert.equal(record?.usedAt, null);
  });

  it('a wrong browser (no cookie, another nonce) is refused', async () => {
    const first = await start('clickup');
    assert.equal(
      (await callback('clickup', { state: first.state, code: 'c' }, null)).location,
      '/en/integrations?oauth_error=oauth_state_invalid',
    );
    const second = await start('clickup');
    assert.equal(
      (await callback('clickup', { state: second.state, code: 'c' }, 'x'.repeat(43))).location,
      '/en/integrations?oauth_error=oauth_state_invalid',
    );
  });

  it('a malformed or unknown state is refused', async () => {
    for (const state of ['', 'short', 'x'.repeat(43)]) {
      assert.equal(
        (await callback('github', { state, code: 'c' }, null)).location,
        '/en/integrations?oauth_error=oauth_state_invalid',
      );
    }
  });

  it('a denied consent is oauth_denied; a provider that cannot exchange is oauth_failed', async () => {
    const denied = await start('github');
    mock.nextAuthorize('deny');
    const query = await consent(denied.url);
    assert.equal(
      (await callback('github', query, denied.nonce)).location,
      '/en/integrations?oauth_error=oauth_denied',
    );
    const bad = await start('github');
    assert.equal(
      (await callback('github', { state: bad.state, code: 'FAKE-wrong-code' }, bad.nonce)).location,
      '/en/integrations?oauth_error=oauth_failed',
    );
  });
});

describe('ownership (PERMISSIONS-V2)', () => {
  it('an editor’s connection is theirs; the same account connected by two members is two integrations', async () => {
    const owners = await connectThrough('jira');
    const editors = await connectThrough('jira', editorToken);
    assert.notEqual(editors, owners);
    const repository = await models.getIntegrationRepository();
    const mine = await repository.findById(wid, editors);
    assert.ok(mine);
    assert.equal(mine.ownerUserId, editorId);
    assert.equal(mine.connectedBy, editorId);
    assert.equal((await repository.findById(wid, owners))?.ownerUserId, ownerId);
    // Reconnecting finds only the member's own: the editor's stays the editor's.
    assert.equal(await connectThrough('jira', editorToken), editors);
    assert.equal(await connectThrough('jira'), owners);
  });

  it('a reconnect started from another member’s integration is 404, the workspace owner’s too', async () => {
    const owners = await connectThrough('linear');
    const refused = await api.call('POST', START('linear'), {
      token: editorToken,
      body: { integrationId: owners },
    });
    assert.equal(refused.status, 404, refused.text);
    const editors = await connectThrough('linear', editorToken);
    const byOwner = await api.call('POST', START('linear'), {
      token,
      body: { integrationId: editors },
    });
    assert.equal(byOwner.status, 404, byOwner.text);
    // The editor disconnects their own (the owner can't: 404), leaving one Linear grant here.
    const path = `/api/private/workspaces/${wid}/integrations/${editors}`;
    assert.equal((await api.call('DELETE', path, { token })).status, 404);
    assert.equal((await api.call('DELETE', path, { token: editorToken })).status, 204);
  });

  it('connectOAuthIntegration refuses a reconnect target that is not the member’s own', async () => {
    const { connectOAuthIntegration } = await connectThroughClass();
    const { OAuthFailure } = await import('./common.js');
    const { getWorkspaceContext } = await import('../workspaceContext.js');
    const owners = await connectThrough('clickup');
    const ctx = await getWorkspaceContext(wid, editorId);
    assert.ok(ctx);
    await assert.rejects(
      connectOAuthIntegration(
        ctx,
        { userId: editorId, agentId: null },
        {
          provider: 'clickup',
          accountId: 'someone-else',
          label: 'x',
          config: {},
          topicSlug: 'work',
          secret: { accessToken: 'FAKE-access' },
          scopes: [],
          reconnectIntegrationId: owners,
        },
      ),
      (error: unknown) => error instanceof OAuthFailure && error.code === 'oauth_failed',
    );
  });

  it('25 OAuth connects at once, 4 short of a member’s cap: at most 4 are created', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const { connectOAuthIntegration } = await connectThroughClass();
    const { OAuthFailure } = await import('./common.js');
    const { getWorkspaceContext } = await import('../workspaceContext.js');
    const repository = await models.getIntegrationRepository();
    const racer = await api.login('prov-racer@example.test');
    const racerMe = await api.call('GET', '/api/private/me', { token: racer.token });
    const racerId = (racerMe.body?.['data'] as { id: string }).id;
    await (await models.getMembershipRepository()).create(wid, { userId: racerId, role: 'editor' });
    const room = 4;
    for (let n = 0; n < LIMITS.integrationsPerUserPerWorkspace - room; n += 1) {
      await repository.create(wid, {
        connectedBy: racerId,
        provider: 'moodle',
        accountId: `race-${String(n)}.example.invalid`,
        label: `Moodle ${String(n)}`,
        authMethod: 'api_token_basic',
        topicId: null,
      });
    }
    const ctx = await getWorkspaceContext(wid, racerId);
    assert.ok(ctx);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, (_unused, n) =>
        connectOAuthIntegration(
          ctx,
          { userId: racerId, agentId: null },
          {
            provider: 'linear',
            accountId: `race-account-${String(n)}`,
            label: `Race ${String(n)}`,
            config: {},
            topicSlug: 'work',
            secret: { accessToken: 'FAKE-access' },
            scopes: [],
          },
        ),
      ),
    );
    const created = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        const reason: unknown = outcome.reason;
        assert.ok(reason instanceof OAuthFailure && reason.code === 'oauth_limit', String(reason));
      }
    }
    assert.ok(created <= room, `${String(created)} created with room for ${String(room)}`);
    assert.equal(
      await repository.countActiveForOwner(wid, racerId),
      LIMITS.integrationsPerUserPerWorkspace - room + created,
    );
  });

  it('a member at their own cap gets oauth_limit; a member moved to viewer can’t create', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const repository = await models.getIntegrationRepository();
    const filler = await api.login('prov-filler@example.test');
    const fillerMe = await api.call('GET', '/api/private/me', { token: filler.token });
    const fillerId = (fillerMe.body?.['data'] as { id: string }).id;
    const memberships = await models.getMembershipRepository();
    await memberships.create(wid, { userId: fillerId, role: 'editor' });
    for (let n = 0; n < LIMITS.integrationsPerUserPerWorkspace; n += 1) {
      await repository.create(wid, {
        connectedBy: fillerId,
        provider: 'moodle',
        accountId: `moodle-${String(n)}.example.invalid`,
        label: `Moodle ${String(n)}`,
        authMethod: 'api_token_basic',
        topicId: null,
      });
    }
    const atCap = await start('github', {}, filler.token);
    const capped = await callback('github', await consent(atCap.url), atCap.nonce);
    assert.match(capped.location, /oauth_error=oauth_limit/);

    // Started as an editor, finished as a viewer: no new integration (ruling 9) …
    const viewerAfter = await api.login('prov-demoted@example.test');
    const demotedMe = await api.call('GET', '/api/private/me', { token: viewerAfter.token });
    const demotedId = (demotedMe.body?.['data'] as { id: string }).id;
    await memberships.create(wid, { userId: demotedId, role: 'editor' });
    const own = await connectThrough('github', viewerAfter.token);
    const started = await start('linear', {}, viewerAfter.token);
    await memberships.update(wid, demotedId, { role: 'viewer' });
    const refused = await callback('linear', await consent(started.url), started.nonce);
    assert.match(refused.location, /oauth_error=oauth_not_editor/);
    // … but their own existing one still reconnects (ruling 10).
    const again = await start('github', { integrationId: own }, viewerAfter.token);
    const reconnected = await callback('github', await consent(again.url), again.nonce);
    assert.equal(reconnected.location, `/en/integrations?connected=${own}`);
  });
});

describe('the routes', () => {
  it('a non-member gets 404, a viewer is refused, an unknown provider is 404', async () => {
    const outsider = await api.call('POST', START('github'), { token: outsiderToken, body: {} });
    assert.equal(outsider.status, 404, outsider.text);
    const viewer = await api.call('POST', START('github'), { token: viewerToken, body: {} });
    assert.ok([403, 404].includes(viewer.status), viewer.text);
    const unknown = await api.call('POST', START('slack'), { token, body: {} });
    assert.equal(unknown.status, 404, unknown.text);
    const callbackUnknown = await callback('slack', { state: 'x'.repeat(43) }, null);
    assert.equal(callbackUnknown.status, 404);
  });

  it('409 oauth_unavailable without the app secret; the listing says so', async () => {
    setAppSecretsForTests(
      Object.fromEntries(Object.entries(secrets).filter(([name]) => name !== 'oauth-clickup')),
    );
    try {
      const res = await api.call('POST', START('clickup'), { token, body: {} });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'oauth_unavailable');
      const list = await api.call(
        'GET',
        `/api/private/workspaces/${wid}/integrations/oauth/providers`,
        {
          token,
        },
      );
      const data = list.body?.['data'] as {
        providers: { provider: string; configured: boolean }[];
      };
      assert.equal(data.providers.find((entry) => entry.provider === 'clickup')?.configured, false);
      assert.equal(data.providers.find((entry) => entry.provider === 'linear')?.configured, true);
      assert.deepEqual(
        data.providers.map((entry) => entry.provider),
        ['github', 'jira', 'clickup', 'linear', 'google_calendar'],
      );
      assert.ok(!list.text.includes('callbackUrl'), 'the listing carries no operator setup');
      assert.ok(!list.text.includes('FAKE-'), 'the listing carries no client secret');
    } finally {
      setAppSecretsForTests({ ...secrets });
    }
  });

  it('a secret that cannot be used marks only that provider as not configured', async () => {
    // A typo while storing one of the fifteen app secrets must not break every card.
    setAppSecretsForTests({ ...secrets, 'oauth-linear': { clientId: '', clientSecret: '' } });
    try {
      const list = await api.call(
        'GET',
        `/api/private/workspaces/${wid}/integrations/oauth/providers`,
        { token },
      );
      assert.equal(list.status, 200, list.text);
      const data = list.body?.['data'] as {
        providers: { provider: string; configured: boolean }[];
      };
      assert.equal(data.providers.find((entry) => entry.provider === 'linear')?.configured, false);
      assert.equal(data.providers.find((entry) => entry.provider === 'github')?.configured, true);
    } finally {
      setAppSecretsForTests({ ...secrets });
    }
  });

  it('the setup listing is for any member (no secret in it); a non-member gets 404', async () => {
    const listing = `/api/private/workspaces/${wid}/integrations/oauth/providers`;
    const viewer = await api.call('GET', listing, { token: viewerToken });
    assert.equal(viewer.status, 200, viewer.text);
    const outsider = await api.call('GET', listing, { token: outsiderToken });
    assert.equal(outsider.status, 404, outsider.text);
  });

  it('lists the Jira sites and ClickUp workspaces of a grant', async () => {
    const jira = await connectThrough('jira');
    const sites = await api.call(
      'GET',
      `/api/private/workspaces/${wid}/integrations/${jira}/oauth/resources`,
      {
        token,
      },
    );
    assert.equal(sites.status, 200, sites.text);
    assert.deepEqual(
      (sites.body?.['data'] as { id: string }[]).map((site) => site.id),
      ['1324a887-45db-1bf4-1e99-ef0ff456d421'],
    );
    const linear = await connectThrough('linear');
    const refused = await api.call(
      'GET',
      `/api/private/workspaces/${wid}/integrations/${linear}/oauth/resources`,
      {
        token,
      },
    );
    assert.equal(refused.status, 409);
  });
});

describe('PATCH config: sites and workspaces are checked against the grant', () => {
  const PATCH = (iid: string): string => `/api/private/workspaces/${wid}/integrations/${iid}`;
  const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';

  it('Jira: an id the grant does not cover is refused; url and name come from Atlassian', async () => {
    const iid = await connectThrough('jira');
    const unknown = await api.call('PATCH', PATCH(iid), {
      token,
      body: {
        config: {
          sites: [
            {
              cloudId: 'ffffffff-0000-0000-0000-000000000000',
              url: 'https://x.example',
              name: 'X',
            },
          ],
        },
      },
    });
    assert.equal(unknown.status, 400, unknown.text);
    const forged = await api.call('PATCH', PATCH(iid), {
      token,
      body: {
        config: {
          sites: [{ cloudId: CLOUD, url: 'https://jira-login.evil.example', name: 'Acme' }],
        },
      },
    });
    assert.equal(forged.status, 200, forged.text);
    const stored = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.deepEqual(stored?.config['sites'], [
      { cloudId: CLOUD, url: 'https://mock-site.example.test', name: 'Mock Site' },
    ]);
  });

  it('ClickUp: a workspace the grant does not cover is refused', async () => {
    const iid = await connectThrough('clickup');
    const unknown = await api.call('PATCH', PATCH(iid), {
      token,
      body: { config: { teamIds: ['9001', '777'] } },
    });
    assert.equal(unknown.status, 400, unknown.text);
    const ok = await api.call('PATCH', PATCH(iid), {
      token,
      body: { config: { teamIds: ['9001'] } },
    });
    assert.equal(ok.status, 200, ok.text);
  });

  it('a Jira OAuth connection can not switch to a baseUrl', async () => {
    const iid = await connectThrough('jira');
    const res = await api.call('PATCH', PATCH(iid), {
      token,
      body: { config: { baseUrl: 'https://evil.atlassian.net' } },
    });
    assert.equal(res.status, 400, res.text);
  });
});

describe('minor behaviours', () => {
  it('GitHub’s install redirect (a code, no state) lands on the page without an error', async () => {
    const res = await callback(
      'github',
      { code: 'FAKE-install-code', setup_action: 'install' },
      null,
    );
    assert.equal(res.location, '/en/integrations');
  });

  it('refreshes while 20 minutes are left, longer than a run', async () => {
    const secret = await import('./secret.js');
    const soon = new Date(Date.now() + 19 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    const base = { accessToken: 'FAKE-a', refreshToken: 'FAKE-r' };
    assert.equal(
      secret.accessTokenStale({ ...base, accessTokenExpiresAt: soon }, new Date()),
      true,
    );
    assert.equal(
      secret.accessTokenStale({ ...base, accessTokenExpiresAt: later }, new Date()),
      false,
    );
  });
});

describe('refresh and rotation', () => {
  /** The access token a sync would use now (a snapshot taken inside the vault's callback). */
  async function accessTokenNow(integrationId: string): Promise<string> {
    const { decryptForSync } = await credentialDoors();
    let seen = '';
    await decryptForSync(integrationId, (secret) => {
      seen = secret['accessToken'] ?? '';
      return Promise.resolve(null);
    });
    return seen;
  }

  /** The stored access token reaches its expiry: what time does to a real grant. */
  async function expire(provider: MockOAuthProvider, integrationId: string): Promise<void> {
    const { decryptForSync, storeCredential } = await credentialDoors();
    let copy: Record<string, string> = {};
    await decryptForSync(integrationId, (secret) => {
      copy = { ...secret };
      return Promise.resolve(null);
    });
    await storeCredential({
      workspaceId: wid,
      integrationId,
      provider,
      ownerUserId: ownerId,
      kind: 'oauth',
      secret: { ...copy, accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
    });
  }

  for (const provider of ['github', 'jira', 'linear'] as const) {
    it(`${provider}: an expired access token is refreshed and sealed again, once for two at the same time`, async () => {
      const iid = await connectThrough(provider);
      const before = await accessTokenNow(iid);
      assert.equal(await accessTokenNow(iid), before, 'a fresh token is not refreshed');
      const calls = mock.tokenCalls(provider);
      await expire(provider, iid);
      const [a, b] = await Promise.all([accessTokenNow(iid), accessTokenNow(iid)]);
      assert.equal(a, b);
      assert.notEqual(a, before);
      assert.equal(mock.tokenCalls(provider) - calls, 1, 'one refresh served both');
      // The rotated refresh token was kept: the next expiry refreshes again.
      await expire(provider, iid);
      assert.notEqual(await accessTokenNow(iid), a);
      const credential = await (await models.getCredentialRepository()).findMeta(wid, iid);
      assert.ok(credential?.rotatedAt instanceof Date);
    });
  }

  it('a refresh token the provider refuses is auth_failed, not a crash loop', async () => {
    const iid = await connectThrough('linear');
    await expire('linear', iid);
    // The provider forgets the grant (as a revoked or rotated-away refresh token).
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    await assert.rejects(
      accessTokenNow(iid),
      (error: unknown) => (error as { code?: string }).code === 'auth_failed',
    );
  });

  it('a refused refresh ends the run as auth_failed, and the scheduler never sends it again', async () => {
    const iid = await connectThrough('linear');
    await expire('linear', iid);
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    const { runIntegrationSync } = await import('../../sync/runSync.js');
    const calls = mock.tokenCalls('linear');
    const first = await runIntegrationSync(iid, { mode: 'live', trigger: 'manual' });
    assert.equal(first.error?.code, 'auth_failed');
    assert.equal(mock.tokenCalls('linear') - calls, 1);
    const integration = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.equal(integration?.status, 'error');
    const lastError = integration.lastError;
    assert.equal(lastError?.code, 'auth_failed');
    const dispatched = await (await models.getIntegrationRepository()).listActiveForDispatch();
    assert.ok(!dispatched.some((entry) => entry.id === iid), 'no longer scheduled');
    // The scheduler (dispatchAllSyncs lists exactly these) never queues it again: the provider got
    // one token call in total, however many scheduled passes follow.
    assert.equal(mock.tokenCalls('linear') - calls, 1);
  });

  it('ClickUp tokens do not expire: never refreshed', async () => {
    const iid = await connectThrough('clickup');
    const calls = mock.tokenCalls('clickup');
    await accessTokenNow(iid);
    assert.equal(mock.tokenCalls('clickup'), calls);
  });
});

describe('compare-and-set on the credential version', () => {
  it('a replacement at a stale version is refused, and the stored secret is kept', async () => {
    const iid = await connectThrough('jira');
    const repo = await models.getCredentialRepository();
    const sealed = await repo.findSealed(wid, iid);
    assert.ok(sealed);
    assert.equal(await repo.replaceSealedIf(wid, iid, sealed.version, sealed.enc), true);
    assert.equal(await repo.replaceSealedIf(wid, iid, sealed.version, sealed.enc), false);
    assert.equal((await repo.findSealed(wid, iid))?.version, sealed.version + 1);
  });
});

describe('disconnect', () => {
  it('Linear’s grant is revoked at Linear; the others have nothing to call', async () => {
    const linear = await connectThrough('linear');
    const before = mock.revokedCount('linear');
    const res = await api.call('DELETE', `/api/private/workspaces/${wid}/integrations/${linear}`, {
      token,
    });
    assert.equal(res.status, 204, res.text);
    assert.ok(mock.revokedCount('linear') > before);
    const github = await connectThrough('github');
    const gone = await api.call('DELETE', `/api/private/workspaces/${wid}/integrations/${github}`, {
      token,
    });
    assert.equal(gone.status, 204, gone.text);
  });
});

describe('locally, nothing reaches a real provider', () => {
  for (const provider of MOCK_OAUTH_PROVIDERS) {
    it(`${provider}: a sync and a refresh only send requests to loopback hosts`, async () => {
      const iid = await connectThrough(provider);
      const { runIntegrationSync } = await import('../../sync/runSync.js');
      const { liveTransport } = await import('../../sync/transports/live.js');
      const hosts: string[] = [];
      const live = liveTransport();
      const recorder = {
        send: (request: HttpRequest): Promise<HttpResponse> => {
          hosts.push(new URL(request.url).hostname);
          return live.send(request);
        },
      };
      await runIntegrationSync(iid, {
        mode: 'live',
        trigger: 'manual',
        transport: recorder,
      }).catch(() => undefined);
      assert.ok(hosts.length > 0, 'the sync made requests');
      assert.ok(
        hosts.every((host) => host === '127.0.0.1'),
        `non-loopback hosts: ${hosts.join(',')}`,
      );
    });
  }

  it('without the stand-in an OAuth integration syncs live, over the plain transport', async () => {
    const { syncModeFor } = await import('../../sync/syncMode.js');
    const { transportForIntegration } = await import('./transport.js');
    setOAuthBaseUrlForTests(null);
    try {
      for (const provider of MOCK_OAUTH_PROVIDERS) {
        assert.equal(syncModeFor({ authMethod: 'oauth', provider }, 'live'), 'live');
        const inner = { send: (): Promise<HttpResponse> => assert.fail('no request') };
        assert.equal(transportForIntegration(inner, { provider, authMethod: 'oauth' }), inner);
      }
      // A token integration follows the mode the test forced, as before.
      assert.equal(
        syncModeFor({ authMethod: 'personal_token', provider: 'clickup' }, 'live'),
        'fixtures',
      );
    } finally {
      setOAuthBaseUrlForTests(mock.url);
    }
  });
});

describe('the allow-list and secrecy', () => {
  it('a client accepts only exact provider token and revoke URLs', async () => {
    const { createReadOnlyClient } = await import('../../sync/http.js');
    const transport = { send: (): never => assert.fail('no request') };
    for (const url of [
      'https://evil.example/oauth/token',
      'https://api.linear.app/oauth/token/',
      'https://api.linear.app/oauth/token?x=1',
      'http://api.linear.app/oauth/token',
      'https://api.linear.app/graphql',
      'https://auth.atlassian.com/oauth/token/extra',
      'https://github.com/login/oauth/access_token#frag',
    ]) {
      assert.throws(
        () => createReadOnlyClient({ provider: 'x', transport, tokenExchangeUrl: url }),
        /allow-listed/,
      );
    }
    for (const url of ['https://api.linear.app/oauth/revoke/', 'https://evil.example/revoke']) {
      assert.throws(
        () => createReadOnlyClient({ provider: 'x', transport, revokeUrl: url }),
        /allow-listed/,
      );
    }
    for (const url of [
      'https://api.linear.app/oauth/token',
      'https://github.com/login/oauth/access_token',
      'https://auth.atlassian.com/oauth/token',
      'https://api.clickup.com/api/v2/oauth/token',
    ]) {
      createReadOnlyClient({ provider: 'x', transport, tokenExchangeUrl: url });
    }
  });

  it('a GET to a token endpoint is refused, other API calls on the shared hosts are not', async () => {
    const { createReadOnlyClient } = await import('../../sync/http.js');
    const calls: string[] = [];
    const client = createReadOnlyClient({
      provider: 'x',
      transport: {
        send: (request) => {
          calls.push(request.url);
          return Promise.resolve({ status: 200, headers: {}, body: '{}' });
        },
      },
    });
    for (const url of [
      'https://api.linear.app/oauth/token',
      'https://api.clickup.com/api/v2/oauth/token?code=x',
      'https://github.com/login/oauth/access_token',
      'https://auth.atlassian.com/anything',
    ]) {
      await assert.rejects(client.getJson(url), /token host/);
    }
    await client.getJson('https://api.clickup.com/api/v2/team');
    assert.deepEqual(calls, ['https://api.clickup.com/api/v2/team']);
  });

  it("the stand-in is a test seam: the providers' endpoints otherwise, and loopback only", async () => {
    const { oauthEndpoints } = await import('../../sync/providers/oauthEndpoints.js');
    const { callbackUrl, setCallbackOriginForTests } = await import('./common.js');
    setOAuthBaseUrlForTests(null);
    setCallbackOriginForTests(null);
    try {
      assert.equal(oauthEndpoints('linear').token, 'https://api.linear.app/oauth/token');
      assert.equal(
        callbackUrl('/api/public/oauth/linear/callback'),
        'https://localhost/api/public/oauth/linear/callback',
      );
      assert.throws(() => {
        setOAuthBaseUrlForTests('https://evil.example');
      }, /loopback/);
      assert.throws(() => {
        setCallbackOriginForTests('https://evil.example');
      }, /loopback/);
    } finally {
      setOAuthBaseUrlForTests(mock.url);
      setCallbackOriginForTests(api.baseUrl);
    }
  });

  it('no token, code, state verifier or client secret is in any redirect, response or log line', async () => {
    const results: string[] = [];
    for (const provider of MOCK_OAUTH_PROVIDERS) {
      const { url, nonce } = await start(provider);
      const query = await consent(url);
      results.push((await callback(provider, query, nonce)).location);
      const bad = await start(provider);
      results.push(
        (await callback(provider, { state: bad.state, code: 'FAKE-leaky-code' }, bad.nonce))
          .location,
      );
    }
    const everything = [...results, ...logged].join('\n');
    assert.ok(
      !/FAKE-[a-z]+-(access|refresh|client-secret)/.test(everything),
      'a secret is in the output',
    );
    assert.ok(!everything.includes('FAKE-leaky-code'));
    assert.ok(!everything.includes('FAKE-code-'));
  });
});
