/**
 * The read-only switch for Google Calendar, end to end against the mock Google: a new connection
 * is read-only (Google's hard-coded read & write is gone), and while it is, no entry point sends
 * Google anything but a read (zero non-GET requests): an event created from a to-do, the
 * confirmed push over REST, MCP sync_to_google_calendar and the scheduled `gcal-run` job (which
 * skips it, as the dispatch does). Dry runs still answer. After its owner switches it to read &
 * write, each of them writes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import {
  pointAppAtMockGoogle,
  startMockGoogle,
  type MockGoogle,
} from '../../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000077', email: 'alice.readonly@example.test' };

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let token: string;
let ownerId: string;
let wid: string;
let iid = '';
let agentKey: string;
let requests = 0;
const clients: Client[] = [];

const W = (): string => `/api/private/workspaces/${wid}`;
const requestId = (): string => `gro-${String(Date.now())}-${String((requests += 1))}`;

/** What Google was sent that is not a read. */
const writes = (): string[] =>
  mock
    .requests()
    .filter((request) => request.method !== 'GET')
    .map((request) => `${request.method} ${request.path}`);

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_read_only_calendar');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../../models/index.js');
  token = (await api.login('gro-owner@example.test')).token;
  ownerId = data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Calendar', slug: `gro-${randomUUID().slice(0, 8)}`, ownerId })
  ).id;
  await (await models.getMembershipRepository()).create(wid, { userId: ownerId, role: 'owner' });
  iid = await connect();
  for (const [title, days] of [
    ['Dentist', 2],
    ['Gym', 3],
  ] as const) {
    const created = await api.call('POST', `${W()}/items`, {
      token,
      body: { title, dueAt: new Date(Date.now() + days * 86_400_000).toISOString() },
    });
    assert.equal(created.status, 201, created.text);
  }
  const { insertAgentKey } = await import('../../mcp/__tests__/helpers/agentKeys.js');
  agentKey = (
    await insertAgentKey({ workspaceId: wid, userId: ownerId, scopes: ['read', 'gcal:write'] })
  ).raw;
});

after(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  await api.stop();
  await mock.close();
  guard.restore();
});

async function connect(): Promise<string> {
  const started = await fetch(`${api.baseUrl}${W()}/integrations/google-calendar/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  const cookie = /todolist_oauth=[A-Za-z0-9_-]{43}/.exec(
    started.headers.get('set-cookie') ?? '',
  )?.[0];
  assert.ok(cookie !== undefined);
  const { authorizeUrl } = ((await started.json()) as { data: { authorizeUrl: string } }).data;
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  const landed = await fetch(authorized.headers.get('location') ?? '', {
    redirect: 'manual',
    headers: { cookie },
  });
  const connected = /connected=([0-9a-f-]{36})/.exec(landed.headers.get('location') ?? '');
  assert.ok(connected, landed.headers.get('location') ?? '');
  return connected[1] ?? '';
}

async function event(): Promise<ReturnType<ApiHarness['call']>> {
  const created = await api.call('POST', `${W()}/items`, {
    token,
    body: { title: 'Flight', dueAt: '2026-11-21T09:00:00.000Z', allDay: true },
  });
  assert.equal(created.status, 201, created.text);
  return api.call('POST', `${W()}/items/${data(created.body)['id'] as string}/copies`, {
    token,
    body: {
      requestId: requestId(),
      integrationId: iid,
      target: { provider: 'google_calendar', calendarId: ALICE.email },
    },
  });
}

const push = (confirm: boolean): ReturnType<ApiHarness['call']> =>
  api.call('POST', `${W()}/gcal-sync`, { token, body: { integrationId: iid, confirm } });

async function tool(args: Json): Promise<CallToolResult> {
  const transport = new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${agentKey}` } },
  });
  const client = new Client({ name: 'todolist-read-only-test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client.callTool({ name: 'sync_to_google_calendar', arguments: args });
}

const errorText = (result: CallToolResult): string => {
  const [first] = result.content as { type: string; text?: string }[];
  return first?.text ?? '';
};

const pushRuns = async (): Promise<number> =>
  (await (await models.getSyncRunRepository()).listForIntegration(wid, iid, 50)).filter(
    (run) => run.trigger === 'calendar_push',
  ).length;

describe('Google Calendar while read-only', () => {
  it('a new connection is read-only', async () => {
    const stored = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.equal(stored?.mode, 'read');
  });

  it('an event from a to-do: 409 integration_read_only, nothing written', async () => {
    const before = writes();
    const refused = await event();
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body?.['code'], 'integration_read_only');
    assert.deepEqual(writes(), before);
    assert.deepEqual(mock.events(ALICE.email), []);
  });

  it('REST gcal-sync: the dry run answers; the confirmed push is 409 before any run', async () => {
    const before = writes();
    const dry = await push(false);
    assert.equal(dry.status, 200, dry.text);
    // The dated to-dos (two, and the flight of the test before), none pushed yet.
    assert.deepEqual(data(dry.body)['counts'], { create: 3, update: 0, remove: 0 });
    const refused = await push(true);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body?.['code'], 'integration_read_only');
    assert.deepEqual(writes(), before);
    assert.equal(await pushRuns(), 0);
    assert.deepEqual(mock.events(ALICE.email), []);
  });

  it('MCP sync_to_google_calendar: the dry run answers; a real push is refused', async () => {
    const before = writes();
    const dry = await tool({});
    assert.equal(dry.isError, undefined, errorText(dry));
    assert.equal((dry.structuredContent as { dryRun: boolean }).dryRun, true);
    const refused = await tool({ dryRun: false });
    assert.equal(refused.isError, true);
    assert.match(errorText(refused), /read-only/);
    assert.deepEqual(writes(), before);
    assert.equal(await pushRuns(), 0);
  });

  it('the gcal-run job and the dispatch skip it', async () => {
    const before = writes();
    const { listGcalScheduleTargets, runScheduledGcalSync } =
      await import('../../gcal/scheduledSync.js');
    assert.deepEqual(await runScheduledGcalSync(iid), { ran: false, reason: 'not_eligible' });
    assert.ok(!(await listGcalScheduleTargets()).some((target) => target.id === iid));
    assert.deepEqual(writes(), before);
    assert.equal(await pushRuns(), 0);
  });
});

describe('Google Calendar after its owner switches it to read & write', () => {
  it('each entry point writes', async () => {
    const switched = await api.call('PATCH', `${W()}/integrations/${iid}`, {
      token,
      body: { mode: 'read_write' },
    });
    assert.equal(switched.status, 200, switched.text);

    const created = await event();
    assert.equal(created.status, 200, created.text);
    assert.equal(data(created.body)['status'], 'created');
    assert.ok(writes().some((line) => line.startsWith('POST ')));

    const pushed = await push(true);
    assert.equal(pushed.status, 202, pushed.text);
    assert.equal(await pushRuns(), 1);
    assert.ok(mock.events(ALICE.email).length >= 3, 'the event and both pushed items');

    const viaAgent = await tool({ dryRun: false });
    assert.equal(viaAgent.isError, undefined, errorText(viaAgent));
    assert.equal(await pushRuns(), 2);

    const { runScheduledGcalSync } = await import('../../gcal/scheduledSync.js');
    const scheduled = await runScheduledGcalSync(iid);
    assert.equal(scheduled.ran, true);
    assert.equal(await pushRuns(), 3);
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
