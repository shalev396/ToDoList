/**
 * A clean-up never touches the CURRENT workspace calendar (fix round 2, R1), end to end against
 * the mock Google:
 * - on the primary integration itself: "Remove" leaves the current calendar's events alone (they
 *   are skipped, never counted as leftovers); only an earlier calendar's are leftovers;
 * - two integrations of one workspace pushing into one shared calendar (two owners, the same
 *   Google account): the old one's "Remove" and its disconnect with "Also remove" leave that
 *   calendar and its events alone, and the new one's next pull soft-deletes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import { pointAppAtMockGoogle, startMockGoogle, type MockGoogle } from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000077', email: 'alice.current@example.test' };

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let first: string;
let second: string;
let wid: string;
let ia = '';
let ib = '';
let calendar = '';
const items: string[] = [];

const call = (
  token: string,
  method: string,
  path: string,
  body?: unknown,
): ReturnType<ApiHarness['call']> =>
  api.call(method, `/api/private/workspaces/${wid}${path}`, {
    token,
    ...(body === undefined ? {} : { body }),
  });

async function connect(token: string): Promise<string> {
  const started = await fetch(
    `${api.baseUrl}/api/private/workspaces/${wid}/integrations/google-calendar/oauth/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    },
  );
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
  const switched = await call(token, 'PATCH', `/integrations/${id}`, { mode: 'read_write' });
  assert.equal(switched.status, 200, switched.text);
  return id;
}

async function push(token: string, integrationId: string): Promise<void> {
  const pushed = await call(token, 'POST', '/gcal-sync', { integrationId, confirm: true });
  assert.equal(pushed.status, 202, pushed.text);
}

async function pushedEvents(token: string, integrationId: string): Promise<unknown> {
  const list = (await call(token, 'GET', '/integrations')).body?.['data'];
  const found = Array.isArray(list)
    ? (list as Json[]).find((entry) => entry['id'] === integrationId)
    : undefined;
  return found?.['pushedEvents'];
}

const eventCount = (): number => mock.events(calendar).length;

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_cleanup_current');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  first = (await api.login('current-first@example.test')).token;
  second = (await api.login('current-second@example.test')).token;
  const idOf = async (token: string): Promise<string> =>
    data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  const firstId = await idOf(first);
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Current', slug: `current-${randomUUID().slice(0, 8)}`, ownerId: firstId })
  ).id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: firstId, role: 'owner' });
  await memberships.create(wid, { userId: await idOf(second), role: 'owner' });

  ia = await connect(first);
  const chosen = await call(first, 'PUT', '/primary-calendar', {
    integrationId: ia,
    newCalendarName: 'TodoList',
  });
  assert.equal(chosen.status, 200, chosen.text);
  calendar = data(chosen.body)['calendarId'] as string;
  for (const days of [1, 2]) {
    const made = await call(first, 'POST', '/items', {
      title: `To-do ${String(days)}`,
      dueAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    assert.equal(made.status, 201, made.text);
    items.push(data(made.body)['id'] as string);
  }
  await push(first, ia);
  assert.equal(eventCount(), 2);
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

describe('the primary integration’s own events', () => {
  it('are no leftovers, and "Remove" skips them', async () => {
    assert.equal(await pushedEvents(first, ia), 0);
    const removed = await call(first, 'POST', `/integrations/${ia}/remove-pushed`);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(data(removed.body), { events: 0, remaining: 0, skipped: 2, failed: 0 });
    assert.equal(eventCount(), 2, 'the current calendar is untouched');
  });

  it('an earlier calendar’s events are leftovers once the primary calendar moves', async () => {
    const moved = await call(first, 'PUT', '/primary-calendar', {
      integrationId: ia,
      calendarId: ALICE.email,
    });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(await pushedEvents(first, ia), 2);
    const back = await call(first, 'PUT', '/primary-calendar', {
      integrationId: ia,
      calendarId: calendar,
    });
    assert.equal(back.status, 200, back.text);
    assert.equal(await pushedEvents(first, ia), 0);
  });
});

describe('two integrations of one workspace on one shared calendar', () => {
  it('the second owner makes the same calendar primary on their integration and pushes', async () => {
    ib = await connect(second);
    const chosen = await call(second, 'PUT', '/primary-calendar', {
      integrationId: ib,
      calendarId: calendar,
    });
    assert.equal(chosen.status, 200, chosen.text);
    const made = await call(second, 'POST', '/items', {
      title: 'The second owner’s to-do',
      dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    assert.equal(made.status, 201, made.text);
    items.push(data(made.body)['id'] as string);
    await push(second, ib);
    // The first two are adopted (same event ids), the third is new.
    assert.equal(eventCount(), 3);
  });

  it('the old integration’s "Remove" leaves the current calendar alone', async () => {
    // One tracker per event: the new integration's adopting push took over the old one's links.
    const links = await models.getCalendarLinkRepository();
    assert.deepEqual(await links.listLive(wid, ia), []);
    assert.equal(await pushedEvents(first, ia), 0);
    const removed = await call(first, 'POST', `/integrations/${ia}/remove-pushed`);
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(data(removed.body), { events: 0, remaining: 0, skipped: 0, failed: 0 });
    assert.equal(eventCount(), 3);
  });

  it('its disconnect with "Also remove" keeps the calendar and its events', async () => {
    const removed = await call(first, 'DELETE', `/integrations/${ia}?removeAdded=true`);
    assert.equal(removed.status, 200, removed.text);
    assert.ok(
      mock.createdCalendars().some((entry) => entry.id === calendar),
      'the current workspace calendar is never deleted',
    );
    assert.equal(eventCount(), 3);
    const cleanups = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.cleanup' }, 5);
    assert.deepEqual(cleanups[0]?.meta, {
      events: 0,
      calendars: 0,
      calendarsKept: 1,
      remaining: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('the new integration’s next pull soft-deletes nothing', async () => {
    await push(second, ib);
    const repo = await models.getItemRepository();
    for (const id of items) {
      assert.equal((await repo.findById(wid, id))?.deletedAt, null, id);
    }
    assert.equal(eventCount(), 3);
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
