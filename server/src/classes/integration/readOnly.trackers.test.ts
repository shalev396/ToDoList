/**
 * The read-only switch for a to-do integration, end to end against the in-process mock providers:
 * a new connection is read-only, and while it is, neither "Also create in" over REST nor MCP
 * create_todo with targets sends the provider anything but a read (zero non-GET requests); its
 * owner switches it to read & write (PATCH {mode}, audited as `integration.mode` with the address)
 * and the same create goes through; switched back, it is blocked again with the message. Only its
 * owner switches it, demo data never becomes writable, and MCP never sees the mode.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import {
  pointAppAtMockOAuth,
  startMockOAuth,
  type MockOAuth,
} from '../../testing/mockOAuthProviders.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let api: ApiHarness;
let mock: MockOAuth;
let models: typeof Models;
let token: string;
let editorToken: string;
let ownerId: string;
let wid: string;
let iid: string;
let agentKey: string;
let requests = 0;
const clients: Client[] = [];

const W = (): string => `/api/private/workspaces/${wid}`;
const TARGET = { provider: 'clickup', listId: '90200' };
const requestId = (): string => `ro-${String(Date.now())}-${String((requests += 1))}`;

/** What the provider stand-in was sent that is not a read (the authorize page aside). */
const writes = (): string[] =>
  mock
    .requests()
    .filter((request) => request.method !== 'GET')
    .map((request) => `${request.method} ${request.path}`);

before(async () => {
  mock = await startMockOAuth({ port: 0 });
  api = await startApiHarness('todolist_read_only_trackers');
  await pointAppAtMockOAuth(mock, api.baseUrl);
  models = await import('../../models/index.js');
  const login = await api.login('ro-owner@example.test');
  token = login.token;
  ownerId = data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Read only', slug: `ro-${randomUUID().slice(0, 8)}`, ownerId })
  ).id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ownerId, role: 'owner' });
  const editor = await api.login('ro-editor@example.test');
  editorToken = editor.token;
  const editorId = data((await api.call('GET', '/api/private/me', { token: editorToken })).body)[
    'id'
  ] as string;
  await memberships.create(wid, { userId: editorId, role: 'editor' });
  iid = await connect();

  const { insertAgentKey } = await import('../../mcp/__tests__/helpers/agentKeys.js');
  agentKey = (
    await insertAgentKey({
      workspaceId: wid,
      userId: ownerId,
      scopes: ['read', 'integrations:read', 'items:write', 'providers:create'],
    })
  ).raw;
});

after(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  await api.stop();
  await mock.close();
});

/** ClickUp through the whole OAuth flow (it needs no extra write scope); the integration id. */
async function connect(): Promise<string> {
  const response = await fetch(`${api.baseUrl}${W()}/integrations/oauth/clickup/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
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
    `${api.baseUrl}/api/public/oauth/clickup/callback?${query.toString()}`,
    { redirect: 'manual', headers: { cookie: `todolist_oauth=${nonce}` } },
  );
  const connected = /connected=([\w-]+)/.exec(callback.headers.get('location') ?? '');
  assert.ok(connected, callback.headers.get('location') ?? '');
  return connected[1] ?? '';
}

async function todo(): Promise<string> {
  const created = await api.call('POST', `${W()}/items`, {
    token,
    body: { title: 'Write the report', dueAt: '2026-11-20T10:00:00.000Z' },
  });
  assert.equal(created.status, 201, created.text);
  return data(created.body)['id'] as string;
}

const copy = (todoId: string): ReturnType<ApiHarness['call']> =>
  api.call('POST', `${W()}/items/${todoId}/copies`, {
    token,
    body: { requestId: requestId(), integrationId: iid, target: TARGET },
  });

const setMode = (mode: string, as = token): ReturnType<ApiHarness['call']> =>
  api.call('PATCH', `${W()}/integrations/${iid}`, { token: as, body: { mode } });

async function tool(name: string, args: Json): Promise<CallToolResult> {
  const transport = new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${agentKey}` } },
  });
  const client = new Client({ name: 'todolist-read-only-test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client.callTool({ name, arguments: args });
}

interface ProviderCopy {
  integrationId: string;
  status: string;
  reason: string | null;
}

const providerCopies = (result: CallToolResult): ProviderCopy[] =>
  (result.structuredContent as { providerCopies?: ProviderCopy[] }).providerCopies ?? [];

describe('a to-do integration while read-only', () => {
  it('a new connection is read-only: the view says so and its chip is not writable', async () => {
    const list = await api.call('GET', `${W()}/integrations`, { token });
    const view = (list.body?.['data'] as Json[]).find((entry) => entry['id'] === iid);
    assert.equal(view?.['mode'], 'read');
    const targets = data((await api.call('GET', `${W()}/provider-create/targets`, { token })).body)[
      'targets'
    ] as Json[];
    assert.deepEqual(
      targets.map((target) => [target['integrationId'], target['writable'], target['mode']]),
      [[iid, false, 'read']],
    );
  });

  it('REST "Also create in": 409 integration_read_only, nothing recorded, nothing written', async () => {
    const before = writes();
    const id = await todo();
    const refused = await copy(id);
    assert.equal(refused.status, 409, refused.text);
    const answer = refused.body ?? {};
    assert.equal(answer['code'], 'integration_read_only');
    assert.match(String(answer['message']), /read-only/);
    const options = await api.call(
      'GET',
      `${W()}/integrations/${iid}/create-options?step=workspace`,
      { token },
    );
    assert.equal(options.status, 409, options.text);
    assert.equal(options.body?.['code'], 'integration_read_only');
    const stored = await (await models.getItemRepository()).findById(wid, id);
    assert.deepEqual(stored?.copies, []);
    assert.deepEqual(writes(), before);
    assert.equal(mock.created('clickup').count, 0);
  });

  it('MCP create_todo with targets: the target fails as integration_read_only, nothing written', async () => {
    const before = writes();
    const result = await tool('create_todo', {
      title: 'From an agent',
      targets: [{ integrationId: iid, target: TARGET }],
      confirm: true,
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(providerCopies(result), [
      {
        integrationId: iid,
        status: 'failed',
        key: null,
        url: null,
        reason: 'integration_read_only',
      },
    ]);
    assert.deepEqual(writes(), before);
    assert.equal(mock.created('clickup').count, 0);
  });

  it('an edit of its item (REST PATCH, MCP update_todo): 409 integration_read_only, nothing sent', async () => {
    const integration = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.ok(integration);
    const account = { provider: 'clickup' as const, accountId: integration.accountId };
    const items = await models.getItemRepository();
    await items.bulkUpsert(wid, [
      {
        integrationId: iid,
        kind: 'task',
        topicId: null,
        title: 'Synced task',
        status: 'open',
        source: {
          ...account,
          externalId: 'ro-task-1',
          key: null,
          url: 'https://app.clickup.com/t/ro-task-1',
          updatedAtSource: null,
          etag: null,
          hash: 'h',
        },
      },
    ]);
    const item = await items.findBySource(wid, { ...account, integrationId: iid }, 'ro-task-1');
    assert.ok(item);
    const before = writes();
    const refused = await api.call('PATCH', `${W()}/items/${item.id}`, {
      token,
      body: { title: 'Renamed while read-only' },
    });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body?.['code'], 'integration_read_only');
    const viaAgent = await tool('update_todo', {
      id: item.id,
      title: 'Renamed by an agent',
      confirm: true,
    });
    assert.equal(viaAgent.isError, true);
    // The read-only gate answers (MCP sends ReadOnlyIntegrationError's text, not the code).
    assert.match(
      JSON.stringify(viaAgent.content),
      /This integration is read-only: its owner can switch it/,
    );
    assert.deepEqual(writes(), before);
    assert.equal((await items.findById(wid, item.id))?.title, 'Synced task');
  });

  it('MCP never sees the mode', async () => {
    const result = await tool('integrations_list', {});
    const [listed] = (result.structuredContent as { integrations: Json[] }).integrations;
    assert.ok(listed);
    assert.equal('mode' in listed, false);
  });
});

describe('the switch', () => {
  it('only the integration’s owner switches it (anyone else: 404)', async () => {
    const other = await setMode('read_write', editorToken);
    assert.equal(other.status, 404, other.text);
    const invalid = await setMode('write');
    assert.equal(invalid.status, 400, invalid.text);
  });

  it('read & write: the same creates go through, and the switch is audited with the address', async () => {
    const switched = await setMode('read_write');
    assert.equal(switched.status, 200, switched.text);
    assert.equal(data(switched.body)['mode'], 'read_write');
    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.mode' }, 5);
    assert.ok(entry);
    assert.equal(entry.targetId, iid);
    assert.deepEqual(entry.meta, { from: 'read', to: 'read_write' });
    assert.equal(typeof entry.ip, 'string');
    assert.equal(typeof entry.userAgent, 'string');

    const before = writes().length;
    const created = await copy(await todo());
    assert.equal(created.status, 200, created.text);
    assert.equal(data(created.body)['status'], 'created');
    assert.equal(mock.created('clickup').count, 1);
    assert.ok(writes().length > before, 'the create was sent');

    const result = await tool('create_todo', {
      title: 'From an agent, now writable',
      targets: [{ integrationId: iid, target: TARGET }],
      confirm: true,
    });
    assert.deepEqual(
      providerCopies(result).map((entry) => entry.status),
      ['created'],
    );
    assert.equal(mock.created('clickup').count, 2);
    const targets = data((await api.call('GET', `${W()}/provider-create/targets`, { token })).body)[
      'targets'
    ] as Json[];
    assert.deepEqual(
      targets.map((target) => [target['writable'], target['mode']]),
      [[true, 'read_write']],
    );
  });

  it('back to read-only: blocked again with the message, and the same mode twice is one entry', async () => {
    assert.equal((await setMode('read')).status, 200);
    assert.equal((await setMode('read')).status, 200);
    const entries = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.mode' }, 10);
    assert.deepEqual(
      entries.map((entry) => entry.meta),
      [
        { from: 'read_write', to: 'read' },
        { from: 'read', to: 'read_write' },
      ],
    );
    const before = writes();
    const refused = await copy(await todo());
    assert.equal(refused.status, 409, refused.text);
    assert.equal(
      refused.body?.['message'],
      'This integration is read-only: its owner can switch it to read & write',
    );
    assert.deepEqual(writes(), before);
    assert.equal(mock.created('clickup').count, 2);
  });

  it('demo data never becomes writable (400, and nothing of the request is saved)', async () => {
    const demo = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      connectedBy: ownerId,
      provider: 'linear',
      accountId: 'demo-linear',
      label: 'Demo Linear',
      authMethod: 'personal_api_key',
      topicId: null,
      demo: true,
    });
    const refused = await api.call('PATCH', `${W()}/integrations/${demo.id}`, {
      token,
      body: { mode: 'read_write' },
    });
    assert.equal(refused.status, 400, refused.text);
    // The view says so, so the switch is not offered (the chip's hint does not ask for it).
    const views = (await api.call('GET', `${W()}/integrations`, { token })).body?.[
      'data'
    ] as Json[];
    assert.equal(views.find((view) => view['id'] === demo.id)?.['canSwitchMode'], false);
    assert.equal(views.find((view) => view['id'] === iid)?.['canSwitchMode'], true);
    // All or nothing: a refused mode leaves the other fields of the same request unsaved.
    const both = await api.call('PATCH', `${W()}/integrations/${demo.id}`, {
      token,
      body: { label: 'Renamed demo', mode: 'read_write' },
    });
    assert.equal(both.status, 400, both.text);
    assert.equal(
      (await (await models.getIntegrationRepository()).findById(wid, demo.id))?.label,
      'Demo Linear',
    );
    assert.equal(
      (await (await models.getAuditLogRepository()).list(wid, { action: 'integration.update' }, 5))
        .length,
      0,
    );
    const same = await api.call('PATCH', `${W()}/integrations/${demo.id}`, {
      token,
      body: { mode: 'read' },
    });
    assert.equal(same.status, 200, same.text);
    assert.equal(
      (await (await models.getIntegrationRepository()).findById(wid, demo.id))?.mode,
      'read',
    );
  });
});
