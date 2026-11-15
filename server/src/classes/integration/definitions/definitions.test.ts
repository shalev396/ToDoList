/**
 * The provider definitions (one `static definition` per provider class) hold what used to be five
 * parallel tables. These tests pin what must not move: the list itself, the OAuth endpoints (and
 * that the network allow-list covers each one), the callback paths registered at the providers,
 * the scopes, what a key connection starts with, the auth strategies' headers, and the
 * capabilities each class answers the client with (its contracts and its definition agree).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ReadOnlyClient, TokenGrant } from '../../../sync/http.js';
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, OAUTH_TOKEN_ENDPOINTS } from '../../../sync/http.js';
import { setAppSecretsForTests } from '../../../services/appSecrets.js';
import { isOAuthProviderId } from '../../../sync/providers/oauthEndpoints.js';
import { COMING_SOON_PROVIDERS, CONNECTABLE_PROVIDERS } from '../../../types/integrations.js';
import { Integration, IntegrationRegistry, isCreateFunnel, isResourcePicker } from '../index.js';
import { GITHUB_TOKEN } from './github.js';
import { GOOGLE_CALENDAR_OAUTH, GOOGLE_SERVICE_ACCOUNT } from './googleCalendar.js';
import { DEFINITIONS, definitionOf, sessionAuth, strategyForMethod } from './index.js';
import { JIRA_API_TOKEN, JIRA_OAUTH } from './jira.js';
import { MOODLE_TOKEN } from './moodle.js';

/** A client that only answers token exchanges, counting them. */
function exchanger(): ReadOnlyClient & { exchanges: number } {
  const client = {
    exchanges: 0,
    exchangeToken(): Promise<TokenGrant> {
      client.exchanges += 1;
      return Promise.resolve({
        accessToken: `FAKE-access-${String(client.exchanges)}`,
        refreshToken: null,
        expiresIn: 3600,
        scope: null,
      });
    },
  };
  return client as unknown as ReadOnlyClient & { exchanges: number };
}

describe('the definitions', () => {
  it('name every connectable provider once, in its order, each its class’s own', () => {
    assert.deepEqual(
      DEFINITIONS.map(({ provider }) => provider),
      [...CONNECTABLE_PROVIDERS],
    );
    for (const definition of DEFINITIONS) {
      const cls = IntegrationRegistry.instance.classOf(definition.provider);
      assert.ok(cls !== null, definition.provider);
      assert.equal(cls.definition, definition, `${cls.name}.definition`);
      assert.equal(definitionOf(definition.provider), definition);
    }
    assert.equal(definitionOf('slack'), null);
  });

  it('keep each OAuth app’s endpoints on the network allow-list, and their callbacks where registered', () => {
    const oauths = DEFINITIONS.flatMap(({ auth }) =>
      auth.oauth === undefined ? [] : [auth.oauth],
    );
    assert.deepEqual(
      oauths.map((oauth) => oauth.provider),
      ['jira', 'clickup', 'linear', 'google_calendar', 'github'],
    );
    for (const oauth of oauths) {
      const provider: string = oauth.provider;
      const { token, revoke } = oauth.endpoints();
      if (isOAuthProviderId(provider)) {
        assert.deepEqual({ token, revoke }, OAUTH_TOKEN_ENDPOINTS[provider], provider);
        assert.equal(oauth.callbackPath, `/api/public/oauth/${provider}/callback`);
      } else {
        assert.deepEqual({ token, revoke }, { token: GOOGLE_TOKEN_URL, revoke: GOOGLE_REVOKE_URL });
        assert.equal(oauth.callbackPath, '/api/public/oauth/google-calendar/callback');
      }
    }
  });

  it('ask for the same scopes as before: read-only, writes by re-consent', () => {
    const scopes = (provider: string): [readonly string[], readonly string[]] => {
      const oauth = definitionOf(provider)?.auth.oauth;
      assert.ok(oauth !== undefined, provider);
      return [oauth.scopes, oauth.writeScopes];
    };
    assert.deepEqual(scopes('jira'), [
      ['read:jira-work', 'read:jira-user', 'read:me', 'offline_access'],
      ['write:jira-work'],
    ]);
    assert.deepEqual(scopes('linear'), [['read'], ['issues:create']]);
    assert.deepEqual(scopes('github'), [[], []]);
    assert.deepEqual(scopes('clickup'), [[], []]);
    assert.deepEqual(scopes('google_calendar'), [
      [
        'openid',
        'email',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      ],
      [],
    ]);
  });

  it('start a key connection as before, and list coming soon what the API types do', () => {
    assert.deepEqual(Object.fromEntries(DEFINITIONS.map((d) => [d.provider, d.keyMethods])), {
      jira: ['api_token_basic'],
      clickup: ['personal_token'],
      linear: ['personal_api_key'],
      moodle: ['moodle_ws_token'],
      google_calendar: ['service_account'],
      github: ['fine_grained_pat'],
    });
    assert.deepEqual(
      DEFINITIONS.filter((d) => d.comingSoon).map((d) => d.provider),
      [...COMING_SOON_PROVIDERS],
    );
    // A credential method's shape is its strategy's: OAuth takes none through a PUT.
    assert.equal(strategyForMethod('oauth')?.kind, 'oauth');
    assert.throws(() => JIRA_OAUTH.parseCredential('oauth', { accessToken: 'x' }), /Invalid/);
  });
});

describe('the auth strategies: the only code that builds an auth header', () => {
  it('a key: Basic for Jira, a second token for GitHub boards, a query token for Moodle', async () => {
    assert.deepEqual(JIRA_API_TOKEN.headers({}), { authorization: 'Basic Og==' });
    assert.deepEqual(GITHUB_TOKEN.headers({ token: 'FAKE-r' }, 'boards'), {
      authorization: 'Bearer FAKE-r',
    });
    assert.deepEqual(GITHUB_TOKEN.headers({ token: 'FAKE-r', projectsToken: 'FAKE-p' }, 'boards'), {
      authorization: 'Bearer FAKE-p',
    });
    assert.deepEqual(MOODLE_TOKEN.headers({ token: 'FAKE-m' }), {});
    assert.deepEqual(MOODLE_TOKEN.query({ token: 'FAKE-m' }), { wstoken: 'FAKE-m' });
    const bound = sessionAuth(
      { provider: 'moodle', authMethod: 'moodle_ws_token' },
      { token: 'FAKE-m' },
      exchanger(),
      new Date(),
    );
    assert.equal(bound.kind, 'api_key');
    assert.deepEqual(await bound.headers(), {});
    assert.deepEqual(bound.query(), { wstoken: 'FAKE-m' });
  });

  it('Google: the OAuth grant trades its refresh token once per session; the service account once per call', async () => {
    const client = exchanger();
    const oauth = GOOGLE_CALENDAR_OAUTH.bind({
      secret: { refreshToken: 'FAKE-refresh' },
      client,
      now: new Date(),
    });
    // No app on this server: a plain error, before anything is sent.
    setAppSecretsForTests({});
    try {
      await assert.rejects(oauth.headers(), /not set up/);
    } finally {
      setAppSecretsForTests(null);
    }
    assert.equal(client.exchanges, 0);
    setAppSecretsForTests({
      'google-calendar-oauth': { clientId: 'FAKE-id', clientSecret: 'FAKE-secret' },
    });
    try {
      const fresh = GOOGLE_CALENDAR_OAUTH.bind({
        secret: { refreshToken: 'FAKE-refresh' },
        client,
        now: new Date(),
      });
      assert.deepEqual(await fresh.headers(), { authorization: 'Bearer FAKE-access-1' });
      assert.deepEqual(await fresh.headers('write'), { authorization: 'Bearer FAKE-access-1' });
      assert.equal(client.exchanges, 1, 'one exchange per session');
    } finally {
      setAppSecretsForTests(null);
    }

    const account = GOOGLE_SERVICE_ACCOUNT.bind({ secret: {}, client, now: new Date() });
    assert.deepEqual(await account.headers(), { authorization: 'Bearer FAKE-access-2' });
    assert.deepEqual(await account.headers(), { authorization: 'Bearer FAKE-access-3' });
    assert.equal(account.kind, 'service_account');
  });

  it('a provider nobody connects gets no auth at all', async () => {
    const none = sessionAuth(
      { provider: 'slack', authMethod: 'personal_token' },
      {},
      exchanger(),
      new Date(),
    );
    assert.deepEqual(await none.headers(), {});
    assert.deepEqual(none.query(), {});
  });
});

describe('capabilities (what GET …/oauth/providers tells the client)', () => {
  it('each class’s contracts agree with its definition', () => {
    for (const definition of DEFINITIONS) {
      const cls = IntegrationRegistry.instance.classOf(definition.provider);
      assert.ok(cls !== null);
      const can = cls.prototype;
      assert.equal(isResourcePicker(can), definition.picker !== null, `${cls.name}: picker`);
      assert.equal(isCreateFunnel(can), definition.create !== null, `${cls.name}: create`);
    }
  });

  it('answers the matrix the cards used to hard-code', () => {
    assert.deepEqual(Integration.capabilitiesOf(), [
      {
        provider: 'jira',
        authMethods: ['oauth', 'api_token_basic'],
        picker: 'sites',
        revokesOnDisconnect: false,
        revokePage: 'https://id.atlassian.com/manage-profile/apps',
        canCreate: true,
        comingSoon: false,
      },
      {
        provider: 'clickup',
        authMethods: ['oauth', 'personal_token'],
        picker: 'workspaces',
        revokesOnDisconnect: false,
        revokePage: 'https://app.clickup.com/settings/apps',
        canCreate: true,
        comingSoon: false,
      },
      {
        provider: 'linear',
        authMethods: ['oauth', 'personal_api_key'],
        picker: null,
        revokesOnDisconnect: true,
        revokePage: 'https://linear.app/settings/account/security',
        canCreate: true,
        comingSoon: false,
      },
      {
        provider: 'moodle',
        authMethods: ['moodle_ws_token'],
        picker: null,
        revokesOnDisconnect: false,
        revokePage: null,
        canCreate: false,
        comingSoon: true,
      },
      {
        provider: 'google_calendar',
        authMethods: ['oauth'],
        picker: 'calendars',
        revokesOnDisconnect: true,
        revokePage: null,
        canCreate: true,
        comingSoon: false,
      },
      {
        provider: 'github',
        authMethods: ['oauth', 'fine_grained_pat'],
        picker: null,
        revokesOnDisconnect: false,
        revokePage: 'https://github.com/settings/apps/authorizations',
        canCreate: true,
        comingSoon: false,
      },
    ]);
  });
});
