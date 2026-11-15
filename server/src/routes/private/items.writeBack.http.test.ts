/**
 * One edit of a mirrored item, split server-side (`PATCH …/items/:id`, Phase 4a), over HTTP against
 * a recording transport that stands in for the providers:
 * - the provider half (the fields its provider takes for the item's kind) goes to the provider,
 *   only from its integration's owner (anyone else: 403 `integration_not_owner`) and only while it
 *   is read & write (409 `integration_read_only`), with zero requests of any kind otherwise;
 * - the local half (the fields its provider lacks) is kept as overrides by any editor who sees it,
 *   with zero requests; an override equal to the provider's value clears it, and a write-back
 *   clears the written field's override;
 * - anything else is today's 409 `{message, openIn}`;
 * - a provider refusal carries `details` (fields, openIn, written, refused, uncertain);
 * - every read reads the effective values: the item, the list's filters, sort and cursor, the
 *   facets, and the query builder's filters and groups.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { ItemUpsert } from '../../models/definitions/Item.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import type { AuthMethod, Provider } from '../../types/domain.js';

type Json = Record<string, unknown>;

const JIRA_SITE = 'https://wb-http.atlassian.net';
const ISSUE_URL = 'https://api.github.com/repos/octo/hello/issues/12';
const DUE = '2026-11-20T10:00:00.000Z';
const LATER = '2026-11-27T10:00:00.000Z';

let api: ApiHarness;
let models: typeof Models;
const token = { owner: '', other: '' };
const ids = { owner: '', other: '' };
let wid = '';
let githubId = '';
let jiraId = '';
let issueId = '';
let prId = '';
let jiraItemId = '';

const sent: HttpRequest[] = [];
let routes: { match: (request: HttpRequest) => boolean; answer: HttpResponse }[] = [];
const recording: Transport = {
  send(request: HttpRequest): Promise<HttpResponse> {
    sent.push(request);
    const route = routes.find((entry) => entry.match(request));
    return route === undefined
      ? Promise.reject(new Error(`unrouted ${request.method} ${request.url}`))
      : Promise.resolve(route.answer);
  },
};
const json = (status: number, body: unknown = ''): HttpResponse => ({
  status,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const on = (method: string, url: string, answer: HttpResponse): void => {
  routes.push({ match: (request) => request.method === method && request.url === url, answer });
};
const lines = (): string[] => sent.map((request) => `${request.method} ${request.url}`);

const W = (): string => `/api/private/workspaces/${wid}`;
const call = (
  who: keyof typeof token,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> =>
  api.call(method, `${W()}${path}`, { token: token[who], ...(body === undefined ? {} : { body }) });
const data = (res: ApiResponse): Json => (res.body?.['data'] ?? {}) as Json;
const overrides = (item: Json): Json => (item['overlay'] as Json)['overrides'] as Json;

const KEYS: Partial<Record<Provider, { method: AuthMethod; secret: Record<string, string> }>> = {
  github: { method: 'fine_grained_pat', secret: { token: 'FAKE-github-key' } },
  jira: { method: 'api_token_basic', secret: { email: 'dev@example.test', token: 'FAKE-jira' } },
};

async function connect(provider: Provider, config: Json): Promise<string> {
  const key = KEYS[provider];
  assert.ok(key !== undefined);
  const created = await (
    await models.getIntegrationRepository()
  ).create(wid, {
    connectedBy: ids.owner,
    provider,
    accountId: `wb-http-${provider}`,
    label: provider,
    authMethod: key.method,
    topicId: null,
    mode: 'read_write',
    config,
  });
  const { Integration } = await import('../../classes/integration/index.js');
  const { callerFor } = await import('../../testing/workspaceFixtures.js');
  await Integration.from(created).saveCredential(await callerFor(wid, ids.owner), key.secret);
  return created.id;
}

async function mirror(
  integrationId: string,
  provider: Provider,
  item: Omit<ItemUpsert, 'integrationId' | 'topicId' | 'source'> & { externalId: string },
): Promise<string> {
  const { externalId, ...fields } = item;
  const items = await models.getItemRepository();
  const account = { provider, accountId: `wb-http-${provider}` };
  await items.bulkUpsert(wid, [
    {
      ...fields,
      integrationId,
      topicId: null,
      source: {
        ...account,
        externalId,
        key: null,
        url: `https://example.test/${externalId}`,
        updatedAtSource: null,
        etag: null,
        hash: 'h-synced',
      },
    },
  ]);
  const stored = await items.findBySource(wid, { ...account, integrationId }, externalId);
  assert.ok(stored !== null);
  return stored.id;
}

before(async () => {
  api = await startApiHarness('todolist_items_write_back_http');
  models = await import('../../models/index.js');
  const { setCreateTransportForTests } =
    await import('../../classes/integration/TrackerIntegration.js');
  setCreateTransportForTests(() => recording);
  for (const who of ['owner', 'other'] as const) {
    token[who] = (await api.login(`wb-http-${who}@example.test`)).token;
    const user = await (
      await models.getUserRepository()
    ).findByEmail(`wb-http-${who}@example.test`);
    assert.ok(user);
    ids[who] = user.id;
  }
  const created = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Write back over HTTP' },
  });
  wid = (data(created) as { id: string }).id;
  await (await models.getMembershipRepository()).create(wid, { userId: ids.other, role: 'editor' });

  githubId = await connect('github', { owner: 'octo', ownerType: 'user' });
  jiraId = await connect('jira', { baseUrl: JIRA_SITE });
  const { shareIntegrations } = await import('../../testing/integrationFixtures.js');
  // Shared: the other editor sees their items (and may keep overrides of them).
  await shareIntegrations(wid, ids.owner, [githubId, jiraId]);
  issueId = await mirror(githubId, 'github', {
    kind: 'issue',
    title: 'Crash on start',
    status: 'open',
    statusRaw: 'open',
    externalId: 'I_issue12',
    props: { github: { repo: 'octo/hello', number: 12, state: 'open' } },
  });
  prId = await mirror(githubId, 'github', {
    kind: 'pr',
    title: 'Fix the crash',
    status: 'open',
    externalId: 'PR_13',
    props: { github: { repo: 'octo/hello', number: 13, state: 'open' } },
  });
  jiraItemId = await mirror(jiraId, 'jira', {
    kind: 'issue',
    title: 'Write the report',
    status: 'open',
    statusRaw: 'To Do',
    priority: 2,
    externalId: '10500',
  });
});

after(async () => {
  const { setCreateTransportForTests } =
    await import('../../classes/integration/TrackerIntegration.js');
  setCreateTransportForTests(null);
  await api.stop();
});

beforeEach(() => {
  sent.length = 0;
  routes = [];
});

describe('the provider half: its integration’s owner, read & write', () => {
  it('the owner’s edit: GitHub takes the title; the due date and priority are kept as overrides', async () => {
    on(
      'PATCH',
      ISSUE_URL,
      json(200, { number: 12, title: 'Crash on start (fixed)', state: 'open' }),
    );
    const res = await call('owner', 'PATCH', `/items/${issueId}`, {
      title: 'Crash on start (fixed)',
      dueAt: DUE,
      allDay: true,
      priority: 3,
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(lines(), [`PATCH ${ISSUE_URL}`]);
    assert.deepEqual(JSON.parse(sent[0]?.body ?? 'null'), { title: 'Crash on start (fixed)' });
    const item = data(res);
    assert.equal(item['title'], 'Crash on start (fixed)');
    assert.equal(item['dueAt'], DUE);
    assert.equal(item['allDay'], true);
    assert.equal(item['priority'], 3);
    assert.deepEqual(overrides(item), {
      title: null,
      status: null,
      dueAt: DUE,
      allDay: true,
      startAt: null,
      priority: 3,
    });
    assert.deepEqual(item['editing'], {
      origin: 'provider',
      providerFields: ['title', 'status'],
      overridableFields: ['dueAt', 'startAt', 'priority'],
      reachableStatuses: ['open', 'done', 'cancelled'],
      ownsIntegration: true,
      mode: 'read_write',
      canWriteProvider: true,
      needsGuestNotice: false,
    });
    // The source keeps what GitHub holds: the overrides are TodoList's only.
    const stored = await (await models.getItemRepository()).findById(wid, issueId);
    assert.deepEqual([stored?.dueAt, stored?.priority], [null, null]);
  });

  it('anyone else: 403 integration_not_owner for a provider field, with nothing sent', async () => {
    const res = await call('other', 'PATCH', `/items/${issueId}`, { title: 'Hijacked' });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body?.['code'], 'integration_not_owner');
    assert.deepEqual(lines(), []);
    // The view tells them so (and never the integration's mode).
    const view = data(await call('other', 'GET', `/items/${issueId}`));
    const editing = view['editing'] as Json;
    assert.deepEqual(
      [editing['ownsIntegration'], editing['mode'], editing['canWriteProvider']],
      [false, null, false],
    );
  });

  it('anyone else keeps overrides; an unchanged provider field is no write, so no refusal', async () => {
    const res = await call('other', 'PATCH', `/items/${issueId}`, {
      title: 'Crash on start (fixed)',
      priority: 1,
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(lines(), []);
    assert.equal(data(res)['priority'], 1);
  });

  it('a field edited at its source only: 409 {message, openIn}', async () => {
    for (const body of [{ note: 'mine' }, { containerId: null }, { endAt: LATER }]) {
      const res = await call('owner', 'PATCH', `/items/${issueId}`, body);
      assert.equal(res.status, 409, res.text);
      assert.deepEqual(res.body?.['openIn'], {
        provider: 'github',
        url: 'https://example.test/I_issue12',
      });
    }
    assert.deepEqual(lines(), []);
  });

  it('read-only: 409 integration_read_only with zero requests, and nothing of the edit is kept', async () => {
    const integrations = await models.getIntegrationRepository();
    await integrations.update(wid, githubId, { mode: 'read' });
    try {
      const res = await call('owner', 'PATCH', `/items/${issueId}`, {
        title: 'While read-only',
        priority: 0,
      });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'integration_read_only');
      assert.deepEqual(lines(), []);
      const stored = await (await models.getItemRepository()).findById(wid, issueId);
      assert.equal(stored?.title, 'Crash on start (fixed)');
      assert.equal(stored.overlay.overrides.priority, 1, 'the override is untouched');
      // The local half alone still works while read-only.
      const local = await call('owner', 'PATCH', `/items/${issueId}`, { priority: 0 });
      assert.equal(local.status, 200, local.text);
      assert.equal(data(local)['priority'], 0);
      const editing = data(local)['editing'] as Json;
      assert.deepEqual([editing['mode'], editing['canWriteProvider']], ['read', false]);
    } finally {
      await integrations.update(wid, githubId, { mode: 'read_write' });
    }
  });

  it('a write-back clears the written field’s override', async () => {
    await (
      await models.getItemRepository()
    ).setOverlay(wid, issueId, { overrides: { title: 'A stale local title' } });
    on('PATCH', ISSUE_URL, json(200, { number: 12, title: 'Crash, again', state: 'open' }));
    const res = await call('owner', 'PATCH', `/items/${issueId}`, { title: 'Crash, again' });
    assert.equal(res.status, 200, res.text);
    assert.equal(data(res)['title'], 'Crash, again');
    assert.equal(overrides(data(res))['title'], null);
  });

  it('a provider refusal carries its details: the fields refused, or what was written and not', async () => {
    const issue = `${JIRA_SITE}/rest/api/3/issue/10500`;
    on('GET', `${issue}/editmeta`, json(200, { fields: { summary: {} } }));
    const refused = await call('owner', 'PATCH', `/items/${jiraItemId}`, { dueAt: DUE });
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body?.['code'], 'field_not_writable');
    assert.deepEqual(refused.body['details'], {
      fields: ['dueAt'],
      openIn: { provider: 'jira', url: 'https://example.test/10500' },
    });
    assert.equal(typeof refused.body['message'], 'string');

    sent.length = 0;
    routes = [];
    on(
      'GET',
      `${issue}/editmeta`,
      json(200, { fields: { summary: {}, duedate: {}, priority: { allowedValues: [] } } }),
    );
    on(
      'GET',
      `${issue}/transitions?expand=transitions.fields`,
      json(200, {
        transitions: [{ id: '31', name: 'Finish', to: { statusCategory: { key: 'done' } } }],
      }),
    );
    on('PUT', issue, json(204));
    on('POST', `${issue}/transitions`, json(400, { errorMessages: ['A validator failed'] }));
    const partial = await call('owner', 'PATCH', `/items/${jiraItemId}`, {
      title: 'Ship the report',
      status: 'done',
    });
    assert.equal(partial.status, 409, partial.text);
    assert.equal(partial.body?.['code'], 'provider_partial_write');
    assert.deepEqual(partial.body['details'], {
      written: ['title'],
      refused: ['status'],
      uncertain: [],
    });
    // Jira lacks a start date: it is kept here, by anyone who sees the item.
    sent.length = 0;
    const start = await call('other', 'PATCH', `/items/${jiraItemId}`, { startAt: DUE });
    assert.equal(start.status, 200, start.text);
    assert.deepEqual(lines(), []);
    assert.equal(data(start)['startAt'], DUE);
  });
});

describe('the local half and the effective values on every read', () => {
  it('a pull request takes no write-back: everything is an override, from any editor', async () => {
    const res = await call('other', 'PATCH', `/items/${prId}`, {
      title: 'Fix the crash (my name for it)',
      status: 'done',
      dueAt: LATER,
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(lines(), []);
    const item = data(res);
    assert.deepEqual(
      [item['title'], item['status'], item['dueAt']],
      ['Fix the crash (my name for it)', 'done', LATER],
    );
    assert.deepEqual((item['editing'] as Json)['providerFields'], []);
  });

  it('the list filters, sorts and pages by the effective values', async () => {
    const done = data(await call('owner', 'GET', '/items?status=done&provider=github'));
    assert.deepEqual(
      (done['items'] as Json[]).map((item) => item['id']),
      [prId],
    );
    const window = data(
      await call(
        'owner',
        'GET',
        `/items?dueFrom=${encodeURIComponent('2026-11-26T00:00:00.000Z')}&dueTo=${encodeURIComponent('2026-11-28T00:00:00.000Z')}`,
      ),
    );
    assert.deepEqual(
      (window['items'] as Json[]).map((item) => item['id']),
      [prId],
    );
    // By due date: the issue's (an override, the 20th) before the pull request's (the 27th).
    const first = data(await call('owner', 'GET', '/items?provider=github&limit=1'));
    const firstIds = (first['items'] as Json[]).map((item) => item['id']);
    const second = data(
      await call(
        'owner',
        'GET',
        `/items?provider=github&limit=1&cursor=${encodeURIComponent(String(first['nextCursor']))}`,
      ),
    );
    assert.deepEqual(
      [...firstIds, ...(second['items'] as Json[]).map((item) => item['id'])],
      [issueId, prId],
    );
  });

  it('the facets offer the statuses the items read as', async () => {
    const facets = data(await call('owner', 'GET', '/facets'));
    assert.ok((facets['statuses'] as string[]).includes('done'));
  });

  it('the query builder filters and groups by the effective values', async () => {
    const filtered = data(
      await call('owner', 'POST', '/query', {
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [
              { field: 'source.provider', operator: '=', value: 'github' },
              { field: 'status', operator: '=', value: 'done' },
            ],
          },
        },
      }),
    );
    assert.deepEqual(
      (filtered['rows'] as Json[]).map((row) => [row['id'], row['title'], row['status']]),
      [[prId, 'Fix the crash (my name for it)', 'done']],
    );
    const grouped = data(
      await call('owner', 'POST', '/query', {
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'source.provider', operator: '=', value: 'github' }],
          },
          groupBy: ['status'],
          aggregate: { op: 'count' },
        },
      }),
    );
    const counts = Object.fromEntries(
      (grouped['groups'] as Json[]).map((group) => [
        String((group['key'] as Json)['status']),
        group['value'],
      ]),
    );
    assert.deepEqual(counts, { open: 1, done: 1 });
  });

  it('an override set to the provider’s value clears it; null clears it too', async () => {
    const back = await call('other', 'PATCH', `/items/${prId}`, { status: 'open', dueAt: null });
    assert.equal(back.status, 200, back.text);
    const item = data(back);
    assert.deepEqual([item['status'], item['dueAt']], ['open', null]);
    assert.deepEqual([overrides(item)['status'], overrides(item)['dueAt']], [null, null]);
  });
});
