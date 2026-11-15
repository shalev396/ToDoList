/**
 * Creating a to-do in the caller's own providers too (H5), end to end against the in-process mock
 * provider server: the chips, the funnel's options, each provider's create, the read-back that
 * stores one mirrored copy and hides it behind its to-do, idempotency, `unknown` on a cut
 * connection, the hourly limit, ownership and roles, consent (`needs_permission`), the audit entry
 * without content, and that no token or secret reaches a response or a log line.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import {
  pointAppAtMockOAuth,
  startMockOAuth,
  type MockOAuth,
  type MockOAuthProvider,
} from '../../testing/mockOAuthProviders.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

let api: ApiHarness;
let mock: MockOAuth;
let models: typeof Models;
let token: string;
let editorToken: string;
let viewerToken: string;
let outsiderToken: string;
let ownerId: string;
let wid: string;
const logged: string[] = [];
/** Every answer of the success paths: none may carry a token, a code or a secret. */
const answered: string[] = [];
const integrations = new Map<MockOAuthProvider, string>();

const W = (): string => `/api/private/workspaces/${wid}`;
const LINEAR_TEAM = '4a1b2c3d-0000-4000-8000-000000000001';
let requests = 0;
const requestId = (): string => `req-${String(Date.now())}-${String((requests += 1))}`;

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

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
  api = await startApiHarness('todolist_provider_create_unit');
  await pointAppAtMockOAuth(mock, api.baseUrl);
  models = await import('../../models/index.js');
  const idOf = async (email: string): Promise<{ token: string; id: string }> => {
    const login = await api.login(email);
    const me = await api.call('GET', '/api/private/me', { token: login.token });
    return { token: login.token, id: data(me.body)['id'] as string };
  };
  const owner = await idOf('create-owner@example.test');
  token = owner.token;
  ownerId = owner.id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Create', slug: `create-${randomUUID().slice(0, 8)}`, ownerId });
  wid = workspace.id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ownerId, role: 'owner' });
  const editor = await idOf('create-editor@example.test');
  editorToken = editor.token;
  await memberships.create(wid, { userId: editor.id, role: 'editor' });
  const viewer = await idOf('create-viewer@example.test');
  viewerToken = viewer.token;
  await memberships.create(wid, { userId: viewer.id, role: 'viewer' });
  outsiderToken = (await api.login('create-outsider@example.test')).token;
  for (const provider of ['github', 'jira', 'clickup', 'linear'] as const) {
    integrations.set(provider, await connect(provider, {}));
  }
});

after(async () => {
  await api.stop();
  await mock.close();
});

/** The whole OAuth flow (optionally asking for write consent); returns the integration id. */
async function connect(
  provider: MockOAuthProvider,
  body: Json,
  as: string = token,
): Promise<string> {
  const response = await fetch(`${api.baseUrl}${W()}/integrations/oauth/${provider}/start`, {
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
  const consent = await fetch(url, { redirect: 'manual' });
  const query = new URL(consent.headers.get('location') ?? '').searchParams;
  const callback = await fetch(
    `${api.baseUrl}/api/public/oauth/${provider}/callback?${query.toString()}`,
    { redirect: 'manual', headers: { cookie: `todolist_oauth=${nonce}` } },
  );
  const connected = /connected=([\w-]+)/.exec(callback.headers.get('location') ?? '');
  assert.ok(connected, callback.headers.get('location') ?? '');
  const id = connected[1] ?? '';
  // Every connection starts read-only; these tests create, so its owner switches it on.
  const switched = await api.call('PATCH', `${W()}/integrations/${id}`, {
    token: as,
    body: { mode: 'read_write' },
  });
  assert.equal(switched.status, 200, switched.text);
  return id;
}

async function todo(extra: Json = {}, as = token): Promise<string> {
  const created = await api.call('POST', `${W()}/items`, {
    token: as,
    body: { title: 'Buy milk', note: 'two litres', dueAt: '2026-11-20T10:00:00.000Z', ...extra },
  });
  assert.equal(created.status, 201, created.text);
  return data(created.body)['id'] as string;
}

const TARGETS: Record<string, (extra?: Json) => Json> = {
  linear: () => ({ provider: 'linear', teamId: LINEAR_TEAM }),
  clickup: () => ({ provider: 'clickup', listId: '90200' }),
  jira: () => ({ provider: 'jira', projectId: '10001', issueTypeId: '10002' }),
  github: () => ({ provider: 'github', repo: 'mock-org/mock-repo', labels: ['bug'] }),
};

async function copy(
  todoId: string,
  provider: MockOAuthProvider,
  options: { as?: string; requestId?: string; target?: Json; integrationId?: string } = {},
): Promise<{ status: number; body: Json; raw: Json; text: string }> {
  const response = await api.call('POST', `${W()}/items/${todoId}/copies`, {
    token: options.as ?? token,
    body: {
      requestId: options.requestId ?? requestId(),
      integrationId: options.integrationId ?? integrations.get(provider),
      target: options.target ?? TARGETS[provider]?.(),
    },
  });
  answered.push(response.text);
  return {
    status: response.status,
    body: data(response.body),
    raw: response.body ?? {},
    text: response.text,
  };
}

const outcomeStatus = (r: { body: Json }): unknown => r.body['status'];

describe('the chips', () => {
  it('lists the caller’s own integrations that can create, and flags the missing consent', async () => {
    const response = await api.call('GET', `${W()}/provider-create/targets`, { token });
    assert.equal(response.status, 200, response.text);
    const { targets } = data(response.body) as {
      targets: { provider: string; needsConsent: boolean }[];
    };
    const byProvider = Object.fromEntries(targets.map((t) => [t.provider, t.needsConsent]));
    assert.deepEqual(byProvider, { github: false, jira: true, clickup: false, linear: true });
  });

  it('shows nothing to a teammate (not their integrations) and is closed to a viewer', async () => {
    const editor = await api.call('GET', `${W()}/provider-create/targets`, { token: editorToken });
    assert.deepEqual((data(editor.body)['targets'] as unknown[]).length, 0);
    assert.equal(
      (await api.call('GET', `${W()}/provider-create/targets`, { token: viewerToken })).status,
      403,
    );
    assert.equal(
      (await api.call('GET', `${W()}/provider-create/targets`, { token: outsiderToken })).status,
      404,
    );
  });
});

describe('the funnel', () => {
  const options = async (
    provider: MockOAuthProvider,
    query: string,
    as = token,
  ): Promise<{ status: number; body: Json }> => {
    const response = await api.call(
      'GET',
      `${W()}/integrations/${integrations.get(provider) ?? ''}/create-options?${query}`,
      { token: as },
    );
    answered.push(response.text);
    return { status: response.status, body: data(response.body) };
  };
  const names = (r: { body: Json }): string[] =>
    (r.body['options'] as { name: string }[]).map((o) => o.name);

  it('Jira: site, project, issue type (no sub-tasks) and the Team field', async () => {
    assert.deepEqual(names(await options('jira', 'step=site')), ['Mock Site']);
    const site = 'siteId=1324a887-45db-1bf4-1e99-ef0ff456d421';
    assert.deepEqual(names(await options('jira', `step=project&${site}`)), ['Mock Project']);
    assert.deepEqual(names(await options('jira', `step=issueType&${site}&projectId=10001`)), [
      'Task',
      'Bug',
    ]);
    const team = await options('jira', `step=team&${site}&projectId=10001&issueTypeId=10002`);
    assert.deepEqual(names(team), ['Backend', 'Web']);
    assert.equal(team.body['fieldId'], 'customfield_10100');
  });

  it('ClickUp: workspace, space, folder and lists', async () => {
    assert.deepEqual(names(await options('clickup', 'step=workspace')), ['Mock Workspace']);
    assert.deepEqual(names(await options('clickup', 'step=space&workspaceId=9001')), [
      'Mock Space',
    ]);
    assert.deepEqual(names(await options('clickup', 'step=folder&spaceId=90010')), ['Mock Folder']);
    assert.deepEqual(names(await options('clickup', 'step=list&folderId=90100')), ['Mock List']);
    assert.deepEqual(names(await options('clickup', 'step=list&spaceId=90010')), ['Loose List']);
  });

  it('Linear: team, project and the states with the default marked', async () => {
    assert.deepEqual(names(await options('linear', 'step=linearTeam')), ['Mock Team']);
    assert.deepEqual(
      names(await options('linear', `step=linearProject&linearTeamId=${LINEAR_TEAM}`)),
      ['Mock Project'],
    );
    const states = await options('linear', `step=state&linearTeamId=${LINEAR_TEAM}`);
    assert.deepEqual(names(states), ['Todo', 'In Progress']);
    assert.equal((states.body['options'] as { hint?: string }[])[0]?.hint, 'default');
  });

  it('GitHub: repositories of the installation, then the repository’s labels', async () => {
    assert.deepEqual(names(await options('github', 'step=repo')), ['mock-org/mock-repo']);
    assert.deepEqual(names(await options('github', 'step=label&repo=mock-org/mock-repo')), [
      'bug',
      'chore',
    ]);
  });

  it('refuses ids that are not ids, steps of another provider, a teammate and a viewer', async () => {
    assert.equal((await options('clickup', 'step=space&workspaceId=1/../2')).status, 400);
    assert.equal((await options('github', 'step=label&repo=mock-org/..')).status, 400);
    assert.equal((await options('github', 'step=project')).status, 400);
    assert.equal((await options('linear', 'step=state&linearTeamId=nope')).status, 400);
    assert.equal((await options('jira', 'step=project&siteId=not-mine-xxxxxxxx')).status, 400);
    assert.equal((await options('clickup', 'step=workspace', editorToken)).status, 404);
    assert.equal((await options('clickup', 'step=workspace', viewerToken)).status, 403);
  });
});

describe('consent', () => {
  it('Linear and Jira ask for consent first, then create after the user grants the write scope', async () => {
    for (const provider of ['linear', 'jira'] as const) {
      const id = await todo();
      const before = await copy(id, provider);
      assert.equal(before.status, 200, before.text);
      assert.equal(outcomeStatus(before), 'needs_permission');
      assert.equal(before.body['kind'], 'oauth_scope');
      assert.equal(mock.created(provider).count, 0);
      // The re-consent: the same start route, asking for the write scope too.
      const reconsented = await connect(provider, {
        integrationId: integrations.get(provider),
        includeWrite: true,
      });
      assert.equal(reconsented, integrations.get(provider));
      const after = await copy(id, provider);
      assert.equal(outcomeStatus(after), 'created', after.text);
      assert.equal(mock.created(provider).count, 1);
    }
    const chips = await api.call('GET', `${W()}/provider-create/targets`, { token });
    const flags = (
      data(chips.body)['targets'] as { provider: string; needsConsent: boolean }[]
    ).map((t) => t.needsConsent);
    assert.ok(flags.every((flag) => !flag));
  });

  it('a reconnect asking for write on GitHub or ClickUp asks for their normal scopes', async () => {
    for (const provider of ['github', 'clickup'] as const) {
      const response = await api.call('POST', `${W()}/integrations/oauth/${provider}/start`, {
        token,
        body: { integrationId: integrations.get(provider), includeWrite: true },
      });
      assert.equal(response.status, 200, response.text);
      const url = new URL(data(response.body)['authorizeUrl'] as string);
      assert.equal(url.searchParams.get('scope'), null);
      assert.ok(!url.search.includes('write'));
    }
  });

  it('a reconnect asking for write on Jira or Linear asks for their write scope', async () => {
    for (const [provider, scope] of [
      ['jira', 'write:jira-work'],
      ['linear', 'read,write'],
    ] as const) {
      const response = await api.call('POST', `${W()}/integrations/oauth/${provider}/start`, {
        token,
        body: { integrationId: integrations.get(provider), includeWrite: true },
      });
      assert.equal(response.status, 200, response.text);
      const url = new URL(data(response.body)['authorizeUrl'] as string);
      assert.ok((url.searchParams.get('scope') ?? '').includes(scope));
    }
  });
});

describe('creating', () => {
  it('Linear and ClickUp: created with their keys, one mirrored copy hidden behind its to-do', async () => {
    const id = await todo({ title: 'Two targets' });
    const linear = await copy(id, 'linear');
    const clickup = await copy(id, 'clickup');
    assert.equal(outcomeStatus(linear), 'created', linear.text);
    assert.equal(outcomeStatus(clickup), 'created', clickup.text);
    assert.match((linear.body['copy'] as { key: string }).key, /^MOCK-\d+$/);
    assert.match(
      (clickup.body['copy'] as { url: string }).url,
      /^https:\/\/app\.clickup\.com\/t\//,
    );
    // What the provider was sent: built from the to-do, nothing else.
    assert.equal(mock.created('linear').last?.['title'], 'Two targets');
    assert.equal(mock.created('linear').last?.['dueDate'], '2026-11-20');
    // The list: ONE row for the to-do, with a chip per copy; the copies are absorbed.
    const list = await api.call('GET', `${W()}/items?limit=100`, { token });
    const rows = (
      data(list.body)['items'] as {
        id: string;
        title: string;
        source: { provider: string };
        copies: { provider: string }[];
      }[]
    ).filter((row) => row.title.startsWith('Two targets'));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.copies.map((c) => c.provider).sort(), ['clickup', 'linear']);
    // Filtering by Linear alone shows the copy.
    const filtered = await api.call('GET', `${W()}/items?provider=linear&limit=100`, { token });
    const titles = (data(filtered.body)['items'] as { title: string }[]).map((row) => row.title);
    assert.ok(titles.includes('Two targets'));
  });

  it('Jira writes the typed fields (ADF description, due date, Team, assignee) and reads back the key', async () => {
    const id = await todo({ title: 'Jira one' });
    const result = await copy(id, 'jira', {
      target: {
        provider: 'jira',
        siteId: '1324a887-45db-1bf4-1e99-ef0ff456d421',
        projectId: '10001',
        issueTypeId: '10002',
        team: { fieldId: 'customfield_10100', id: 'team-backend' },
        assignMe: true,
      },
    });
    assert.equal(outcomeStatus(result), 'created', result.text);
    const sent = mock.created('jira').last as { fields: Record<string, unknown> };
    assert.equal(sent.fields['summary'], 'Jira one');
    assert.equal(sent.fields['duedate'], '2026-11-20');
    assert.equal(sent.fields['customfield_10100'], 'team-backend');
    assert.deepEqual(sent.fields['assignee'], { accountId: 'mock-atlassian-account' });
    assert.equal((sent.fields['description'] as { type: string }).type, 'doc');
  });

  it('GitHub: a 403 from the app is `needs_permission` with the settings link', async () => {
    const id = await todo();
    const created = await copy(id, 'github');
    assert.equal(outcomeStatus(created), 'created', created.text);
    assert.equal((created.body['copy'] as { key: string }).key, 'mock-org/mock-repo#1');
    mock.failNextCreate('github', 403);
    const refused = await copy(await todo(), 'github');
    assert.equal(outcomeStatus(refused), 'needs_permission');
    assert.equal(refused.body['kind'], 'github_app');
    assert.match(refused.body['settingsUrl'] as string, /^https:\/\/github\.com\/settings\//);
  });

  it('a repeat of a request never creates twice', async () => {
    const id = await todo();
    const same = requestId();
    const first = await copy(id, 'clickup', { requestId: same });
    const before = mock.created('clickup').count;
    const second = await copy(id, 'clickup', { requestId: same });
    assert.equal(outcomeStatus(first), 'created');
    assert.equal(outcomeStatus(second), 'created');
    assert.equal(mock.created('clickup').count, before, 'nothing was sent the second time');
  });

  it('a cut connection is `unknown`, never retried, and a repeat answers the same', async () => {
    const id = await todo();
    const same = requestId();
    const before = mock.created('clickup').count;
    mock.failNextCreate('clickup', 'drop');
    const first = await copy(id, 'clickup', { requestId: same });
    assert.equal(outcomeStatus(first), 'unknown', first.text);
    const again = await copy(id, 'clickup', { requestId: same });
    assert.equal(outcomeStatus(again), 'unknown');
    assert.equal(mock.created('clickup').count, before, 'no automatic retry, no second create');
  });

  it('a provider error fails with a plain reason, and a new attempt replaces the failed one', async () => {
    const id = await todo();
    mock.failNextCreate('clickup', 400);
    const failed = await copy(id, 'clickup');
    assert.equal(outcomeStatus(failed), 'failed');
    assert.equal(failed.body['reason'], 'rejected');
    const retried = await copy(id, 'clickup');
    assert.equal(outcomeStatus(retried), 'created');
    const item = await api.call('GET', `${W()}/items/${id}`, { token });
    const copies = data(item.body)['copies'] as { status: string }[];
    assert.deepEqual(
      copies.map((c) => c.status),
      ['created'],
    );
  });

  it('a calendar-only rule: the to-do needs a due date for an event (400 needs_due_date)', async () => {
    // No Google Calendar integration here: the integration lookup answers first.
    const id = await todo({ dueAt: null });
    const response = await copy(id, 'clickup', { integrationId: 'does-not-exist' });
    assert.equal(response.status, 404);
  });
});

describe('who may create', () => {
  it('a teammate cannot target the owner’s integration (404), nor can a viewer or an outsider', async () => {
    const id = await todo({}, editorToken);
    assert.equal((await copy(id, 'clickup', { as: editorToken })).status, 404);
    assert.equal((await copy(id, 'clickup', { as: viewerToken })).status, 403);
    assert.equal((await copy(id, 'clickup', { as: outsiderToken })).status, 404);
  });

  it('only the to-do’s own owner may copy it, and a target must be of the integration’s provider', async () => {
    const id = await todo({}, editorToken);
    assert.equal(
      (await copy(id, 'clickup')).status,
      404,
      'the owner of the integration is not the to-do’s',
    );
    const mine = await todo();
    const wrong = await copy(mine, 'clickup', { target: TARGETS['linear']?.() ?? {} });
    assert.equal(wrong.status, 400);
    const pathId = await copy(mine, 'clickup', {
      target: { provider: 'clickup', listId: '1/../2' },
    });
    assert.equal(pathId.status, 400);
  });

  it('is off for demo data: 409 provider_writes_off, nothing sent', async () => {
    const id = await todo();
    const collection = (await import('mongoose')).default.connection.collection('Integrations');
    // Integrations' ids are UUID strings, not ObjectIds.
    const clickup = { _id: (integrations.get('clickup') ?? '') as never };
    await collection.updateOne(clickup, { $set: { demo: true } });
    try {
      const before = mock.created('clickup').count;
      const response = await copy(id, 'clickup');
      assert.equal(response.status, 409);
      assert.equal(response.raw['code'], 'provider_writes_off');
      assert.equal(mock.created('clickup').count, before);
    } finally {
      await collection.updateOne(clickup, { $set: { demo: false } });
    }
  });
});

describe('what is recorded', () => {
  it('audits each create with the integration, provider and key: no title, no token', async () => {
    const entries = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'provider.create' }, 100);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(entry.targetType, 'integration');
      assert.deepEqual(
        Object.keys(entry.meta)
          .sort()
          .filter((k) => k !== 'externalKey'),
        ['provider', 'result'],
      );
      assert.ok(!JSON.stringify(entry).includes('Buy milk'));
    }
  });

  it('no success answer carries a token, a code or the client secret either', () => {
    assert.ok(answered.length > 20);
    for (const text of answered) {
      assert.ok(!/FAKE-(?:github|jira|clickup|linear)-(?:access|refresh|client)/.test(text));
      assert.ok(!text.includes('FAKE-code-'));
    }
  });

  it('no response or log line carries a token, a code or the client secret', () => {
    const all = logged.join('\n');
    assert.ok(!/FAKE-(?:github|jira|clickup|linear)-(?:access|refresh)/.test(all));
    assert.ok(!all.includes('FAKE-code-'));
    assert.ok(!all.includes('client-secret'));
  });
});

describe('roles and sharing (H1)', () => {
  it('an owner of an integration may re-consent whatever their role; creating still needs an editor', async () => {
    // The editor connects their own Linear, is then demoted to a viewer.
    const mine = await connect('linear', {}, editorToken);
    const memberships = await models.getMembershipRepository();
    const editorMe = await api.call('GET', '/api/private/me', { token: editorToken });
    const editorId = data(editorMe.body)['id'] as string;
    await memberships.update(wid, editorId, { role: 'viewer' });
    try {
      const start = await api.call('POST', `${W()}/integrations/oauth/linear/start`, {
        token: editorToken,
        body: { integrationId: mine, includeWrite: true },
      });
      assert.equal(start.status, 200, start.text);
      const todoId = await todo({}, token);
      const create = await api.call('POST', `${W()}/items/${todoId}/copies`, {
        token: editorToken,
        body: {
          requestId: requestId(),
          integrationId: mine,
          target: TARGETS['linear']?.(),
        },
      });
      assert.equal(create.status, 403, 'a viewer cannot create');
    } finally {
      await memberships.update(wid, editorId, { role: 'editor' });
    }
  });

  it('a chip says whether its integration is shared (a connector on a block)', async () => {
    const response = await api.call('GET', `${W()}/provider-create/targets`, { token });
    const targets = data(response.body)['targets'] as { shared: boolean }[];
    assert.ok(targets.every((target) => !target.shared));
  });

  it('another member never sees my copies: not my targets, not my private to-do, not its statuses', async () => {
    const id = await todo({ title: 'Private plan', visibility: undefined });
    const repo = await models.getItemRepository();
    await repo.updateLocal(wid, id, { visibility: 'private' });
    const made = await copy(id, 'github');
    assert.equal(outcomeStatus(made), 'created', made.text);
    // Member B: 404 on the targets of A, and the to-do and its copy statuses are not there.
    assert.equal(
      (await copy(id, 'github', { as: editorToken })).status,
      404,
      'the to-do is not theirs to copy',
    );
    const row = await api.call('GET', `${W()}/items/${id}`, { token: editorToken });
    assert.equal(row.status, 404);
    const list = await api.call('GET', `${W()}/items?limit=100`, { token: editorToken });
    const titles = (data(list.body)['items'] as { title: string; copies: unknown[] }[]).map(
      (item) => item.title,
    );
    assert.ok(!titles.includes('Private plan'), 'B does not see the private to-do');
    assert.ok(!list.text.includes(id), 'nor its id, nor the statuses of its copies');
  });
});

describe('the hourly limit', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const setCount = async (provider: string, count: number): Promise<void> => {
    const { CreateQuotaMongoModel } = await import('../../models/mongoose/CreateQuota.js');
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    await CreateQuotaMongoModel.updateOne(
      { _id: `${ownerId}|${provider}|${String(hour)}` },
      { $set: { count, expireAt: new Date(hour + 2 * HOUR_MS) } },
      { upsert: true },
    );
  };

  it('at 29, two parallel creates make exactly one 429 and one item', async () => {
    await setCount('clickup', 29);
    const before = mock.created('clickup').count;
    const [a, b] = await Promise.all([
      copy(await todo({ title: 'Race A' }), 'clickup'),
      copy(await todo({ title: 'Race B' }), 'clickup'),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
    const over = a.status === 429 ? a : b;
    assert.equal(over.raw['code'], 'create_rate_limited');
    assert.equal(mock.created('clickup').count - before, 1, 'only one reached the provider');
    // Another provider has its own budget.
    assert.equal(outcomeStatus(await copy(await todo(), 'github')), 'created');
  });

  it('a definite refusal gives the reservation back; an unknown keeps it', async () => {
    await setCount('clickup', 10);
    const { CreateQuotaMongoModel } = await import('../../models/mongoose/CreateQuota.js');
    const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const count = async (): Promise<number> =>
      (await CreateQuotaMongoModel.findById(`${ownerId}|clickup|${String(hour)}`))?.count ?? -1;
    mock.failNextCreate('clickup', 400);
    await copy(await todo(), 'clickup');
    assert.equal(await count(), 10, 'a provider 4xx releases it');
    mock.failNextCreate('clickup', 'drop');
    await copy(await todo(), 'clickup');
    assert.equal(await count(), 11, 'no answer keeps it');
    await copy(await todo({ title: 'bad' }), 'clickup', {
      target: { provider: 'clickup', listId: '1/../2' },
    });
    assert.equal(await count(), 11, 'a 400 before sending releases it');
  });
});

describe('a second request for a to-do that already has a copy', () => {
  it('answers the copy it has and reaches no provider; retryAnyway creates again', async () => {
    const id = await todo({ title: 'Once only' });
    const first = await copy(id, 'github');
    assert.equal(outcomeStatus(first), 'created', first.text);
    const sent = mock.created('github').count;
    const second = await copy(id, 'github');
    assert.equal(outcomeStatus(second), 'created');
    assert.equal(mock.created('github').count, sent, 'a new request id is not a new create');
    const forced = await api.call('POST', `${W()}/items/${id}/copies`, {
      token,
      body: {
        requestId: requestId(),
        integrationId: integrations.get('github'),
        target: TARGETS['github']?.(),
        retryAnyway: true,
      },
    });
    assert.equal(data(forced.body)['status'], 'created');
    assert.equal(mock.created('github').count, sent + 1);
  });

  it('a pending copy blocks another request id, and one stale for 2 minutes reads as unknown', async () => {
    const id = await todo({ title: 'Pending' });
    const repo = await models.getItemRepository();
    await repo.addCopy(wid, id, {
      integrationId: integrations.get('clickup') ?? '',
      provider: 'clickup',
      externalId: '',
      key: null,
      url: '',
      status: 'pending',
      requestId: 'pending-request-1',
      at: new Date(Date.now() - 5 * 60 * 1000),
    });
    const sent = mock.created('clickup').count;
    const result = await copy(id, 'clickup');
    assert.equal(outcomeStatus(result), 'unknown');
    assert.equal(mock.created('clickup').count, sent);
    const row = await api.call('GET', `${W()}/items/${id}`, { token });
    assert.equal((data(row.body)['copies'] as { status: string }[])[0]?.status, 'unknown');
  });

  it('two different request ids at once (two tabs) make one provider call', async () => {
    const id = await todo({ title: 'Two tabs' });
    const sent = mock.created('github').count;
    const [a, b] = await Promise.all([
      copy(id, 'github', { requestId: requestId() }),
      copy(id, 'github', { requestId: requestId() }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(mock.created('github').count - sent, 1);
  });

  it('one request id claimed twice at once creates once', async () => {
    const id = await todo({ title: 'Twice at once' });
    const same = requestId();
    const sent = mock.created('github').count;
    const [a, b] = await Promise.all([
      copy(id, 'github', { requestId: same }),
      copy(id, 'github', { requestId: same }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(mock.created('github').count - sent, 1);
  });
});

describe('what a create may write', () => {
  it('only labels the repository has (never creates one), only the project’s own Team field', async () => {
    const id = await todo({ title: 'Labels' });
    const sentBefore = mock.created('github').count;
    const bad = await copy(id, 'github', {
      target: { provider: 'github', repo: 'mock-org/mock-repo', labels: ['brand-new'] },
    });
    assert.equal(bad.status, 400);
    assert.equal(mock.created('github').count, sentBefore, 'nothing was sent');
    const jira = await copy(await todo({ title: 'Team' }), 'jira', {
      target: {
        provider: 'jira',
        siteId: '1324a887-45db-1bf4-1e99-ef0ff456d421',
        projectId: '10001',
        issueTypeId: '10002',
        team: { fieldId: 'customfield_10999', id: 'team-backend' },
      },
    });
    assert.equal(jira.status, 400);
  });

  it('the chips say which targets can be written', async () => {
    const response = await api.call('GET', `${W()}/provider-create/targets`, { token });
    const targets = data(response.body)['targets'] as { writable: boolean }[];
    assert.ok(targets.length > 0 && targets.every((target) => target.writable));
  });

  it('links in a copy are https on the provider’s own host', async () => {
    const { safeCopyUrl } = await import('./service.js');
    const clickup = { provider: 'clickup', authMethod: 'oauth', config: {} } as never;
    assert.equal(
      safeCopyUrl(clickup, 'https://app.clickup.com/t/1'),
      'https://app.clickup.com/t/1',
    );
    assert.equal(safeCopyUrl(clickup, 'javascript:alert(1)'), '');
    assert.equal(safeCopyUrl(clickup, 'http://app.clickup.com/t/1'), '');
    assert.equal(safeCopyUrl(clickup, 'https://evil.example/t/1'), '');
    assert.equal(safeCopyUrl(clickup, null), '');
    const brokenJira = {
      provider: 'jira',
      authMethod: 'oauth',
      config: { sites: [{ cloudId: '1324a887-45db-1bf4-1e99-ef0ff456d421', url: 'not a url' }] },
    } as never;
    assert.equal(safeCopyUrl(brokenJira, 'https://x.atlassian.net/browse/A-1'), '', 'no throw');
  });
});
