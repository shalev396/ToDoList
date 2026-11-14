import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../errors/AppError.js';
import type { ConnectableProvider } from '../types/integrations.js';
import {
  assertProviderOpen,
  assertUserConnectable,
  assertSameAccount,
  CreateIntegrationBody,
  defaultLabel,
  isPlaceholderAccountId,
  parseCredential,
  parseProviderConfig,
  planConnection,
  UpdateIntegrationBody,
} from './integrationConfig.js';

/** For assert.throws: a 400 whose message names the field and never contains `secret`. */
function badRequest(where: RegExp, ...neverEchoes: string[]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.statusCode, 400);
    assert.match(error.message, where);
    for (const value of neverEchoes) assert.ok(!error.message.includes(value), error.message);
    return true;
  };
}

const PLACEHOLDER = /^pending:[0-9a-f-]{36}$/;

describe('planConnection: defaults per provider (topic, auth method, account, label)', () => {
  it('jira: work, basic auth, the site host as account and label; the URL normalized', () => {
    const plan = planConnection({
      provider: 'jira',
      config: { baseUrl: ' https://AutoDS.atlassian.net/ ', jql: 'assignee = currentUser()' },
    });
    assert.deepEqual(plan, {
      provider: 'jira',
      authMethod: 'api_token_basic',
      defaultTopic: 'work',
      mode: 'read',
      accountId: 'autods.atlassian.net',
      label: 'autods.atlassian.net',
      config: { baseUrl: 'https://autods.atlassian.net', jql: 'assignee = currentUser()' },
    });
  });

  it('clickup and linear: no settings, a pending:<uuid> account until the first test', () => {
    const clickup = planConnection({ provider: 'clickup', config: {} });
    assert.deepEqual(
      [clickup.authMethod, clickup.defaultTopic, clickup.label, clickup.config],
      ['personal_token', 'work', 'clickup', {}],
    );
    assert.match(clickup.accountId, PLACEHOLDER);
    const linear = planConnection({ provider: 'linear', config: {} });
    assert.deepEqual([linear.authMethod, linear.defaultTopic], ['personal_api_key', 'personal']);
    assert.match(linear.accountId, PLACEHOLDER);
    assert.notEqual(linear.accountId, clickup.accountId);
    assert.ok(isPlaceholderAccountId(linear.accountId));
    assert.ok(!isPlaceholderAccountId('autods.atlassian.net'));
  });

  it('moodle: college, the site host as account', () => {
    const plan = planConnection({
      provider: 'moodle',
      config: { siteUrl: 'https://moodle.braude.ac.il' },
    });
    assert.deepEqual(
      [plan.authMethod, plan.defaultTopic, plan.accountId, plan.label],
      ['moodle_ws_token', 'college', 'moodle.braude.ac.il', 'moodle.braude.ac.il'],
    );
  });

  it('google_calendar: personal, a read-only service account', () => {
    const config = { calendars: [{ id: 'primary', mode: 'two_way' }], horizonDays: 60 };
    const account = planConnection({ provider: 'google_calendar', config });
    assert.deepEqual(
      [account.authMethod, account.mode, account.defaultTopic],
      ['service_account', 'read', 'personal'],
    );
    assert.match(account.accountId, PLACEHOLDER);
  });

  it('github: the owner as account (lowercased) and label; a user is personal, an organization is work', () => {
    const user = planConnection({
      provider: 'github',
      config: { owner: 'Shalev396', ownerType: 'user' },
    });
    assert.deepEqual(
      [user.authMethod, user.defaultTopic, user.accountId, user.label],
      ['fine_grained_pat', 'personal', 'shalev396', 'Shalev396'],
    );
    const workspace = planConnection({
      provider: 'github',
      config: {
        owner: 'TLVTech',
        ownerType: 'org',
        repos: { include: ['TLVTech/*'], forks: false, archived: false },
        issues: { involvement: ['assigned', 'created'], closedWithinDays: 30 },
        boards: { include: [3], dueField: 'Target date' },
      },
    });
    assert.deepEqual([workspace.defaultTopic, workspace.accountId], ['work', 'tlvtech']);
  });

  it('a topic and a label given win over the defaults', () => {
    const plan = planConnection({
      provider: 'jira',
      config: { baseUrl: 'https://autods.atlassian.net' },
      topicId: 'personal',
      label: '  AutoDS Jira  ',
    });
    assert.deepEqual([plan.topicId, plan.label], ['personal', 'AutoDS Jira']);
  });

  it('an auth method must be one the provider supports', () => {
    assert.equal(
      planConnection({
        provider: 'jira',
        config: { baseUrl: 'https://autods.atlassian.net' },
        authMethod: 'api_token_basic',
      }).authMethod,
      'api_token_basic',
    );
    assert.throws(
      () =>
        planConnection({
          provider: 'google_calendar',
          config: { calendars: [] },
          authMethod: 'personal_token',
        }),
      badRequest(/^authMethod: /),
    );
    assert.throws(
      () => planConnection({ provider: 'linear', config: {}, authMethod: 'service_account' }),
      badRequest(/^authMethod: /),
    );
  });

  it('moodle is coming soon: refused with provider_coming_soon; the other providers are open', () => {
    assert.throws(
      () => {
        assertProviderOpen('moodle');
      },
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 400 &&
        error.code === 'provider_coming_soon',
    );
    for (const provider of ['jira', 'clickup', 'linear', 'google_calendar', 'github'] as const) {
      assert.doesNotThrow(() => {
        assertProviderOpen(provider);
      }, provider);
    }
  });

  it('google_calendar connects with Google sign-in only; the others take a token', () => {
    assert.throws(
      () => {
        assertUserConnectable('google_calendar');
      },
      badRequest(/sign-in/),
    );
    assert.throws(
      () => {
        assertUserConnectable('moodle');
      },
      badRequest(/coming soon/),
    );
    assert.doesNotThrow(() => {
      assertUserConnectable('github');
    });
  });

  it('defaultLabel: the site host, the owner, else the provider key', () => {
    assert.equal(defaultLabel('jira', { baseUrl: 'https://a.atlassian.net' }), 'a.atlassian.net');
    assert.equal(defaultLabel('moodle', { siteUrl: 'https://m.example.ac.il' }), 'm.example.ac.il');
    assert.equal(defaultLabel('github', { owner: 'Shalev396', ownerType: 'user' }), 'Shalev396');
    for (const provider of ['clickup', 'linear', 'google_calendar'] as const) {
      assert.equal(defaultLabel(provider, {}), provider);
    }
  });
});

describe('parseProviderConfig: client keys are never echoed', () => {
  const LONG_KEY = 'a-very-long-client-chosen-key-FAKE-0123456789';
  const TOKEN_KEY = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';

  it('an unrecognized key is a fixed message, whatever it is called', () => {
    for (const key of ['extra', LONG_KEY, TOKEN_KEY]) {
      assert.throws(
        () => parseProviderConfig('jira', { baseUrl: 'https://a.atlassian.net', [key]: true }),
        badRequest(/^config: Unrecognized key$/, key),
      );
    }
  });

  it('a push filter pointer replaces a long or secret-shaped key', () => {
    for (const key of [LONG_KEY, TOKEN_KEY]) {
      assert.throws(
        () =>
          parseProviderConfig('google_calendar', {
            calendars: [],
            pushFilter: { source: 'items', where: { [key]: 1 } },
          }),
        badRequest(/^config\.pushFilter/, key),
      );
    }
  });
});

describe('parseProviderConfig: one strict schema per provider (400 names the field, never the value)', () => {
  const refused: [ConnectableProvider, unknown, RegExp][] = [
    ['jira', {}, /^config\.baseUrl: /],
    ['jira', { baseUrl: 'http://autods.atlassian.net' }, /^config\.baseUrl: /],
    ['jira', { baseUrl: 'https://dev:pw@autods.atlassian.net' }, /^config\.baseUrl: /],
    ['jira', { baseUrl: 'https://autods.atlassian.net/?x=1' }, /^config\.baseUrl: /],
    ['jira', { baseUrl: 'not a url' }, /^config\.baseUrl: /],
    ['jira', { baseUrl: 'https://a.atlassian.net', jql: 7 }, /^config\.jql: /],
    ['jira', { baseUrl: 'https://a.atlassian.net', extra: true }, /^config: /],
    ['clickup', { teamId: '123' }, /^config: /],
    ['linear', { workspaceId: 'x' }, /^config: /],
    ['moodle', { siteUrl: 'ftp://moodle.example.ac.il' }, /^config\.siteUrl: /],
    ['google_calendar', {}, /^config\.calendars: /],
    [
      'google_calendar',
      { calendars: [{ id: 'primary', mode: 'push' }] },
      /^config\.calendars\.0\.mode: /,
    ],
    [
      'google_calendar',
      {
        calendars: [
          { id: 'primary', mode: 'read' },
          { id: 'primary', mode: 'two_way' },
        ],
      },
      /^config\.calendars: /,
    ],
    ['google_calendar', { calendars: [], horizonDays: 0 }, /^config\.horizonDays: /],
    ['google_calendar', { calendars: [], maxOpsPerRun: 10_000 }, /^config\.maxOpsPerRun: /],
    ['google_calendar', { calendars: [], pushFilter: { source: 'nope' } }, /^config\.pushFilter/],
    ['github', { owner: 'bad/owner', ownerType: 'user' }, /^config\.owner: /],
    ['github', { owner: '-dash', ownerType: 'user' }, /^config\.owner: /],
    ['github', { owner: 'shalev396', ownerType: 'team' }, /^config\.ownerType: /],
    ['github', { owner: 'shalev396', ownerType: 'user', repos: { all: true } }, /^config\.repos: /],
    [
      'github',
      { owner: 'shalev396', ownerType: 'user', boards: { include: [0] } },
      /^config\.boards\.include\.0: /,
    ],
    [
      'github',
      { owner: 'shalev396', ownerType: 'user', boards: { include: [' '] } },
      /^config\.boards\.include\.0: /,
    ],
    [
      'github',
      { owner: 'shalev396', ownerType: 'user', boards: { enabled: 'no' } },
      /^config\.boards\.enabled: /,
    ],
    // The adapter reads only these two kinds of involvement.
    [
      'github',
      { owner: 'shalev396', ownerType: 'user', issues: { involvement: ['mentioned'] } },
      /^config\.issues\.involvement\.0: /,
    ],
  ];
  for (const [provider, config, where] of refused) {
    it(`${provider} ${JSON.stringify(config)} → 400 ${where.source}`, () => {
      assert.throws(() => parseProviderConfig(provider, config), badRequest(where));
    });
  }

  it('GitHub boards: on or off, and picked by number or by title glob (as the adapter reads them)', () => {
    const config = parseProviderConfig('github', {
      owner: 'TLVTech',
      ownerType: 'org',
      boards: { enabled: false, include: [3, 'Sprint *'], dueField: 'Target date' },
    });
    assert.deepEqual(config['boards'], {
      enabled: false,
      include: [3, 'Sprint *'],
      dueField: 'Target date',
    });
  });

  it('a valid push filter (a builder query) is kept', () => {
    const pushFilter = {
      source: 'items',
      where: { combinator: 'and', rules: [{ field: 'status', operator: '=', value: 'open' }] },
    };
    const config = parseProviderConfig('google_calendar', {
      calendars: [{ id: 'primary', mode: 'two_way' }],
      targetCalendarId: 'primary',
      pushFilter,
      maxOpsPerRun: 50,
    });
    assert.deepEqual(config['pushFilter'], pushFilter);
  });

  it('config holds settings only: a secret-shaped value is refused, by its path and never echoed', () => {
    const token = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';
    assert.throws(
      () =>
        parseProviderConfig('jira', {
          baseUrl: 'https://autods.atlassian.net',
          jql: `text ~ "${token}"`,
        }),
      badRequest(/^config\.jql: /, token),
    );
  });
});

describe('provider site URLs are public https only (netGuard: SSRF)', () => {
  const refused: [ConnectableProvider, string, string][] = [
    ['jira', 'baseUrl', 'https://localhost'],
    ['jira', 'baseUrl', 'https://169.254.169.254'],
    ['jira', 'baseUrl', 'https://metadata.google.internal'],
    ['jira', 'baseUrl', 'https://10.0.0.8'],
    ['jira', 'baseUrl', 'https://2130706433'],
    ['jira', 'baseUrl', 'https://0x7f.0.0.1'],
    ['jira', 'baseUrl', 'https://127.1'],
    ['jira', 'baseUrl', 'https://[::ffff:7f00:1]'],
    ['jira', 'baseUrl', 'http://localhost:8080'],
    ['moodle', 'siteUrl', 'https://192.168.1.10/moodle'],
    ['moodle', 'siteUrl', 'https://[fd00::1]'],
    ['moodle', 'siteUrl', 'https://moodle'],
  ];
  for (const [provider, field, url] of refused) {
    it(`${provider}.${field} ${url} → 400 (never echoed)`, () => {
      const config = { [field]: url };
      assert.throws(
        () => parseProviderConfig(provider, config, { allowLocal: false }),
        badRequest(new RegExp(`^config\\.${field}: `), url),
      );
    });
  }

  it('a test (allowLocal) also takes a loopback site, but never a private one', () => {
    const local = planConnection(
      { provider: 'jira', config: { baseUrl: 'http://localhost:8080/' } },
      { allowLocal: true },
    );
    assert.deepEqual(
      [local.config['baseUrl'], local.accountId],
      ['http://localhost:8080', 'localhost:8080'],
    );
    assert.throws(
      () => parseProviderConfig('jira', { baseUrl: 'https://10.0.0.8' }, { allowLocal: true }),
      badRequest(/^config\.baseUrl: Must be a public host$/),
    );
  });
});

describe('request bodies (shape only)', () => {
  it('create: provider, config, optional label/topic/authMethod; strict; a secret-shaped label is refused', () => {
    assert.ok(CreateIntegrationBody.safeParse({ provider: 'linear', config: {} }).success);
    assert.ok(!CreateIntegrationBody.safeParse({ provider: 'slack', config: {} }).success);
    assert.ok(!CreateIntegrationBody.safeParse({ provider: 'local', config: {} }).success);
    assert.ok(!CreateIntegrationBody.safeParse({ provider: 'linear' }).success);
    assert.ok(
      !CreateIntegrationBody.safeParse({ provider: 'linear', config: {}, token: 'x' }).success,
    );
    assert.ok(
      !CreateIntegrationBody.safeParse({
        provider: 'linear',
        config: {},
        label: 'lin_api_FAKE0123456789abcdefghij',
      }).success,
    );
    assert.ok(
      !CreateIntegrationBody.safeParse({ provider: 'linear', config: {}, label: ' ' }).success,
    );
  });

  it('update: label, topic or config; at least one; never a secret or a status', () => {
    assert.ok(UpdateIntegrationBody.safeParse({ label: 'Renamed' }).success);
    assert.ok(UpdateIntegrationBody.safeParse({ topicId: 'college' }).success);
    assert.ok(UpdateIntegrationBody.safeParse({ config: {} }).success);
    assert.ok(!UpdateIntegrationBody.safeParse({}).success);
    assert.ok(!UpdateIntegrationBody.safeParse({ status: 'active' }).success);
    assert.ok(!UpdateIntegrationBody.safeParse({ token: 'x' }).success);
    assert.ok(!UpdateIntegrationBody.safeParse({ provider: 'jira' }).success);
  });
});

describe('assertSameAccount: a config change never moves the integration to another account', () => {
  const jira = {
    provider: 'jira' as const,
    accountId: 'autods.atlassian.net',
    config: { baseUrl: 'https://autods.atlassian.net' },
  };
  const github = {
    provider: 'github' as const,
    accountId: 'shalev396',
    config: { owner: 'Shalev396', ownerType: 'user' },
  };

  it('allows changes that keep the site, the owner and its type', () => {
    assertSameAccount(jira, { baseUrl: 'https://AUTODS.atlassian.net', jql: 'x' });
    assertSameAccount(github, { owner: 'shalev396', ownerType: 'user', issues: {} });
    assertSameAccount({ provider: 'linear', accountId: 'pending:x', config: {} }, {});
  });

  it('refuses another site, owner or owner type (400: connect a new integration instead)', () => {
    assert.throws(
      () => {
        assertSameAccount(jira, { baseUrl: 'https://other.atlassian.net' });
      },
      badRequest(/^config\.baseUrl: /),
    );
    assert.throws(
      () => {
        assertSameAccount(
          {
            provider: 'moodle',
            accountId: 'moodle.a.ac.il',
            config: { siteUrl: 'https://moodle.a.ac.il' },
          },
          { siteUrl: 'https://moodle.b.ac.il' },
        );
      },
      badRequest(/^config\.siteUrl: /),
    );
    assert.throws(
      () => {
        assertSameAccount(github, { owner: 'someone-else', ownerType: 'user' });
      },
      badRequest(/^config\.owner: /),
    );
    assert.throws(
      () => {
        assertSameAccount(github, { owner: 'Shalev396', ownerType: 'org' });
      },
      badRequest(/^config\.ownerType: /),
    );
  });
});

describe('parseCredential: the secret JSON per auth method (400 is one fixed message)', () => {
  const FIXED = /^Invalid credential for this provider$/;
  const PEM = '-----BEGIN FAKE PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END FAKE PRIVATE KEY-----';

  it('accepts each provider’s exact shape (strings trimmed)', () => {
    assert.deepEqual(
      parseCredential('api_token_basic', {
        email: ' dev@example.test ',
        token: 'ATATT3xFAKE0123456789',
      }),
      { email: 'dev@example.test', token: 'ATATT3xFAKE0123456789' },
    );
    assert.deepEqual(parseCredential('personal_token', { token: 'pk_12345678_FAKE0123456789' }), {
      token: 'pk_12345678_FAKE0123456789',
    });
    assert.deepEqual(
      parseCredential('personal_api_key', { apiKey: 'lin_api_FAKE0123456789abcd' }),
      {
        apiKey: 'lin_api_FAKE0123456789abcd',
      },
    );
    assert.deepEqual(parseCredential('moodle_ws_token', { token: 'FAKEmoodle0123456789' }), {
      token: 'FAKEmoodle0123456789',
    });
    assert.deepEqual(
      parseCredential('service_account', {
        clientEmail: 'sa@fake.iam.gserviceaccount.com',
        privateKey: PEM,
      }),
      { clientEmail: 'sa@fake.iam.gserviceaccount.com', privateKey: PEM },
    );
    assert.deepEqual(
      parseCredential('fine_grained_pat', { token: 'github_pat_FAKE0123456789abcdefghij' }),
      {
        token: 'github_pat_FAKE0123456789abcdefghij',
      },
    );
    assert.deepEqual(
      Object.keys(
        parseCredential('fine_grained_pat', {
          token: 'github_pat_FAKE0123456789abcdefghij',
          projectsToken: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123',
        }),
      ),
      ['token', 'projectsToken'],
    );
  });

  const refused: [string, unknown][] = [
    ['api_token_basic', { email: 'dev@example.test' }],
    ['api_token_basic', { email: 'not-an-email', token: 'ATATT3xFAKE0123456789' }],
    ['api_token_basic', { email: 'dev@example.test', token: '' }],
    ['api_token_basic', { email: 'dev@example.test', token: 'ATATT3x FAKE' }],
    ['api_token_basic', { email: 'dev@example.test', token: 42 }],
    ['api_token_basic', { email: 'dev@example.test', token: 'ATATT3xFAKE0123456789', extra: 'x' }],
    ['api_token_basic', { apiKey: 'lin_api_FAKE0123456789abcd' }],
    ['personal_token', {}],
    ['personal_api_key', { token: 'lin_api_FAKE0123456789abcd' }],
    [
      'service_account',
      { clientEmail: 'sa@fake.iam.gserviceaccount.com', privateKey: 'FAKE-not-a-pem' },
    ],
    ['fine_grained_pat', { token: 'github_pat_FAKE0123456789abcdefghij', projectsToken: '' }],
    ['none', { token: 'FAKE0123456789' }],
    ['classic_pat', { token: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123' }],
    ['api_token_basic', null],
    ['api_token_basic', ['ATATT3xFAKE0123456789']],
    ['api_token_basic', 'ATATT3xFAKE0123456789'],
  ];
  for (const [authMethod, body] of refused) {
    it(`${authMethod}: refuses ${Array.isArray(body) ? 'an array' : typeof body === 'object' && body !== null ? Object.keys(body).join('+') || '{}' : String(body)} without echoing it`, () => {
      const values = JSON.stringify(body).match(/[A-Za-z0-9_.@:/-]{6,}/g) ?? [];
      assert.throws(
        () => parseCredential(authMethod as Parameters<typeof parseCredential>[0], body),
        badRequest(FIXED, ...values),
      );
    });
  }
});

describe('URLs are stored normalized: what was checked is what the server calls', () => {
  it('site URLs (Jira baseUrl, Moodle siteUrl) are stored as origin + path, normalized alike', () => {
    const jira: [string, string][] = [
      ['https://autods.atlassian.net/x/../', 'https://autods.atlassian.net'],
      ['https://autods.atlassian.net/?', 'https://autods.atlassian.net'],
      ['https://autods.atlassian.net/#', 'https://autods.atlassian.net'],
      ['https://AutoDS.Atlassian.NET', 'https://autods.atlassian.net'],
      ['HTTPS://AUTODS.ATLASSIAN.NET:443/jira/./', 'https://autods.atlassian.net/jira'],
    ];
    for (const [baseUrl, expected] of jira) {
      const config = parseProviderConfig('jira', { baseUrl }, { allowLocal: false });
      assert.equal(config['baseUrl'], expected, baseUrl);
    }
    const moodle = parseProviderConfig(
      'moodle',
      { siteUrl: 'https://Moodle.Braude.AC.IL/x/../moodle/?#' },
      { allowLocal: false },
    );
    assert.equal(moodle['siteUrl'], 'https://moodle.braude.ac.il/moodle');
  });
});
