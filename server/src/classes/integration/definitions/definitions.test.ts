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
import {
  COMING_SOON_PROVIDERS,
  CONNECTABLE_PROVIDERS,
  WRITABLE_FIELDS,
} from '../../../types/integrations.js';
import {
  Integration,
  IntegrationRegistry,
  isCalendarProvider,
  isCreateFunnel,
  isCourseProvider,
  isResourcePicker,
  isTaskProvider,
} from '../index.js';
import { GITHUB_TOKEN } from './github.js';
import { GOOGLE_CALENDAR_OAUTH, GOOGLE_SERVICE_ACCOUNT } from './googleCalendar.js';
import { DEFINITIONS, definitionOf, sessionAuth, strategyForMethod } from './index.js';
import { pkceChallenge } from '../../../services/crypto/hashing.js';
import type { AuthorizeRequest } from '../auth/OAuthAuth.js';
import { CLICKUP_OAUTH } from './clickup.js';
import { GITHUB_OAUTH } from './github.js';
import { JIRA_API_TOKEN, JIRA_OAUTH } from './jira.js';
import { LINEAR_OAUTH } from './linear.js';
import { MOODLE_TOKEN } from './moodle.js';

const STATE = 'S'.repeat(43);
const VERIFIER = 'V'.repeat(43);
const CLIENT_ID = 'FAKE-client-id';
const redirect = (provider: string): string =>
  `https://todolist.example.test/api/public/oauth/${provider}/callback`;
/** The authorize URL the provider's routes have always sent, its parameters in their order. */
const golden = (authorize: string, pairs: [string, string][]): string =>
  `${authorize}?${new URLSearchParams(pairs).toString()}`;

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

  it('send the same authorize URLs as before, byte for byte, with and without the write scope', () => {
    const request = (provider: string, includeWrite: boolean): AuthorizeRequest => ({
      clientId: CLIENT_ID,
      redirectUri: redirect(provider),
      state: STATE,
      verifier: VERIFIER,
      includeWrite,
      loginHint: 'me@example.test',
    });
    const base = (provider: string): [string, string][] => [
      ['client_id', CLIENT_ID],
      ['redirect_uri', redirect(provider)],
      ['state', STATE],
    ];
    const pkce: [string, string][] = [
      ['code_challenge', pkceChallenge(VERIFIER)],
      ['code_challenge_method', 'S256'],
    ];
    for (const includeWrite of [false, true]) {
      // GitHub App: no response_type, no scopes (the app's permissions decide), PKCE.
      assert.equal(
        GITHUB_OAUTH.authorizeUrl(request('github', includeWrite)),
        golden('https://github.com/login/oauth/authorize', [...base('github'), ...pkce]),
      );
      // Atlassian 3LO: response_type, read scopes (write by re-consent), audience, consent, no PKCE.
      assert.equal(
        JIRA_OAUTH.authorizeUrl(request('jira', includeWrite)),
        golden('https://auth.atlassian.com/authorize', [
          ...base('jira'),
          ['response_type', 'code'],
          [
            'scope',
            `read:jira-work read:jira-user read:me offline_access${includeWrite ? ' write:jira-work' : ''}`,
          ],
          ['audience', 'api.atlassian.com'],
          ['prompt', 'consent'],
        ]),
      );
      // ClickUp: nothing beyond the client, the callback and the state.
      assert.equal(
        CLICKUP_OAUTH.authorizeUrl(request('clickup', includeWrite)),
        golden('https://app.clickup.com/api', base('clickup')),
      );
      // Linear: response_type, its scopes comma separated, PKCE.
      assert.equal(
        LINEAR_OAUTH.authorizeUrl(request('linear', includeWrite)),
        golden('https://linear.app/oauth/authorize', [
          ...base('linear'),
          ['response_type', 'code'],
          ['scope', includeWrite ? 'read,write' : 'read'],
          ...pkce,
        ]),
      );
    }
  });

  it('send Google its parameters as before (any order), the login hint only for an email', () => {
    const params = (loginHint: string | null): Record<string, string> =>
      Object.fromEntries(
        new URL(
          GOOGLE_CALENDAR_OAUTH.authorizeUrl({
            clientId: CLIENT_ID,
            redirectUri: 'https://todolist.example.test/api/public/oauth/google-calendar/callback',
            state: STATE,
            verifier: VERIFIER,
            includeWrite: false,
            loginHint,
          }),
        ).searchParams,
      );
    const expected = {
      client_id: CLIENT_ID,
      redirect_uri: 'https://todolist.example.test/api/public/oauth/google-calendar/callback',
      response_type: 'code',
      // calendar.app.created (phase 2b): TodoList may create a calendar of its own.
      scope:
        'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: STATE,
      code_challenge: pkceChallenge(VERIFIER),
      code_challenge_method: 'S256',
    };
    assert.deepEqual(params(null), expected);
    assert.deepEqual(params('Work account'), expected);
    assert.deepEqual(params('me@example.test'), { ...expected, login_hint: 'me@example.test' });
    assert.ok(
      GOOGLE_CALENDAR_OAUTH.authorizeUrl({
        clientId: CLIENT_ID,
        redirectUri: 'x',
        state: STATE,
        verifier: VERIFIER,
        includeWrite: false,
        loginHint: null,
      }).startsWith('https://accounts.google.com/o/oauth2/v2/auth?'),
    );
  });

  it('ask for the same scopes as before (Google: also its own calendars), writes by re-consent', () => {
    const scopes = (provider: string): [readonly string[], readonly string[]] => {
      const oauth = definitionOf(provider)?.auth.oauth;
      assert.ok(oauth !== undefined, provider);
      return [oauth.scopes, oauth.writeScopes];
    };
    assert.deepEqual(scopes('jira'), [
      ['read:jira-work', 'read:jira-user', 'read:me', 'offline_access'],
      ['write:jira-work'],
    ]);
    assert.deepEqual(scopes('linear'), [['read'], ['write']]);
    assert.deepEqual(scopes('github'), [[], []]);
    assert.deepEqual(scopes('clickup'), [[], []]);
    assert.deepEqual(scopes('google_calendar'), [
      [
        'openid',
        'email',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.app.created',
      ],
      [],
    ]);
    // Asked, never required: a grant from before still connects (createCalendar asks for it).
    assert.deepEqual(
      definitionOf('google_calendar')?.auth.oauth?.lacksRequiredScope([
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      ]),
      false,
    );
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
      // A write-back is declared exactly where the class implements one (TaskProvider#updateTask,
      // CalendarProvider#updateEvent), and each writable field is one the Item model has.
      assert.equal(
        isTaskProvider(can) || isCalendarProvider(can),
        definition.writableFields.length > 0,
        `${cls.name}: write-back`,
      );
      for (const field of definition.writableFields) {
        assert.ok((WRITABLE_FIELDS as readonly string[]).includes(field), `${cls.name}: ${field}`);
      }
      // A CourseProvider (Moodle) refuses every course read while it is coming soon, so it is
      // declared coming soon: the client shows it with that badge and offers no way to use it.
      if (isCourseProvider(can)) assert.equal(definition.comingSoon, true, `${cls.name}: courses`);
    }
  });

  it('declares each provider’s writable fields: what its API has of an item, nothing more', () => {
    assert.deepEqual(
      Object.fromEntries(
        DEFINITIONS.map((d) => [
          d.provider,
          [[...d.writableFields], [...d.writableKinds], [...d.reachableStatuses]],
        ]),
      ),
      {
        jira: [
          ['title', 'status', 'dueAt', 'priority'],
          ['issue'],
          ['open', 'in_progress', 'done'],
        ],
        clickup: [
          ['title', 'status', 'dueAt', 'startAt', 'priority'],
          ['task'],
          ['open', 'in_progress', 'done'],
        ],
        linear: [
          ['title', 'status', 'dueAt', 'priority'],
          ['issue'],
          ['open', 'in_progress', 'done', 'cancelled'],
        ],
        moodle: [[], [], []],
        google_calendar: [['title', 'startAt', 'endAt'], ['event'], []],
        github: [['title', 'status'], ['issue'], ['open', 'done', 'cancelled']],
      },
    );
    // A status is reachable only where the status itself is writable.
    for (const definition of DEFINITIONS) {
      assert.equal(
        definition.reachableStatuses.length > 0,
        definition.writableFields.includes('status'),
        definition.provider,
      );
    }
    // A GitHub pull request or board draft takes none.
    assert.deepEqual(definitionOf('github')?.writableFieldsFor('pr'), []);
    assert.deepEqual(definitionOf('github')?.writableFieldsFor('task'), []);
    assert.deepEqual(definitionOf('github')?.writableFieldsFor('issue'), ['title', 'status']);
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
        canUpdate: true,
        writableFields: ['title', 'status', 'dueAt', 'priority'],
        writableKinds: ['issue'],
        reachableStatuses: ['open', 'in_progress', 'done'],
        comingSoon: false,
      },
      {
        provider: 'clickup',
        authMethods: ['oauth', 'personal_token'],
        picker: 'workspaces',
        revokesOnDisconnect: false,
        revokePage: 'https://app.clickup.com/settings/apps',
        canCreate: true,
        canUpdate: true,
        writableFields: ['title', 'status', 'dueAt', 'startAt', 'priority'],
        writableKinds: ['task'],
        reachableStatuses: ['open', 'in_progress', 'done'],
        comingSoon: false,
      },
      {
        provider: 'linear',
        authMethods: ['oauth', 'personal_api_key'],
        picker: null,
        revokesOnDisconnect: true,
        revokePage: 'https://linear.app/settings/account/security',
        canCreate: true,
        canUpdate: true,
        writableFields: ['title', 'status', 'dueAt', 'priority'],
        writableKinds: ['issue'],
        reachableStatuses: ['open', 'in_progress', 'done', 'cancelled'],
        comingSoon: false,
      },
      {
        provider: 'moodle',
        authMethods: ['moodle_ws_token'],
        picker: null,
        revokesOnDisconnect: false,
        revokePage: null,
        canCreate: false,
        canUpdate: false,
        writableFields: [],
        writableKinds: [],
        reachableStatuses: [],
        comingSoon: true,
      },
      {
        provider: 'google_calendar',
        authMethods: ['oauth'],
        picker: 'calendars',
        revokesOnDisconnect: true,
        revokePage: null,
        canCreate: true,
        canUpdate: true,
        writableFields: ['title', 'startAt', 'endAt'],
        writableKinds: ['event'],
        reachableStatuses: [],
        comingSoon: false,
      },
      {
        provider: 'github',
        authMethods: ['oauth', 'fine_grained_pat'],
        picker: null,
        revokesOnDisconnect: false,
        revokePage: 'https://github.com/settings/apps/authorizations',
        canCreate: true,
        canUpdate: true,
        writableFields: ['title', 'status'],
        writableKinds: ['issue'],
        reachableStatuses: ['open', 'done', 'cancelled'],
        comingSoon: false,
      },
    ]);
  });
});
