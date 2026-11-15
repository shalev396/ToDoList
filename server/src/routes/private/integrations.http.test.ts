/**
 * Integrations over HTTP (BACKEND.md §4, DATA.md §0, §4, §7), in fixtures mode (forceSyncModeForTests)
 * with the tests' credentials key: connect, the write-only credential, test connection, edit and
 * disconnect. An integration is only ever shown as its 6 status keys, and no response, log line or
 * database document ever holds a secret in plaintext.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import { getAdapter, registerAdapter, unregisterAdapter } from '../../sync/registry.js';
import type { ConnectionTestResult, ProviderAdapter } from '../../sync/types.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { createFakeAdapter } from '../../testing/fakeAdapter.js';
import type { Provider } from '../../types/domain.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

type Who = 'owner' | 'editor' | 'viewer' | 'viewer2';

const JIRA = { email: 'jira-account@example.test', token: 'ATATT3xFAKE0123456789abcdefghij' };
const LINEAR = { apiKey: 'lin_api_FAKE0123456789abcdefghij' };
const GITHUB = {
  token: 'github_pat_FAKE0123456789abcdefghij_KLMNOP',
  projectsToken: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123',
};
const SERVICE_ACCOUNT = {
  clientEmail: 'sync@fake-project.iam.gserviceaccount.com',
  privateKey: '-----BEGIN FAKE PRIVATE KEY-----\nFAKE0123456789\n-----END FAKE PRIVATE KEY-----',
};
/** Every value a test sends as a secret none may come back or be logged. */
const SECRET_VALUES = [JIRA, LINEAR, GITHUB, SERVICE_ACCOUNT]
  .flatMap((secret) => Object.values(secret))
  .filter((value) => value.length >= 8);

const STATUS_KEYS = [
  'accountLabel',
  'authMethod',
  'expiresAt',
  'id',
  'lastSyncAt',
  'mode',
  'provider',
  'status',
];

let api: ApiHarness;
let models: typeof Models;
const tokens = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;
let workspaces = 0;

/** What the linear test adapter answers, and what it saw. */
let nextLabel = 'Fake Account';
const testCalls: { secretKeys: string[] }[] = [];
const originals = new Map<Provider, ProviderAdapter | null>();
/** Runs inside a test adapter's connection test, before it answers: a change that lands meanwhile. */
let duringTest: (() => Promise<void>) | null = null;

/** The fake adapter (fixtures in testing/fixtures/fake) as `provider`, with a connection test. */
function linearTestAdapter(): ProviderAdapter {
  const { adapter } = createFakeAdapter();
  return {
    ...adapter,
    provider: 'linear',
    async test(ctx): Promise<ConnectionTestResult> {
      testCalls.push({ secretKeys: Object.keys(ctx.secret) });
      const data = await ctx.client.graphql<{ projects: unknown[] }>(
        'FakeProjects',
        { first: 50 },
        {},
      );
      await duringTest?.();
      return {
        accountLabel: nextLabel,
        // A capability that isn't a boolean is dropped from the answer.
        capabilities: { projects: data.projects.length > 0, junk: 'yes' } as unknown as Record<
          string,
          boolean
        >,
      };
    },
  };
}

/** What the GitHub test adapter reports the token can read. */
let githubCapabilities: Record<string, boolean> = { repos: true, boards: true };

/** A GitHub stand-in: the account is the configured owner; capabilities as set above. */
function githubTestAdapter(): ProviderAdapter {
  const { adapter } = createFakeAdapter();
  return {
    ...adapter,
    provider: 'github',
    async test(ctx): Promise<ConnectionTestResult> {
      await ctx.client.graphql('FakeProjects', { first: 50 }, {});
      await duringTest?.();
      const owner = ctx.integration.config['owner'];
      const login = typeof owner === 'string' ? owner : 'unknown';
      return {
        accountLabel: login,
        accountId: login.toLowerCase(),
        capabilities: githubCapabilities,
      };
    },
  };
}

function useAdapter(adapter: ProviderAdapter): void {
  originals.set(adapter.provider, getAdapter(adapter.provider));
  unregisterAdapter(adapter.provider);
  registerAdapter(adapter);
}

before(async () => {
  api = await startApiHarness('todolist_integrations_http');
  models = await import('../../models/index.js');
  for (const who of ['owner', 'editor', 'viewer', 'viewer2'] as const) {
    tokens[who] = (await api.login(`int-${who}@example.test`)).token;
    const me = await api.call('GET', '/api/private/me', { token: tokens[who] });
    ids[who] = (me.body?.['data'] as { id: string }).id;
  }
  useAdapter(linearTestAdapter());
  useAdapter(githubTestAdapter());
  // ClickUp: an adapter without a connection test.
  useAdapter({ ...createFakeAdapter().adapter, provider: 'clickup' });
});

after(async () => {
  for (const [provider, adapter] of originals) {
    unregisterAdapter(provider);
    if (adapter !== null) registerAdapter(adapter);
  }
  await api.stop();
});

/** A fresh workspace: owner, editor and two viewers. */
async function newWorkspace(): Promise<string> {
  workspaces += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({
    name: 'Integrations',
    slug: `integrations-${String(workspaces)}`,
    ownerId: ids.owner,
  });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: ids.owner, role: 'owner' });
  await memberships.create(workspace.id, { userId: ids.editor, role: 'editor' });
  await memberships.create(workspace.id, { userId: ids.viewer, role: 'viewer' });
  await memberships.create(workspace.id, { userId: ids.viewer2, role: 'viewer' });
  // As every workspace has them since the topics migration.
  const { ensureDefaultTopics } = await import('../../services/topics.js');
  await ensureDefaultTopics(workspace.id, ['work', 'college', 'personal'], 'en');
  return workspace.id;
}

/** A default topic's id in a test workspace. */
async function topicOf(wid: string, slug: 'work' | 'college' | 'personal'): Promise<string> {
  const { defaultTopicId } = await import('../../services/topics.js');
  return defaultTopicId(wid, slug);
}

const path = (wid: string, rest = ''): string =>
  `/api/private/workspaces/${wid}/integrations${rest}`;

function dataOf(res: ApiResponse): unknown {
  return res.body?.['data'];
}

function statusOf(res: ApiResponse): StatusView {
  return dataOf(res) as StatusView;
}

function statusList(res: ApiResponse): StatusView[] {
  return dataOf(res) as StatusView[];
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  who: Who = 'owner',
): Promise<ApiResponse> {
  return api.call(method, url, { token: tokens[who], ...(body === undefined ? {} : { body }) });
}

interface StatusView {
  id: string;
  provider: string;
  accountLabel: string;
  status: string;
  expiresAt: string | null;
  lastSyncAt: string | null;
}

async function connect(wid: string, body: Record<string, unknown>): Promise<StatusView> {
  const res = await call('POST', path(wid), body);
  assert.equal(res.status, 201, res.text);
  return statusOf(res);
}

const JIRA_BODY = { provider: 'jira', config: { baseUrl: 'https://autods.atlassian.net' } };
const LINEAR_BODY = { provider: 'linear', config: {} };

/** What the server logged (stderr) while `fn` ran: captured, not printed. */
async function logsDuring(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function assertNoSecret(where: string, text: string): void {
  for (const value of SECRET_VALUES) {
    assert.ok(!text.includes(value), `${where} holds a secret value`);
  }
}

/** Every document of every collection, as JSON: the "no plaintext at rest" check. */
async function databaseText(): Promise<string> {
  const mongoose = (await import('mongoose')).default;
  const db = mongoose.connection.db;
  assert.ok(db);
  const docs: unknown[] = [];
  for (const collection of await db.collections()) {
    docs.push(...(await collection.find({}).toArray()));
  }
  return JSON.stringify(docs);
}

async function integrationDoc(wid: string, iid: string): Promise<Models.IntegrationData | null> {
  return (await models.getIntegrationRepository()).findById(wid, iid);
}

async function credentialOf(wid: string, iid: string): Promise<Models.CredentialData | null> {
  return (await models.getCredentialRepository()).findMeta(wid, iid);
}

async function auditActions(wid: string): Promise<{ action: string; meta: unknown }[]> {
  const entries = await (await models.getAuditLogRepository()).list(wid, {}, 100);
  return entries.reverse().map(({ action, meta }) => ({ action, meta }));
}

// ─── GET ───────────────────────────────────────────────────────────────────

describe('GET /workspaces/:wid/integrations', () => {
  it('lists the caller’s own integrations only, oldest first, with exactly the status keys', async () => {
    const wid = await newWorkspace();
    const jira = await connect(wid, JIRA_BODY);
    const clickup = await connect(wid, { provider: 'clickup', config: {} });
    const mine = await call('GET', path(wid));
    assert.equal(mine.status, 200, mine.text);
    const list = statusList(mine);
    assert.deepEqual(
      list.map((view) => view.id),
      [jira.id, clickup.id],
    );
    for (const view of list) assert.deepEqual(Object.keys(view).sort(), STATUS_KEYS);
    // On no block yet: private to its owner.
    const sharing = await call('GET', `${path(wid)}/sharing`);
    assert.equal(sharing.status, 200, sharing.text);
    assert.deepEqual(sharing.body?.['data'], { shared: [] });
    // PERMISSIONS-V2 ruling 1: other members never get another member's integrations here.
    for (const who of ['editor', 'viewer', 'viewer2'] as const) {
      const res = await call('GET', path(wid), undefined, who);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(statusList(res), [], who);
    }
  });

  it('an editor’s own integration is theirs alone: the workspace owner does not list it', async () => {
    const wid = await newWorkspace();
    const created = await call('POST', path(wid), JIRA_BODY, 'editor');
    assert.equal(created.status, 201, created.text);
    const id = statusOf(created).id;
    const editors = statusList(await call('GET', path(wid), undefined, 'editor'));
    assert.deepEqual(
      editors.map((view) => view.id),
      [id],
    );
    assert.deepEqual(statusList(await call('GET', path(wid))), []);
    const stored = await integrationDoc(wid, id);
    assert.equal(stored?.ownerUserId, stored?.connectedBy);
  });
});

// ─── POST ──────────────────────────────────────────────────────────────────

describe('POST /workspaces/:wid/integrations', () => {
  it('connects with the provider’s defaults: 201 with the 6 keys only, audited', async () => {
    const wid = await newWorkspace();
    const view = await connect(wid, {
      provider: 'jira',
      config: { baseUrl: 'https://AutoDS.atlassian.net/', jql: 'assignee = currentUser()' },
    });
    assert.deepEqual(Object.keys(view).sort(), STATUS_KEYS);
    // No credential yet: it is not connected until one is saved.
    assert.deepEqual(
      [view.provider, view.accountLabel, view.status, view.expiresAt, view.lastSyncAt],
      ['jira', 'autods.atlassian.net', 'error', null, null],
    );
    const stored = await integrationDoc(wid, view.id);
    assert.ok(stored);
    // The provider's default topic: the workspace's Work topic.
    const work = await topicOf(wid, 'work');
    assert.deepEqual(
      [stored.accountId, stored.authMethod, stored.topicId, stored.mode, stored.connectedBy],
      ['autods.atlassian.net', 'api_token_basic', work, 'read', ids.owner],
    );
    assert.deepEqual(stored.config, {
      baseUrl: 'https://autods.atlassian.net',
      jql: 'assignee = currentUser()',
    });
    assert.equal(stored.credentialId, null);
    // R5: no credential yet, and the integration says so.
    assert.deepEqual(
      [stored.status, stored.lastError],
      [
        'error',
        { code: 'credential_missing', message: 'Save the credential to finish connecting' },
      ],
    );
    assert.deepEqual(await auditActions(wid), [
      {
        action: 'integration.create',
        meta: { provider: 'jira', topicId: work, authMethod: 'api_token_basic' },
      },
    ]);
  });

  it('takes a label and a topic', async () => {
    const wid = await newWorkspace();
    const college = await topicOf(wid, 'college');
    const view = await connect(wid, {
      provider: 'clickup',
      label: 'My ClickUp',
      topicId: college,
      config: {},
    });
    const stored = await integrationDoc(wid, view.id);
    assert.deepEqual(
      [view.accountLabel, stored?.topicId, stored?.authMethod, stored?.mode],
      ['My ClickUp', college, 'personal_token', 'read'],
    );
    assert.match(stored?.accountId ?? '', /^pending:/);
  });

  it('refuses Moodle as coming soon (400 provider_coming_soon) and creates nothing', async () => {
    const wid = await newWorkspace();
    const res = await call('POST', path(wid), {
      provider: 'moodle',
      config: { siteUrl: 'https://moodle.example.ac.il' },
    });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body?.['code'], 'provider_coming_soon');
    assert.deepEqual(statusList(await call('GET', path(wid))), []);
  });

  it('refuses Google Calendar here (it connects with Google sign-in) and creates nothing', async () => {
    const wid = await newWorkspace();
    const res = await call('POST', path(wid), {
      provider: 'google_calendar',
      authMethod: 'service_account',
      config: { calendars: [{ id: 'primary', mode: 'read' }] },
    });
    assert.equal(res.status, 400, res.text);
    assert.deepEqual(statusList(await call('GET', path(wid))), []);
  });

  const refused: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown provider', { provider: 'slack', config: {} }, /^provider: /],
    ['a missing config', { provider: 'linear' }, /^config: /],
    ['a key the API doesn’t take', { ...LINEAR_BODY, token: 'x' }, /Unrecognized key/],
    [
      'an http Jira site',
      { provider: 'jira', config: { baseUrl: 'http://a.b' } },
      /^config\.baseUrl: /,
    ],
    // SSRF: refused even where a test admits loopback (never a private address).
    [
      'the cloud metadata address as the Jira site',
      { provider: 'jira', config: { baseUrl: 'https://169.254.169.254' } },
      /^config\.baseUrl: Must be a public host$/,
    ],
    [
      'a private Jira site spelled as one number (10.0.0.1)',
      { provider: 'jira', config: { baseUrl: 'https://167772161' } },
      /^config\.baseUrl: Must be a public host$/,
    ],
    [
      'a Jira site on an IPv4-mapped loopback address',
      { provider: 'jira', config: { baseUrl: 'https://[::ffff:127.0.0.1]' } },
      /^config\.baseUrl: Must be a public host$/,
    ],
    [
      'an internal Jira name',
      { provider: 'jira', config: { baseUrl: 'https://jira.corp.internal' } },
      /^config\.baseUrl: Must be a public host$/,
    ],
    ['a ClickUp setting', { provider: 'clickup', config: { teamId: '1' } }, /^config: /],
    [
      'a secret in the config',
      { provider: 'jira', config: { baseUrl: 'https://a.atlassian.net', jql: JIRA.token } },
      /^config\.jql: settings only/,
    ],
    ['a secret as the label', { ...LINEAR_BODY, label: LINEAR.apiKey }, /^label: /],
    [
      'an auth method the provider lacks',
      { ...LINEAR_BODY, authMethod: 'personal_token' },
      /^authMethod: /,
    ],
  ];
  for (const [what, body, message] of refused) {
    it(`refuses ${what} (400) and creates nothing`, async () => {
      const wid = await newWorkspace();
      const logs = await logsDuring(async () => {
        const res = await call('POST', path(wid), body);
        assert.equal(res.status, 400, res.text);
        assert.match(String(res.body?.['message']), message);
        assertNoSecret('the answer', res.text);
      });
      assertNoSecret('the logs', logs);
      assert.deepEqual(await (await models.getIntegrationRepository()).list(wid), []);
    });
  }

  it('many-to-one: two Jira sites both connect, and two token providers each take a second one', async () => {
    const wid = await newWorkspace();
    const first = await connect(wid, JIRA_BODY);
    const second = await connect(wid, {
      provider: 'jira',
      config: { baseUrl: 'https://other-site.atlassian.net' },
    });
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.accountLabel, second.accountLabel);
    await connect(wid, LINEAR_BODY);
    await connect(wid, LINEAR_BODY);
    const listed = await (await models.getIntegrationRepository()).list(wid);
    assert.equal(listed.filter((entry) => entry.provider === 'jira').length, 2);
    assert.equal(listed.filter((entry) => entry.provider === 'linear').length, 2);
  });

  it('the same Jira site twice by one member → 409 that names the account', async () => {
    const wid = await newWorkspace();
    await connect(wid, JIRA_BODY);
    const again = await call('POST', path(wid), JIRA_BODY);
    assert.equal(again.status, 409, again.text);
    assert.match(again.text, /account_already_connected/);
    assert.match(again.text, /already connected this jira account \(autods\.atlassian\.net\)/i);
  });

  it('the same Jira site by two members: each gets their own integration (ruling 8)', async () => {
    const wid = await newWorkspace();
    const mine = await connect(wid, JIRA_BODY);
    const theirs = await call('POST', path(wid), JIRA_BODY, 'editor');
    assert.equal(theirs.status, 201, theirs.text);
    assert.notEqual(statusOf(theirs).id, mine.id);
    const stored = await (await models.getIntegrationRepository()).list(wid);
    assert.equal(stored.filter((entry) => entry.provider === 'jira').length, 2);
  });

  it('the same account twice → 409', async () => {
    const wid = await newWorkspace();
    await connect(wid, JIRA_BODY);
    const again = await call('POST', path(wid), {
      provider: 'jira',
      config: { baseUrl: 'https://AUTODS.atlassian.net' },
    });
    assert.equal(again.status, 409, again.text);
    assert.equal((await (await models.getIntegrationRepository()).list(wid)).length, 1);
  });

  /** `count` Jira integrations owned by `ownerUserId`, straight into the repository. */
  async function fill(wid: string, ownerUserId: string, count: number, from = 0): Promise<void> {
    const integrations = await models.getIntegrationRepository();
    for (let n = from; n < from + count; n += 1) {
      await integrations.create(wid, {
        connectedBy: ownerUserId,
        provider: 'jira',
        accountId: `site-${String(n)}.atlassian.net`,
        label: `Jira ${String(n)}`,
        authMethod: 'api_token_basic',
        topicId: 'work',
      });
    }
  }

  it('at the cap of a member’s own integrations (20) → 409; another member still connects', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const wid = await newWorkspace();
    await fill(wid, ids.owner, LIMITS.integrationsPerUserPerWorkspace);
    const res = await call('POST', path(wid), LINEAR_BODY);
    assert.equal(res.status, 409, res.text);
    assert.match(String(res.body?.['message']), /You can connect at most 20 integrations/);
    const editors = await call('POST', path(wid), LINEAR_BODY, 'editor');
    assert.equal(editors.status, 201, editors.text);
  });

  it('at the cap of integrations per workspace (100, every member’s) → 409', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const wid = await newWorkspace();
    // Many members' worth: the repository does not check caps, only the routes do.
    const perMember = LIMITS.integrationsPerUserPerWorkspace;
    for (let n = 0; n * perMember < LIMITS.integrationsPerWorkspace; n += 1) {
      await fill(wid, `user-${String(n)}`, perMember, n * perMember);
    }
    const res = await call('POST', path(wid), LINEAR_BODY, 'editor');
    assert.equal(res.status, 409, res.text);
    assert.match(String(res.body?.['message']), /A workspace can have at most 100 integrations/);
    const integrations = await models.getIntegrationRepository();
    assert.equal((await integrations.list(wid)).length, LIMITS.integrationsPerWorkspace);
  });

  /** `count` creates fired at once: each answers 201 or 409, never more. */
  async function race(wid: string, count: number, role: 'owner' | 'editor'): Promise<number> {
    const answers = await Promise.all(
      Array.from({ length: count }, () => call('POST', path(wid), LINEAR_BODY, role)),
    );
    for (const res of answers) assert.ok([201, 409].includes(res.status), res.text);
    return answers.filter((res) => res.status === 201).length;
  }

  it('25 connects at once, 5 short of a member’s cap: the cap holds (insert, then count again)', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const wid = await newWorkspace();
    const room = 5;
    await fill(wid, ids.owner, LIMITS.integrationsPerUserPerWorkspace - room);
    // Linear accounts start as `pending:` placeholders: the unique index never stops a racer.
    const created = await race(wid, 25, 'owner');
    assert.ok(created <= room, `${String(created)} created with room for ${String(room)}`);
    const integrations = await models.getIntegrationRepository();
    assert.equal(
      await integrations.countActiveForOwner(wid, ids.owner),
      LIMITS.integrationsPerUserPerWorkspace - room + created,
    );
  });

  it('25 connects at once, 3 short of the workspace cap: it holds too', async () => {
    const { LIMITS } = await import('../../config/limits.js');
    const wid = await newWorkspace();
    const perMember = LIMITS.integrationsPerUserPerWorkspace;
    const room = 3;
    let filled = 0;
    for (let n = 0; filled < LIMITS.integrationsPerWorkspace - room; n += 1) {
      const count = Math.min(perMember, LIMITS.integrationsPerWorkspace - room - filled);
      await fill(wid, `user-${String(n)}`, count, filled);
      filled += count;
    }
    const created = await race(wid, 25, 'editor');
    assert.ok(created <= room, `${String(created)} created with room for ${String(room)}`);
    const integrations = await models.getIntegrationRepository();
    assert.equal(await integrations.countActive(wid), filled + created);
  });

  /** The workspace's topic rules, matches compared in lower case. */
  async function ruleList(wid: string): Promise<[string, string][]> {
    const workspace = await (await models.getWorkspaceRepository()).findById(wid);
    return (workspace?.settings.topicRules ?? []).map(({ match, topicId }) => [
      match.toLowerCase(),
      topicId,
    ]);
  }

  it('a GitHub user owner adds "<login>/*" → personal to the topic rules, once, in any case', async () => {
    const wid = await newWorkspace();
    const user = await connect(wid, {
      provider: 'github',
      config: { owner: 'Shalev396', ownerType: 'user' },
    });
    const personal = await topicOf(wid, 'personal');
    assert.deepEqual(await ruleList(wid), [['shalev396/*', personal]]);
    const stored = await integrationDoc(wid, user.id);
    assert.deepEqual([stored?.topicId, stored?.accountId], [personal, 'shalev396']);

    // Disconnected and connected again (another case): the rule is already there.
    assert.equal((await call('DELETE', path(wid, `/${user.id}`))).status, 204);
    await connect(wid, { provider: 'github', config: { owner: 'SHALEV396', ownerType: 'user' } });
    assert.deepEqual(await ruleList(wid), [['shalev396/*', personal]]);
  });

  it('the rule is stored lower case, and two connects racing a settings PATCH lose nothing', async () => {
    const wid = await newWorkspace();
    const results = await Promise.all([
      call('POST', path(wid), {
        provider: 'github',
        config: { owner: 'Alpha-Dev', ownerType: 'user' },
      }),
      call('POST', path(wid), {
        provider: 'github',
        config: { owner: 'BetaDev', ownerType: 'user' },
      }),
      api.call('PATCH', `/api/private/workspaces/${wid}`, {
        token: tokens.owner,
        body: { settings: { weekStart: 'mon' } },
      }),
    ]);
    assert.deepEqual(
      results.map((res) => res.status),
      [201, 201, 200],
    );
    const workspace = await (await models.getWorkspaceRepository()).findById(wid);
    assert.ok(workspace);
    assert.equal(workspace.settings.weekStart, 'mon');
    const personal = await topicOf(wid, 'personal');
    assert.deepEqual(
      workspace.settings.topicRules.map(({ match, topicId }) => [match, topicId]).sort(),
      [
        ['alpha-dev/*', personal],
        ['betadev/*', personal],
      ],
    );
  });

  it('a GitHub organization owner never adds a topic rule (its repos are work)', async () => {
    const wid = await newWorkspace();
    const workspace = await connect(wid, {
      provider: 'github',
      config: { owner: 'TLVTech', ownerType: 'org' },
    });
    await connect(wid, { provider: 'github', config: { owner: 'Other-Org', ownerType: 'org' } });
    assert.deepEqual(await ruleList(wid), []);
    assert.equal((await integrationDoc(wid, workspace.id))?.topicId, await topicOf(wid, 'work'));
    const audit = await auditActions(wid);
    assert.ok(
      audit.every(({ meta }) => !Object.hasOwn(meta as object, 'areaRule')),
      'no topic rule audited',
    );
  });
});

// ─── PUT …/credential ──────────────────────────────────────────────────────

describe('PUT /workspaces/:wid/integrations/:iid/credential (write-only)', () => {
  it('204 with an empty body; sealed at rest; the integration is connected; audited without secrets', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    const logs = await logsDuring(async () => {
      const res = await call('PUT', path(wid, `/${id}/credential`), JIRA);
      assert.equal(res.status, 204, res.text);
      assert.equal(res.text, '');
    });
    assertNoSecret('the logs', logs);

    const credential = await credentialOf(wid, id);
    assert.ok(credential);
    assert.deepEqual([credential.kind, credential.ownerUserId], ['api_token_basic', ids.owner]);
    const stored = await integrationDoc(wid, id);
    assert.deepEqual(
      [stored?.credentialId, stored?.status, stored?.lastError],
      [credential.id, 'active', null],
    );
    const { CredentialMongoModel } = await import('../../models/mongoose/Credential.js');
    const raw = await CredentialMongoModel.findOne({ integrationId: id }).select('+enc').lean();
    assert.ok(raw?.enc.ciphertext !== undefined && raw.enc.ciphertext !== '');
    assertNoSecret('the database', await databaseText());

    const list = await call('GET', path(wid));
    assert.equal(statusList(list)[0]?.status, 'connected');
    assertNoSecret('GET /integrations', list.text);
    assert.deepEqual(
      (await auditActions(wid)).map(({ action }) => action),
      ['integration.create', 'integration.connect'],
    );
  });

  it('a rotation clears expiresAt in the same update; the first credential keeps it', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    assert.equal(
      (await call('PATCH', path(wid, `/${id}`), { expiresAt: '2027-11-01' })).status,
      200,
    );
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), JIRA)).status, 204);
    assert.deepEqual(
      (await integrationDoc(wid, id))?.expiresAt,
      new Date('2027-11-01T00:00:00Z'),
      'the first credential keeps the expiry set for it',
    );

    const integrations = await models.getIntegrationRepository();
    const realUpdate = integrations.update.bind(integrations);
    const patches: unknown[] = [];
    integrations.update = (
      workspaceId,
      integrationId,
      patch,
    ): Promise<Models.IntegrationData | null> => {
      patches.push(patch);
      return realUpdate(workspaceId, integrationId, patch);
    };
    try {
      const rotated = { ...JIRA, token: 'ATATT3xFAKE-rotated-0123456789abcdef' };
      assert.equal((await call('PUT', path(wid, `/${id}/credential`), rotated)).status, 204);
    } finally {
      integrations.update = realUpdate;
    }
    assert.equal((await integrationDoc(wid, id))?.expiresAt, null);
    assert.deepEqual(patches, [{ status: 'active', lastError: null, expiresAt: null }]);
  });

  it('saving again rotates it and brings back a paused, expired or failing integration', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, {
      provider: 'github',
      config: { owner: 'octo', ownerType: 'org' },
    });
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), GITHUB)).status, 204);
    const integrations = await models.getIntegrationRepository();
    const states = await models.getSyncStateRepository();
    for (const status of ['paused', 'expired', 'error'] as const) {
      await integrations.update(wid, id, {
        status,
        lastError: { code: 'auth_failed', message: 'Reconnect required' },
      });
      await states.upsert(wid, id, '__run__', { consecutiveErrors: 2 });
      const res = await call('PUT', path(wid, `/${id}/credential`), { token: GITHUB.token });
      assert.equal(res.status, 204, res.text);
      const stored = await integrationDoc(wid, id);
      assert.deepEqual([stored?.status, stored?.lastError], ['active', null]);
      assert.equal((await states.get(wid, id, '__run__'))?.consecutiveErrors, 0);
    }
    assert.ok((await credentialOf(wid, id))?.rotatedAt instanceof Date);
    assert.deepEqual(
      (await auditActions(wid)).map(({ action }) => action),
      [
        'integration.create',
        'integration.connect',
        'credential.rotate',
        'credential.rotate',
        'credential.rotate',
      ],
    );
    assertNoSecret('the database', await databaseText());
  });

  it('every shape the providers expect is accepted', async () => {
    const wid = await newWorkspace();
    const cases: [Record<string, unknown>, Record<string, string>][] = [
      [JIRA_BODY, JIRA],
      [LINEAR_BODY, LINEAR],
      [{ provider: 'clickup', config: {} }, { token: 'pk_12345678_FAKE0123456789ABCDEFGHIJ' }],
      [{ provider: 'github', config: { owner: 'octo', ownerType: 'org' } }, GITHUB],
    ];
    for (const [body, secret] of cases) {
      const { id } = await connect(wid, body);
      const res = await call('PUT', path(wid, `/${id}/credential`), secret);
      assert.equal(res.status, 204, `${String(body['provider'])}: ${res.text}`);
    }
    assertNoSecret('the database', await databaseText());
  });

  const INVALID = 'Invalid request body';
  const bad: [string, unknown, string][] = [
    ['a missing field', { email: JIRA.email }, INVALID],
    ['an unknown field', { ...JIRA, note: 'hello there' }, INVALID],
    ['a number', { email: JIRA.email, token: 12345678 }, INVALID],
    ['an empty token', { email: JIRA.email, token: '' }, INVALID],
    ['another provider’s shape', LINEAR, INVALID],
    ['an array', [JIRA.token], INVALID],
    // Express's strict JSON parser refuses a bare string before the route (its own fixed text).
    ['a string', JIRA.token, 'Malformed JSON body'],
  ];
  for (const [what, body, message] of bad) {
    it(`${what} → 400 with one fixed message; nothing stored, echoed or logged`, async () => {
      const wid = await newWorkspace();
      const { id } = await connect(wid, JIRA_BODY);
      const logs = await logsDuring(async () => {
        const res = await call('PUT', path(wid, `/${id}/credential`), body);
        assert.equal(res.status, 400, res.text);
        assert.deepEqual(res.body, { message });
      });
      assertNoSecret('the logs', logs);
      assert.equal(await credentialOf(wid, id), null);
      assert.equal((await integrationDoc(wid, id))?.status, 'error');
    });
  }

  it('an unknown or deleted integration → 404, and nothing is stored', async () => {
    const wid = await newWorkspace();
    const res = await call('PUT', path(wid, '/no-such-integration/credential'), JIRA);
    assert.deepEqual([res.status, res.body], [404, { message: 'Not found' }]);
    assertNoSecret('the database', await databaseText());
  });
});

// ─── POST …/test (fixtures mode) ───────────────────────────────────────────

describe('POST /workspaces/:wid/integrations/:iid/test (fixtures mode)', () => {
  it('replays fixtures and never decrypts; replaces the placeholder account and the default label', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, LINEAR_BODY);
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), LINEAR)).status, 204);
    nextLabel = 'Fake Account';
    testCalls.length = 0;
    const res = await call('POST', path(wid, `/${id}/test`));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(dataOf(res), {
      ok: true,
      accountLabel: 'Fake Account',
      capabilities: { projects: true },
    });
    assert.deepEqual(testCalls, [{ secretKeys: [] }], 'the adapter got no secret');
    assert.equal((await credentialOf(wid, id))?.lastUsedAt, null, 'the vault was never used');
    const stored = await integrationDoc(wid, id);
    assert.deepEqual([stored?.accountId, stored?.label], ['Fake Account', 'Fake Account']);
  });

  it('keeps a label the owner chose, and needs no credential in fixtures mode', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, { ...LINEAR_BODY, label: 'Team Linear' });
    nextLabel = 'Linear Workspace';
    const res = await call('POST', path(wid, `/${id}/test`));
    assert.deepEqual(dataOf(res), {
      ok: true,
      accountLabel: 'Linear Workspace',
      capabilities: { projects: true },
    });
    const stored = await integrationDoc(wid, id);
    assert.deepEqual([stored?.accountId, stored?.label], ['Linear Workspace', 'Team Linear']);
  });

  it('GitHub: a token that can’t read boards turns them off in the config; one that can, back on', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, {
      provider: 'github',
      config: { owner: 'TLVTech', ownerType: 'org', boards: { include: [3], dueField: 'Due' } },
    });
    const boards = async (): Promise<unknown> => (await integrationDoc(wid, id))?.config['boards'];
    try {
      githubCapabilities = { repos: true, boards: false };
      assert.deepEqual(dataOf(await call('POST', path(wid, `/${id}/test`))), {
        ok: true,
        accountLabel: 'TLVTech',
        capabilities: { repos: true, boards: false },
      });
      assert.deepEqual(await boards(), { include: [3], dueField: 'Due', enabled: false });

      githubCapabilities = { repos: true, boards: true };
      assert.equal((await call('POST', path(wid, `/${id}/test`))).status, 200);
      assert.deepEqual(await boards(), { include: [3], dueField: 'Due', enabled: true });

      // An answer without a boards capability leaves the setting as it is.
      githubCapabilities = { repos: true };
      assert.equal((await call('POST', path(wid, `/${id}/test`))).status, 200);
      assert.deepEqual(await boards(), { include: [3], dueField: 'Due', enabled: true });
    } finally {
      githubCapabilities = { repos: true, boards: true };
    }
  });

  it('GitHub: boards are turned off on an integration whose config had no boards section', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, {
      provider: 'github',
      config: { owner: 'octocat', ownerType: 'user' },
    });
    try {
      githubCapabilities = { repos: true, boards: false };
      assert.equal((await call('POST', path(wid, `/${id}/test`))).status, 200);
    } finally {
      githubCapabilities = { repos: true, boards: true };
    }
    const stored = await integrationDoc(wid, id);
    assert.deepEqual(stored?.config, {
      owner: 'octocat',
      ownerType: 'user',
      boards: { enabled: false },
    });
  });

  it('GitHub: a config PATCH that lands during the test is kept; only boards.enabled is written', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, {
      provider: 'github',
      config: { owner: 'TLVTech', ownerType: 'org', boards: { include: [3] } },
    });
    const saved = {
      owner: 'TLVTech',
      ownerType: 'org',
      repos: { include: ['TLVTech/api'], archived: true },
      issues: { closedWithinDays: 30 },
      boards: { include: [7], dueField: 'Deadline' },
    };
    duringTest = async (): Promise<void> => {
      const res = await call('PATCH', path(wid, `/${id}`), { config: saved });
      assert.equal(res.status, 200, res.text);
    };
    githubCapabilities = { repos: true, boards: false };
    try {
      assert.deepEqual(dataOf(await call('POST', path(wid, `/${id}/test`))), {
        ok: true,
        accountLabel: 'TLVTech',
        capabilities: { repos: true, boards: false },
      });
    } finally {
      duringTest = null;
      githubCapabilities = { repos: true, boards: true };
    }
    assert.deepEqual((await integrationDoc(wid, id))?.config, {
      ...saved,
      boards: { include: [7], dueField: 'Deadline', enabled: false },
    });
  });

  it('a label PATCH that lands during the test is kept: the default is replaced only while it is one', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, LINEAR_BODY);
    nextLabel = 'Linear Workspace';
    duringTest = async (): Promise<void> => {
      const res = await call('PATCH', path(wid, `/${id}`), { label: 'Team Linear' });
      assert.equal(res.status, 200, res.text);
    };
    try {
      assert.deepEqual(dataOf(await call('POST', path(wid, `/${id}/test`))), {
        ok: true,
        accountLabel: 'Linear Workspace',
        capabilities: { projects: true },
      });
    } finally {
      duringTest = null;
    }
    const stored = await integrationDoc(wid, id);
    assert.deepEqual([stored?.accountId, stored?.label], ['Linear Workspace', 'Team Linear']);
  });

  it('an account already connected in the workspace → already_connected; nothing changes', async () => {
    const wid = await newWorkspace();
    nextLabel = 'Same Workspace';
    const first = await connect(wid, LINEAR_BODY);
    const second = await connect(wid, LINEAR_BODY);
    assert.deepEqual(dataOf(await call('POST', path(wid, `/${first.id}/test`))), {
      ok: true,
      accountLabel: 'Same Workspace',
      capabilities: { projects: true },
    });
    const res = await call('POST', path(wid, `/${second.id}/test`));
    assert.deepEqual(dataOf(res), { ok: false, code: 'already_connected' });
    const stored = await integrationDoc(wid, second.id);
    assert.match(stored?.accountId ?? '', /^pending:/);
    assert.equal(stored?.label, 'linear');
  });

  it('at most 5 tests per integration per minute: the 6th → 429 with Retry-After; others go on', async () => {
    const wid = await newWorkspace();
    nextLabel = 'Rate Limited Workspace';
    const busy = await connect(wid, LINEAR_BODY);
    for (let n = 0; n < 5; n += 1) {
      const res = await call('POST', path(wid, `/${busy.id}/test`));
      assert.equal(res.status, 200, res.text);
    }
    const sixth = await call('POST', path(wid, `/${busy.id}/test`));
    assert.equal(sixth.status, 429, sixth.text);
    assert.match(String(sixth.body?.['message']), /5 times in a minute/);
    const wait = Number(sixth.headers['retry-after']);
    assert.ok(wait >= 1 && wait <= 60, `Retry-After ${String(sixth.headers['retry-after'])}`);
    const tests = async (): Promise<number> =>
      (await (await models.getAuditLogRepository()).list(wid, { action: 'integration.test' }, 50))
        .length;
    assert.equal(await tests(), 5, 'a refused test is not run (nor counted)');

    const other = await connect(wid, { provider: 'clickup', config: {} });
    assert.equal((await call('POST', path(wid, `/${other.id}/test`))).status, 200);

    // A minute later, the busy one may be tested again.
    const { AuditLogMongoModel } = await import('../../models/mongoose/AuditLog.js');
    await AuditLogMongoModel.collection.updateMany(
      { targetId: busy.id, action: 'integration.test' },
      { $set: { at: new Date(Date.now() - 61_000) } },
    );
    assert.equal((await call('POST', path(wid, `/${busy.id}/test`))).status, 200);
  });

  it('no adapter for the provider → no_adapter; an adapter without a test → not_supported', async () => {
    const wid = await newWorkspace();
    const jira = await connect(wid, JIRA_BODY);
    const clickup = await connect(wid, { provider: 'clickup', config: {} });
    // The real Jira adapter is registered by sync/providers: take it away for this case.
    const realJira = getAdapter('jira');
    unregisterAdapter('jira');
    try {
      assert.deepEqual(dataOf(await call('POST', path(wid, `/${jira.id}/test`))), {
        ok: false,
        code: 'no_adapter',
      });
    } finally {
      if (realJira !== null) registerAdapter(realJira);
    }
    assert.deepEqual(dataOf(await call('POST', path(wid, `/${clickup.id}/test`))), {
      ok: false,
      code: 'not_supported',
    });
  });
});

// ─── GET …/config ──────────────────────────────────────────────────────────

describe('GET /workspaces/:wid/integrations/:iid/config (R2)', () => {
  const CREDENTIAL_FIELDS = [
    'token',
    'apiKey',
    'email',
    'clientEmail',
    'privateKey',
    'execUrl',
    'sharedSecret',
    'kid',
    'projectsToken',
  ];

  it('the validated non-secret config, for every provider, and never a credential field', async () => {
    const wid = await newWorkspace();
    const cases: [Record<string, unknown>, Record<string, string>, Record<string, unknown>][] = [
      [
        {
          provider: 'jira',
          config: { baseUrl: 'https://AutoDS.atlassian.net/', jql: 'project = ADS' },
        },
        JIRA,
        { baseUrl: 'https://autods.atlassian.net', jql: 'project = ADS' },
      ],
      [LINEAR_BODY, LINEAR, {}],
      [{ provider: 'clickup', config: {} }, { token: 'pk_12345678_FAKE0123456789ABCDEFGHIJ' }, {}],
      [
        {
          provider: 'github',
          config: { owner: 'octo', ownerType: 'org', boards: { include: [3] } },
        },
        GITHUB,
        { owner: 'octo', ownerType: 'org', boards: { include: [3] } },
      ],
    ];
    for (const [body, secret, expected] of cases) {
      const { id } = await connect(wid, body);
      assert.equal((await call('PUT', path(wid, `/${id}/credential`), secret)).status, 204);
      const res = await call('GET', path(wid, `/${id}/config`));
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(dataOf(res), expected, String(body['provider']));
      assertNoSecret('the config answer', res.text);
      for (const field of CREDENTIAL_FIELDS) {
        assert.ok(
          !res.text.includes(`"${field}"`),
          `${String(body['provider'])} answers "${field}"`,
        );
      }
    }
  });

  it('its owner only; another member’s, another workspace’s or a deleted integration is 404', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    for (const who of ['editor', 'viewer'] as const) {
      assert.equal((await call('GET', path(wid, `/${id}/config`), undefined, who)).status, 404);
    }
    const other = await newWorkspace();
    assert.equal((await call('GET', path(other, `/${id}/config`))).status, 404);
  });

  it('a stored config that no longer validates is not shown (409), never answered raw', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    const { IntegrationMongoModel } = await import('../../models/mongoose/Integration.js');
    await IntegrationMongoModel.updateOne(
      { _id: id },
      { $set: { config: { baseUrl: 'https://autods.atlassian.net', token: JIRA.token } } },
    );
    const res = await call('GET', path(wid, `/${id}/config`));
    assert.equal(res.status, 409, res.text);
    assertNoSecret('the answer', res.text);
  });
});

// ─── PATCH ─────────────────────────────────────────────────────────────────

describe('PATCH /workspaces/:wid/integrations/:iid', () => {
  it('sets or clears expiresAt (an ISO date-time or date, or null), shown in the status', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    const set = await call('PATCH', path(wid, `/${id}`), {
      expiresAt: '2027-11-01T09:30:00+02:00',
    });
    assert.equal(set.status, 200, set.text);
    assert.equal(statusOf(set).expiresAt, '2027-11-01T07:30:00.000Z');
    assert.deepEqual((await integrationDoc(wid, id))?.expiresAt, new Date('2027-11-01T07:30:00Z'));
    const dateOnly = await call('PATCH', path(wid, `/${id}`), { expiresAt: '2027-12-31' });
    assert.equal(statusOf(dateOnly).expiresAt, '2027-12-31T00:00:00.000Z');
    const cleared = await call('PATCH', path(wid, `/${id}`), { expiresAt: null });
    assert.equal(statusOf(cleared).expiresAt, null);
    assert.equal((await integrationDoc(wid, id))?.expiresAt, null);
    assert.deepEqual((await auditActions(wid)).at(-1), {
      action: 'integration.update',
      meta: { changed: ['expiresAt'] },
    });
    for (const bad of ['tomorrow', '2027-13-01', 12345, '2027-11-01T09:30:00']) {
      const res = await call('PATCH', path(wid, `/${id}`), { expiresAt: bad });
      assert.equal(res.status, 400, `${String(bad)}: ${res.text}`);
      assert.match(String(res.body?.['message']), /^expiresAt: /);
    }
  });

  it('changes the label, topic and config (validated again): 200 with the 6 keys, audited by key', async () => {
    const wid = await newWorkspace();
    const personal = await topicOf(wid, 'personal');
    const { id } = await connect(wid, JIRA_BODY);
    const res = await call('PATCH', path(wid, `/${id}`), {
      label: 'AutoDS Jira',
      topicId: personal,
      config: { baseUrl: 'https://autods.atlassian.net/', jql: 'project = ADS' },
    });
    assert.equal(res.status, 200, res.text);
    const view = statusOf(res);
    assert.deepEqual(Object.keys(view).sort(), STATUS_KEYS);
    assert.equal(view.accountLabel, 'AutoDS Jira');
    const stored = await integrationDoc(wid, id);
    assert.deepEqual(
      [stored?.topicId, stored?.config],
      [personal, { baseUrl: 'https://autods.atlassian.net', jql: 'project = ADS' }],
    );
    assert.deepEqual((await auditActions(wid)).at(-1), {
      action: 'integration.update',
      meta: { changed: ['label', 'topicId', 'config'] },
    });
  });

  const refused: [string, Record<string, unknown>][] = [
    ['nothing to change', {}],
    ['a status', { status: 'active' }],
    ['a secret field', { token: JIRA.token }],
    ['another provider', { provider: 'linear' }],
    ['another Jira site', { config: { baseUrl: 'https://other.atlassian.net' } }],
    ['an invalid config', { config: { baseUrl: 'ftp://autods.atlassian.net' } }],
    [
      'a secret in the config',
      { config: { baseUrl: 'https://autods.atlassian.net', jql: JIRA.token } },
    ],
    ['an unknown topic', { topicId: 'hobby' }],
  ];
  for (const [what, body] of refused) {
    it(`refuses ${what} (400); nothing changes`, async () => {
      const wid = await newWorkspace();
      const { id } = await connect(wid, JIRA_BODY);
      const before = await integrationDoc(wid, id);
      const res = await call('PATCH', path(wid, `/${id}`), body);
      assert.equal(res.status, 400, res.text);
      assertNoSecret('the answer', res.text);
      assert.deepEqual(await integrationDoc(wid, id), before);
    });
  }
});

// ─── DELETE ────────────────────────────────────────────────────────────────

describe('DELETE /workspaces/:wid/integrations/:iid (disconnect)', () => {
  it('hard-deletes the credential, soft-deletes the integration, its items and containers; audited', async () => {
    const wid = await newWorkspace();
    const gone = await connect(wid, JIRA_BODY);
    const kept = await connect(wid, { provider: 'clickup', config: {} });
    for (const { id } of [gone, kept]) {
      assert.equal(
        (
          await call(
            'PUT',
            path(wid, `/${id}/credential`),
            id === gone.id ? JIRA : { token: 'pk_12345678_FAKE0123456789ABCDEFGHIJ' },
          )
        ).status,
        204,
      );
    }
    const containers = await models.getContainerRepository();
    const items = await models.getItemRepository();
    for (const { id } of [gone, kept]) {
      const source = (externalId: string): Models.ItemData['source'] => ({
        provider: 'jira',
        accountId: id,
        externalId,
        key: null,
        url: `https://example.invalid/${id}/${externalId}`,
        updatedAtSource: null,
        etag: null,
        hash: null,
      });
      await containers.bulkUpsert(wid, [
        { integrationId: id, topicId: 'work', type: 'project', name: 'P', source: source('p') },
      ]);
      await items.bulkUpsert(wid, [
        {
          integrationId: id,
          kind: 'issue',
          topicId: 'work',
          title: 'I',
          status: 'open',
          source: source('i'),
        },
      ]);
    }
    const local = await items.createLocal(wid, {
      ownerUserId: ids.owner,
      title: 'Mine',
      topicId: 'personal',
    });

    const res = await call('DELETE', path(wid, `/${gone.id}`));
    assert.deepEqual([res.status, res.text], [204, '']);

    assert.equal(await credentialOf(wid, gone.id), null);
    const { CredentialMongoModel } = await import('../../models/mongoose/Credential.js');
    assert.equal(await CredentialMongoModel.countDocuments({ integrationId: gone.id }), 0);
    assert.equal(await integrationDoc(wid, gone.id), null);
    const { IntegrationMongoModel } = await import('../../models/mongoose/Integration.js');
    const raw = await IntegrationMongoModel.findById(gone.id).lean();
    assert.ok(raw?.deletedAt instanceof Date);

    const { ItemMongoModel } = await import('../../models/mongoose/Item.js');
    const { ContainerMongoModel } = await import('../../models/mongoose/Container.js');
    const deleted = async (integrationId: string): Promise<boolean[]> => [
      ...(await ItemMongoModel.find({ integrationId }).lean()).map((row) => row.deletedAt !== null),
      ...(await ContainerMongoModel.find({ integrationId }).lean()).map(
        (row) => row.deletedAt !== null,
      ),
    ];
    assert.deepEqual(await deleted(gone.id), [true, true]);
    assert.deepEqual(await deleted(kept.id), [false, false]);
    assert.equal((await items.findById(wid, local.id))?.deletedAt, null);
    assert.ok((await credentialOf(wid, kept.id)) !== null);

    assert.deepEqual((await auditActions(wid)).at(-1), {
      action: 'integration.disconnect',
      meta: { provider: 'jira' },
    });
    assert.deepEqual(
      statusList(await call('GET', path(wid))).map((view) => view.id),
      [kept.id],
    );
    // Gone for every other route; DELETE again resumes (nothing left to do) and answers 204.
    for (const [method, rest, body] of [
      ['PATCH', `/${gone.id}`, { label: 'x' }],
      ['PUT', `/${gone.id}/credential`, JIRA],
      ['POST', `/${gone.id}/test`, undefined],
      ['GET', `/${gone.id}/config`, undefined],
    ] as const) {
      assert.equal((await call(method, path(wid, rest), body)).status, 404, `${method} ${rest}`);
    }
    assert.equal(await credentialOf(wid, gone.id), null);
    assert.equal((await call('DELETE', path(wid, `/${gone.id}`))).status, 204);
    assert.equal(
      (await auditActions(wid)).filter(({ action }) => action === 'integration.disconnect').length,
      1,
      'audited once',
    );
  });

  it('in this order: deletedAt first (a run in flight then cleans up), the audit, the credential (checked gone), items and containers', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), JIRA)).status, 204);
    const order: string[] = [];
    spy(order, await models.getIntegrationRepository(), 'softDelete', 'integration.softDelete');
    spy(order, await models.getAuditLogRepository(), 'append', 'audit');
    spy(order, await models.getCredentialRepository(), 'delete', 'credential.delete');
    spy(order, await models.getCredentialRepository(), 'findMeta', 'credential.findMeta');
    spy(order, await models.getItemRepository(), 'softDeleteForIntegration', 'items');
    spy(order, await models.getContainerRepository(), 'softDeleteForIntegration', 'containers');
    try {
      assert.equal((await call('DELETE', path(wid, `/${id}`))).status, 204);
    } finally {
      restoreSpies();
    }
    assert.deepEqual(order, [
      'integration.softDelete',
      'audit',
      'credential.delete',
      'credential.findMeta',
      'items',
      'containers',
    ]);
  });

  it('a credential that survives its delete fails loudly (500) before items; a retry finishes the disconnect (204)', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), JIRA)).status, 204);
    const order: string[] = [];
    const credentials = await models.getCredentialRepository();
    const realDelete = credentials.delete.bind(credentials);
    credentials.delete = (): Promise<boolean> => Promise.resolve(true);
    spy(order, await models.getItemRepository(), 'softDeleteForIntegration', 'items');
    let logs = '';
    try {
      logs = await logsDuring(async () => {
        const res = await call('DELETE', path(wid, `/${id}`));
        assert.deepEqual([res.status, res.body], [500, { message: 'Internal server error' }]);
      });
    } finally {
      credentials.delete = realDelete;
      restoreSpies();
    }
    assert.match(logs, /left its credential behind/);
    assertNoSecret('the logs', logs);
    assert.deepEqual(order, [], 'items untouched');
    assert.ok((await credentialOf(wid, id)) !== null);
    // Deleted and audited already: the integration is gone from the API but the DELETE resumes.
    assert.equal(await integrationDoc(wid, id), null);
    assert.equal((await call('DELETE', path(wid, `/${id}`))).status, 204);
    assert.equal(await credentialOf(wid, id), null);
    assert.deepEqual(
      (await auditActions(wid)).filter(({ action }) => action === 'integration.disconnect'),
      [{ action: 'integration.disconnect', meta: { provider: 'jira' } }],
    );
  });

  it('items that fail to be deleted fail the disconnect (500); a retry soft-deletes them (204)', async () => {
    const wid = await newWorkspace();
    const { id } = await connect(wid, JIRA_BODY);
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), JIRA)).status, 204);
    const source = (externalId: string): Models.ItemData['source'] => ({
      provider: 'jira',
      accountId: 'autods.atlassian.net',
      externalId,
      key: null,
      url: `https://example.invalid/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: null,
    });
    await (
      await models.getContainerRepository()
    ).bulkUpsert(wid, [
      { integrationId: id, topicId: 'work', type: 'project', name: 'P', source: source('p') },
    ]);
    await (
      await models.getItemRepository()
    ).bulkUpsert(wid, [
      {
        integrationId: id,
        kind: 'issue',
        topicId: 'work',
        title: 'I',
        status: 'open',
        source: source('i'),
      },
    ]);
    const items = await models.getItemRepository();
    const realSoftDelete = items.softDeleteForIntegration.bind(items);
    items.softDeleteForIntegration = (): Promise<number> =>
      Promise.reject(new Error('database unavailable'));
    try {
      await logsDuring(async () => {
        assert.equal((await call('DELETE', path(wid, `/${id}`))).status, 500);
      });
    } finally {
      items.softDeleteForIntegration = realSoftDelete;
    }
    assert.equal(await credentialOf(wid, id), null, 'the credential went first');
    const { ItemMongoModel } = await import('../../models/mongoose/Item.js');
    const { ContainerMongoModel } = await import('../../models/mongoose/Container.js');
    const live = async (): Promise<number> =>
      (await ItemMongoModel.countDocuments({ integrationId: id, deletedAt: null })) +
      (await ContainerMongoModel.countDocuments({ integrationId: id, deletedAt: null }));
    assert.equal(await live(), 2, 'left over by the failed attempt');

    assert.equal((await call('DELETE', path(wid, `/${id}`))).status, 204);
    assert.equal(await live(), 0);
  });

  it('a deleted integration of another workspace still answers 404 through A’s routes', async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const { id } = await connect(b, JIRA_BODY);
    assert.equal((await call('DELETE', path(b, `/${id}`))).status, 204);
    assert.equal((await call('DELETE', path(a, `/${id}`))).status, 404);
  });
});

const spies: (() => void)[] = [];

/** Records `label` in `order` on each call of `target[method]`, then runs the real method. */
function spy(order: string[], target: object, method: string, label: string): void {
  const record = target as Record<string, unknown>;
  const original = record[method];
  if (typeof original !== 'function') throw new Error(`${method} is not a method`);
  record[method] = (...args: unknown[]): unknown => {
    order.push(label);
    return (original as (...params: unknown[]) => unknown).apply(target, args);
  };
  spies.push(() => {
    record[method] = original;
  });
}

function restoreSpies(): void {
  for (const restore of spies.splice(0).reverse()) restore();
}
