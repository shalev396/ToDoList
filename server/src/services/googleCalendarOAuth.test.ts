/**
 * Google Calendar OAuth: start, the state's lifecycle (single use, 10 minutes, bound to the
 * provider and the browser), PKCE, and every callback failure as a redirect with a code only.
 * Nothing here reaches Google or the mock: each callback fails before the code exchange.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import type * as Classes from '../classes/integration/index.js';
import { pkceChallenge } from './crypto/hashing.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';
import { setGoogleBaseUrlForTests } from '../sync/providers/googleEndpoints.js';
import { setAppSecretsForTests } from './appSecrets.js';

forceSyncModeForTests('fixtures');

const CLIENT = {
  clientId: 'FAKE-client-id.apps.googleusercontent.example',
  clientSecret: 'FAKE-client-secret-0123456789',
};

let api: ApiHarness;
let classes: typeof Classes;

/** The Google Calendar callback, as its route runs it (OAuthFlow.consume). */
const consume = (
  query: Record<string, unknown>,
  browserNonce: string | null,
  now?: Date,
): Promise<string> =>
  classes.OAuthFlow.consume(classes.GoogleCalendarIntegration, { query, browserNonce }, now);
let models: typeof Models;
let token: string;
let ownerId: string;
let wid: string;
let viewerToken: string;

const START = (): string =>
  `/api/private/workspaces/${wid}/integrations/google-calendar/oauth/start`;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

before(async () => {
  api = await startApiHarness('todolist_gcal_oauth_unit');
  setAppSecretsForTests({ 'google-calendar-oauth': CLIENT });
  // Never contacted: every callback below fails before the exchange.
  setGoogleBaseUrlForTests('http://127.0.0.1:9');
  classes = await import('../classes/integration/index.js');
  models = await import('../models/index.js');
  const login = await api.login('oauth-owner@example.test');
  token = login.token;
  const me = await api.call('GET', '/api/private/me', { token });
  ownerId = (me.body?.['data'] as { id: string }).id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'OAuth', slug: `oauth-${randomUUID().slice(0, 8)}`, ownerId });
  wid = workspace.id;
  await (await models.getMembershipRepository()).create(wid, { userId: ownerId, role: 'owner' });
  const viewer = await api.login('oauth-viewer@example.test');
  viewerToken = viewer.token;
  const viewerMe = await api.call('GET', '/api/private/me', { token: viewerToken });
  await (
    await models.getMembershipRepository()
  ).create(wid, { userId: (viewerMe.body?.['data'] as { id: string }).id, role: 'viewer' });
});
after(async () => {
  await api.stop();
});

interface Started {
  state: string;
  nonce: string;
  url: URL;
}

/** POST …/oauth/start through the API: the authorize URL's state and the cookie's nonce. */
async function start(body: Record<string, unknown> = {}): Promise<Started> {
  const response = await fetch(`${api.baseUrl}${START()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const url = new URL((JSON.parse(text) as { data: { authorizeUrl: string } }).data.authorizeUrl);
  const cookie = response.headers.get('set-cookie') ?? '';
  const nonce = /todolist_oauth=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1];
  assert.ok(nonce !== undefined, cookie);
  return { state: url.searchParams.get('state') ?? '', nonce, url };
}

async function callback(
  query: Record<string, string>,
  cookie: string | null,
): Promise<{ status: number; location: string; setCookie: string }> {
  const response = await fetch(
    `${api.baseUrl}/api/public/oauth/google-calendar/callback?${new URLSearchParams(query).toString()}`,
    { redirect: 'manual', headers: cookie === null ? {} : { cookie: `todolist_oauth=${cookie}` } },
  );
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    setCookie: response.headers.get('set-cookie') ?? '',
  };
}

describe('POST …/integrations/google-calendar/oauth/start', () => {
  it('answers the authorize URL: PKCE S256, offline access, consent, the calendar scopes', async () => {
    const { state, nonce, url } = await start();
    assert.equal(`${url.origin}${url.pathname}`, 'http://127.0.0.1:9/o/oauth2/v2/auth');
    const params = Object.fromEntries(url.searchParams);
    assert.deepEqual(Object.keys(params).sort(), [
      'access_type',
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'include_granted_scopes',
      'prompt',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ]);
    assert.equal(params['response_type'], 'code');
    assert.equal(params['access_type'], 'offline');
    assert.equal(params['prompt'], 'consent');
    assert.equal(params['include_granted_scopes'], 'true');
    assert.equal(params['code_challenge_method'], 'S256');
    assert.equal(
      params['scope'],
      'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    );
    // The stage's own domain (the harness runs as dev on DOMAIN_NAME=localhost).
    assert.equal(
      params['redirect_uri'],
      'https://localhost/api/public/oauth/google-calendar/callback',
    );
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);

    // Stored: hashes, the verifier (server-only), the user and the workspace.
    const record = await (await models.getOAuthStateRepository()).findByStateHash(sha256(state));
    assert.ok(record);
    assert.equal(record.browserHash, sha256(nonce));
    assert.equal(record.userId, ownerId);
    assert.equal(record.workspaceId, wid);
    assert.equal(record.provider, 'google_calendar');
    assert.equal(record.usedAt, null);
    assert.equal(pkceChallenge(record.codeVerifier), params['code_challenge']);
    assert.match(record.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!url.href.includes(record.codeVerifier), 'the verifier never leaves the server');
  });

  it('sets the binding cookie HttpOnly, SameSite=Lax, on the OAuth callbacks only, 10 minutes', async () => {
    const response = await fetch(`${api.baseUrl}${START()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/api\/public\/oauth/);
    assert.match(cookie, /Max-Age=600/);
  });

  it('is for owners only, and refuses a reconnect of another kind of integration', async () => {
    const asViewer = await api.call('POST', START(), { token: viewerToken, body: {} });
    assert.ok([403, 404].includes(asViewer.status), asViewer.text);
    const jira = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      connectedBy: ownerId,
      provider: 'jira',
      accountId: 'oauth-test.atlassian.example',
      label: 'Jira',
      authMethod: 'api_token_basic',
      topicId: 'work',
    });
    const reconnect = await api.call('POST', START(), {
      token,
      body: { integrationId: jira.id },
    });
    assert.equal(reconnect.status, 400, reconnect.text);
    const extra = await api.call('POST', START(), { token, body: { redirect: 'https://x.test' } });
    assert.equal(extra.status, 400, extra.text);
  });

  it('409 oauth_unavailable when the server has no OAuth client', async () => {
    setAppSecretsForTests({});
    try {
      const res = await api.call('POST', START(), { token, body: {} });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'oauth_unavailable');
    } finally {
      setAppSecretsForTests({ 'google-calendar-oauth': CLIENT });
    }
  });
});

describe('PKCE', () => {
  it('S256 is BASE64URL(SHA256(verifier)), unpadded (RFC 7636 §4.2), computed independently', async () => {
    const verifier = 'dBjftJeZ4CVP-mJ92K9qpvb2oD-B1LoeLWNUnJVMAqA';
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    );
    const expected = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(pkceChallenge(verifier), expected);
    assert.match(expected, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('the state: single use, 10 minutes, its provider, its browser', () => {
  const later = (minutes: number): Date => new Date(Date.now() + minutes * 60 * 1000);

  it('expired after 10 minutes', async () => {
    const { state, nonce } = await start();
    assert.equal(
      await consume({ state, code: 'c' }, nonce, later(10.5)),
      '/en/integrations?oauth_error=oauth_state_expired',
    );
  });

  it('reused: the second callback is refused', async () => {
    const { state, nonce } = await start();
    const query = { state, error: 'access_denied' };
    assert.equal(await consume(query, nonce), '/en/integrations?oauth_error=oauth_denied');
    assert.equal(await consume(query, nonce), '/en/integrations?oauth_error=oauth_state_used');
    const record = await (await models.getOAuthStateRepository()).findByStateHash(sha256(state));
    assert.ok(record?.usedAt instanceof Date);
  });

  it('another provider’s state is refused', async () => {
    const state = 'G'.repeat(43);
    await (
      await models.getOAuthStateRepository()
    ).create(wid, {
      stateHash: sha256(state),
      browserHash: sha256('n'.repeat(43)),
      codeVerifier: 'v'.repeat(43),
      userId: ownerId,
      provider: 'github',
      integrationId: null,
      lng: 'en',
      createdAt: new Date(),
    });
    assert.equal(
      await consume({ state, code: 'c' }, 'n'.repeat(43)),
      '/en/integrations?oauth_error=oauth_state_invalid',
    );
  });

  it('an unknown or malformed state is refused', async () => {
    for (const state of ['', 'short', 'x'.repeat(43), '<script>'.repeat(6)]) {
      assert.equal(
        await consume({ state, code: 'c' }, null),
        '/en/integrations?oauth_error=oauth_state_invalid',
      );
    }
  });

  it('another browser (no cookie, or another nonce) is refused, and that burns the state', async () => {
    const { state, nonce } = await start();
    assert.equal(
      await consume({ state, code: 'c' }, null),
      '/en/integrations?oauth_error=oauth_state_invalid',
    );
    assert.equal(
      await consume({ state, code: 'c' }, nonce),
      '/en/integrations?oauth_error=oauth_state_used',
    );
    const other = await start();
    assert.equal(
      await consume({ state: other.state, code: 'c' }, nonce),
      '/en/integrations?oauth_error=oauth_state_invalid',
    );
  });

  it('returns to the language the flow started in', async () => {
    const { state, nonce } = await start({ lng: 'he' });
    assert.equal(await consume({ state }, nonce), '/he/integrations?oauth_error=oauth_failed');
  });
});

describe('GET /api/public/oauth/google-calendar/callback', () => {
  it('every failure is a 302 to the fixed page with a code only, and clears the cookie', async () => {
    const { state, nonce } = await start();
    const cases: [Record<string, string>, string | null, string][] = [
      [{}, null, 'oauth_state_invalid'],
      [{ state: 'nope', code: 'abc' }, nonce, 'oauth_state_invalid'],
      [{ state, error: 'access_denied', code: 'FAKE-code-0123' }, nonce, 'oauth_denied'],
      [{ state, code: 'FAKE-code-0123' }, nonce, 'oauth_state_used'],
    ];
    for (const [query, cookie, code] of cases) {
      const res = await callback(query, cookie);
      assert.equal(res.status, 302);
      assert.equal(res.location, `/en/integrations?oauth_error=${code}`);
      assert.ok(!res.location.includes(state) && !res.location.includes('FAKE-code'));
      assert.match(res.setCookie, /todolist_oauth=;/);
      assert.match(res.setCookie, /Path=\/api\/public\/oauth/);
    }
  });

  it('never follows a caller-supplied redirect', async () => {
    const res = await callback(
      { state: 'x', redirect_uri: 'https://attacker.test', next: '//attacker.test' },
      null,
    );
    assert.equal(res.location, '/en/integrations?oauth_error=oauth_state_invalid');
  });
});
