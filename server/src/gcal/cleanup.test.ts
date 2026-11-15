/**
 * Taking back what TodoList added, on its owner's request and within a time budget (fix round 1:
 * I4, I5), end to end against the mock Google:
 * - an integration that is no longer the primary one still lists its pushed events
 *   (`pushedEvents`), and "Remove" (`POST …/remove-pushed`) deletes them through the write
 *   session, one step at least per call: out of time, 409 `cleanup_incomplete` with the progress,
 *   and the next call goes on; read-only is 409 with nothing sent;
 * - a disconnect with removeAdded that runs out of time answers 409 `cleanup_incomplete` and
 *   leaves the integration connected; the next call finishes and disconnects.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import { pointAppAtMockGoogle, startMockGoogle, type MockGoogle } from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';
import type { setCleanupBudgetForTests as SetBudget } from '../classes/integration/calendar/CalendarCleanup.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000066', email: 'alice.cleanup@example.test' };

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let setBudget: typeof SetBudget;
let token: string;
let wid: string;
let iid = '';

const W = (): string => `/api/private/workspaces/${wid}`;
const call = (method: string, path: string, body?: unknown): ReturnType<ApiHarness['call']> =>
  api.call(method, `${W()}${path}`, { token, ...(body === undefined ? {} : { body }) });

/** What Google was sent that is not a read. */
const writes = (): string[] =>
  mock
    .requests()
    .filter((request) => request.method !== 'GET' && request.path !== '/token')
    .map((request) => `${request.method} ${request.path}`);

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
  const id = /connected=([0-9a-f-]{36})/.exec(landed.headers.get('location') ?? '')?.[1];
  assert.ok(id !== undefined);
  return id;
}

const pushedEvents = async (): Promise<unknown> => {
  const list = (await call('GET', '/integrations')).body?.['data'];
  const found = Array.isArray(list)
    ? (list as Json[]).find((entry) => entry['id'] === iid)
    : undefined;
  return found?.['pushedEvents'];
};

const setMode = async (mode: 'read' | 'read_write'): Promise<void> => {
  const switched = await call('PATCH', `/integrations/${iid}`, { mode });
  assert.equal(switched.status, 200, switched.text);
};

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_cleanup');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  ({ setCleanupBudgetForTests: setBudget } =
    await import('../classes/integration/calendar/CalendarCleanup.js'));
  token = (await api.login('cleanup-owner@example.test')).token;
  const ownerId = data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Cleanup', slug: `cleanup-${randomUUID().slice(0, 8)}`, ownerId })
  ).id;
  await (await models.getMembershipRepository()).create(wid, { userId: ownerId, role: 'owner' });
  iid = await connect();
  await setMode('read_write');
  const chosen = await call('PUT', '/primary-calendar', {
    integrationId: iid,
    calendarId: ALICE.email,
  });
  assert.equal(chosen.status, 200, chosen.text);
  for (const days of [1, 2, 3]) {
    const made = await call('POST', '/items', {
      title: `To-do ${String(days)}`,
      dueAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    assert.equal(made.status, 201, made.text);
  }
  const pushed = await call('POST', '/gcal-sync', { integrationId: iid, confirm: true });
  assert.equal(pushed.status, 202, pushed.text);
  assert.equal(mock.events(ALICE.email).length, 3);
});

after(async () => {
  setBudget(null);
  await api.stop();
  await mock.close();
  guard.restore();
});

describe('"Remove" the events of an earlier workspace calendar', () => {
  it('after "Stop sending", the integration still lists its pushed events; nothing was deleted', async () => {
    const cleared = await call('DELETE', '/primary-calendar');
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(await pushedEvents(), 3);
    assert.equal(mock.events(ALICE.email).length, 3);
  });

  it('read-only: 409, nothing sent', async () => {
    await setMode('read');
    const before = writes();
    const refused = await call('POST', `/integrations/${iid}/remove-pushed`);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body?.['code'], 'integration_read_only');
    assert.deepEqual(writes(), before);
    await setMode('read_write');
  });

  it('out of time: one step per call, 409 cleanup_incomplete with the progress; then it finishes', async () => {
    setBudget(0);
    const first = await call('POST', `/integrations/${iid}/remove-pushed`);
    assert.equal(first.status, 409, first.text);
    const answer = first.body ?? {};
    assert.equal(answer['code'], 'cleanup_incomplete');
    assert.deepEqual(answer['progress'], {
      events: 1,
      calendars: 0,
      calendarsKept: 0,
      remaining: 2,
      skipped: 0,
      failed: 0,
    });
    assert.equal(mock.events(ALICE.email).length, 2);
    assert.equal(await pushedEvents(), 2);
    setBudget(null);
    const done = await call('POST', `/integrations/${iid}/remove-pushed`);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(data(done.body), { events: 2, remaining: 0, skipped: 0, failed: 0 });
    assert.equal(mock.events(ALICE.email).length, 0);
    assert.equal(await pushedEvents(), 0);
    const cleanups = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.cleanup' }, 10);
    assert.deepEqual(
      cleanups.map((entry) => entry.meta),
      [
        { events: 2, calendars: 0, calendarsKept: 0, remaining: 0, skipped: 0, failed: 0 },
        { events: 1, calendars: 0, calendarsKept: 0, remaining: 2, skipped: 0, failed: 0 },
      ],
    );
  });

  it('another provider is 400', async () => {
    const jira = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      connectedBy: data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string,
      provider: 'jira',
      accountId: 'cleanup.atlassian.net',
      label: 'Jira',
      authMethod: 'api_token_basic',
      topicId: null,
      config: { baseUrl: 'https://cleanup.atlassian.net' },
      status: 'active',
      lastError: null,
    });
    const refused = await call('POST', `/integrations/${jira.id}/remove-pushed`);
    assert.equal(refused.status, 400, refused.text);
  });
});

describe('a disconnect whose clean-up runs out of time', () => {
  it('answers 409 cleanup_incomplete and stays connected; the next call finishes and disconnects', async () => {
    // Pushed again, so there is something to take back.
    const chosen = await call('PUT', '/primary-calendar', {
      integrationId: iid,
      newCalendarName: 'TodoList',
    });
    assert.equal(chosen.status, 200, chosen.text);
    const created = data(chosen.body)['calendarId'] as string;
    const pushed = await call('POST', '/gcal-sync', { integrationId: iid, confirm: true });
    assert.equal(pushed.status, 202, pushed.text);
    assert.equal(mock.events(created).length, 3);

    setBudget(0);
    const first = await call('DELETE', `/integrations/${iid}?removeAdded=true`);
    assert.equal(first.status, 409, first.text);
    const answer = first.body ?? {};
    assert.equal(answer['code'], 'cleanup_incomplete');
    assert.deepEqual(answer['progress'], {
      events: 1,
      calendars: 0,
      calendarsKept: 0,
      remaining: 3,
      skipped: 0,
      failed: 0,
    });
    const still = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.equal(still?.deletedAt, null, 'still connected');

    // Google refuses the next delete for good (no permission): it is counted, no longer tracked,
    // and the call goes on to the next one instead of stopping there for ever.
    mock.failNextWrite(403);
    const refused = await call('DELETE', `/integrations/${iid}?removeAdded=true`);
    assert.equal(refused.status, 409, refused.text);
    assert.deepEqual(refused.body?.['progress'], {
      events: 0,
      calendars: 0,
      calendarsKept: 0,
      remaining: 2,
      skipped: 0,
      failed: 1,
    });
    const writes = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.write' }, 5);
    assert.equal(writes[0]?.meta['outcome'], 'refused');

    setBudget(null);
    const done = await call('DELETE', `/integrations/${iid}?removeAdded=true`);
    assert.equal(done.status, 204, done.text);
    // The refused event is still in Google, but it is this integration's own push (its link row
    // stays until the links are removed), so the calendar TodoList made holds nothing else.
    assert.deepEqual(
      mock.createdCalendars().map((calendar) => calendar.id),
      [],
      'the calendar TodoList made (holding only its own pushes) is gone',
    );
    const gone = await (await models.getIntegrationRepository()).findIncludingDeleted(wid, iid);
    assert.ok(gone?.deletedAt instanceof Date);
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
