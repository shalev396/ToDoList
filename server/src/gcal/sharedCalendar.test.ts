/**
 * Two integrations of one workspace taking turns on one shared calendar (two owners, the same
 * Google account), end to end against the mock Google (fix round 3, R2: the re-review's probe).
 * Event ids are per item, so a create adopts the other integration's event: one tracker per event
 * (the commit drops the other integration's link) keeps a later move or clean-up by one from being
 * read as a Google-side delete by the other.
 * - a push move only, no clean-up: IA on C, IB on C, IA on D, IB on C again;
 * - the primary integration's own disconnect with "Also remove", then the other one back on C.
 * In both, no owner's to-do is soft-deleted and no other member's item is held back.
 * - the in-flight race (re-review 3's probe P4): IB's push adopts IA's event; meanwhile the primary
 *   moves away and IA's owner presses Remove, deleting the event; then IB's commit lands, its pull
 *   reading the event cancelled. That cancellation is TodoList's own clean-up, not the user's: the
 *   to-do stays and IB's next push on the calendar makes the event again.
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
const ALICE = { sub: '100000000000000000078', email: 'alice.shared@example.test' };

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;

interface Team {
  wid: string;
  first: string;
  second: string;
  call: (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) => ReturnType<ApiHarness['call']>;
}

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_shared_calendar');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

/** A workspace with two owners. */
async function team(tag: string): Promise<Team> {
  const first = (await api.login(`shared-${tag}-1@example.test`)).token;
  const second = (await api.login(`shared-${tag}-2@example.test`)).token;
  const idOf = async (token: string): Promise<string> =>
    data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  const firstId = await idOf(first);
  const wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({
      name: `Shared ${tag}`,
      slug: `shared-${tag}-${randomUUID().slice(0, 8)}`,
      ownerId: firstId,
    })
  ).id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: firstId, role: 'owner' });
  await memberships.create(wid, { userId: await idOf(second), role: 'owner' });
  return {
    wid,
    first,
    second,
    call: (token, method, path, body) =>
      api.call(method, `/api/private/workspaces/${wid}${path}`, {
        token,
        ...(body === undefined ? {} : { body }),
      }),
  };
}

/** The member's Google Calendar (the shared account), read & write. */
async function connect(t: Team, token: string): Promise<string> {
  const started = await fetch(
    `${api.baseUrl}/api/private/workspaces/${t.wid}/integrations/google-calendar/oauth/start`,
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
  const switched = await t.call(token, 'PATCH', `/integrations/${id}`, { mode: 'read_write' });
  assert.equal(switched.status, 200, switched.text);
  return id;
}

async function primary(t: Team, token: string, body: Json): Promise<string> {
  const chosen = await t.call(token, 'PUT', '/primary-calendar', body);
  assert.equal(chosen.status, 200, chosen.text);
  return data(chosen.body)['calendarId'] as string;
}

async function push(t: Team, token: string, integrationId: string): Promise<void> {
  const pushed = await t.call(token, 'POST', '/gcal-sync', { integrationId, confirm: true });
  assert.equal(pushed.status, 202, pushed.text);
}

async function todo(t: Team, token: string, title: string, days: number): Promise<string> {
  const made = await t.call(token, 'POST', '/items', {
    title,
    dueAt: new Date(Date.now() + days * 86_400_000).toISOString(),
  });
  assert.equal(made.status, 201, made.text);
  return data(made.body)['id'] as string;
}

/** Every to-do is still there, and no live item is held back by a `google_kept` stop. */
async function nothingLost(
  t: Team,
  items: readonly string[],
  integrations: string[],
): Promise<void> {
  const repo = await models.getItemRepository();
  for (const id of items) assert.equal((await repo.findById(t.wid, id))?.deletedAt, null, id);
  const links = await models.getCalendarLinkRepository();
  for (const integrationId of integrations) {
    assert.deepEqual(await links.listKeptStops(t.wid, integrationId), [], integrationId);
  }
}

describe('shared calendar, a push move only (no clean-up)', () => {
  it('the second owner’s to-do survives the second integration coming back to the calendar', async () => {
    const t = await team('move');
    const ia = await connect(t, t.first);
    const ib = await connect(t, t.second);
    const c = await primary(t, t.first, { integrationId: ia, newCalendarName: 'Shared' });
    const items = [
      await todo(t, t.first, 'First owner’s to-do', 1),
      await todo(t, t.second, 'Second owner’s to-do', 2),
    ];
    await push(t, t.first, ia);
    assert.equal(mock.events(c).length, 2, 'IA pushed both');

    await primary(t, t.second, { integrationId: ib, calendarId: c });
    await push(t, t.second, ib);
    assert.equal(mock.events(c).length, 2, 'IB adopted both');
    // IB now tracks them: IA no longer does (one tracker per event).
    const links = await models.getCalendarLinkRepository();
    assert.deepEqual(await links.listLive(t.wid, ia), []);

    await primary(t, t.first, { integrationId: ia, calendarId: ALICE.email });
    await push(t, t.first, ia);
    // IA created on D only: C's events, IB's, stay.
    assert.equal(mock.events(c).length, 2);

    await primary(t, t.second, { integrationId: ib, calendarId: c });
    await push(t, t.second, ib);
    await nothingLost(t, items, [ia, ib]);
    assert.equal(mock.events(c).length, 2);
  });
});

describe('shared calendar, the primary integration’s own disconnect with "Also remove"', () => {
  it('the second owner’s to-do survives the second integration coming back to the calendar', async () => {
    const t = await team('exempt');
    const ia = await connect(t, t.first);
    const ib = await connect(t, t.second);
    const c = ALICE.email;
    await primary(t, t.first, { integrationId: ia, calendarId: c });
    const items = [await todo(t, t.second, 'Second owner’s exempt to-do', 5)];
    await push(t, t.first, ia);
    await primary(t, t.second, { integrationId: ib, calendarId: c });
    await push(t, t.second, ib);
    await primary(t, t.first, { integrationId: ia, calendarId: c });
    const gone = await t.call(t.first, 'DELETE', `/integrations/${ia}?removeAdded=true`);
    assert.equal(gone.status, 200, gone.text);
    // IA no longer tracked IB's events: it deleted none of them.
    assert.equal(data(gone.body)['events'], 0);

    await primary(t, t.second, { integrationId: ib, calendarId: c });
    await push(t, t.second, ib);
    await nothingLost(t, items, [ib]);
    assert.ok(mock.events(c).length >= 1);
  });
});

describe('shared calendar, a clean-up racing another integration’s push (probe P4)', () => {
  it('IB’s commit reads IA’s own delete as a clean-up: the to-do stays, the event comes back', async () => {
    const { applyCommit } = await import('../testing/calendarCalls.js');
    const { eventIdFor, opIdOf, ORIGIN } = await import('./diff.js');
    const t = await team('race');
    const ia = await connect(t, t.first);
    const ib = await connect(t, t.second);
    const c = await primary(t, t.first, { integrationId: ia, newCalendarName: 'Race' });
    const x = await todo(t, t.second, 'Second owner’s raced to-do', 1);
    await push(t, t.first, ia);
    const links = await models.getCalendarLinkRepository();
    const iaLink = await links.findByItem(t.wid, ia, x);
    assert.ok(iaLink !== null && iaLink.pushedHash !== null);

    // IB is made primary on C; its push reaches Google (the adopt: the event is live, unchanged)…
    await primary(t, t.second, { integrationId: ib, calendarId: c });
    const run = await (
      await models.getSyncRunRepository()
    ).create(t.wid, {
      integrationId: ib,
      trigger: 'calendar_push',
      status: 'running',
      startedAt: new Date(),
    });
    // …meanwhile an owner moves the primary to D and IA's owner presses Remove (IA's row is still
    // live, so IA deletes the event at Google and tombstones its row).
    await primary(t, t.first, { integrationId: ia, calendarId: ALICE.email });
    const removed = await t.call(t.first, 'POST', `/integrations/${ia}/remove-pushed`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(data(removed.body)['events'], 1);
    assert.equal(mock.events(c).length, 0, 'IA deleted the event');

    // …then IB's commit lands: its op result, and its pull, which read C after IA's delete. (Real
    // Google lists a cancelled event on a full listing too; the mock drops it there.)
    const ibData = await (await models.getIntegrationRepository()).findById(t.wid, ib);
    assert.ok(ibData !== null);
    const eventId = eventIdFor(x);
    await applyCommit(
      ibData,
      {
        runId: run.id,
        opResults: [
          { opId: opIdOf('create', x, iaLink.pushedHash), ok: true, eventId, etag: '"adopted"' },
        ],
        calendars: [
          {
            id: c,
            events: [
              {
                id: eventId,
                status: 'cancelled',
                etag: '"cancelled"',
                priv: { origin: ORIGIN, todolistWs: t.wid, todolistItemId: x },
              },
            ],
            nextSyncToken: null,
          },
        ],
      },
      new Date(),
      c,
    );
    // The to-do stays; IB's row goes (no stop is kept), so nothing holds the event back.
    await nothingLost(t, [x], [ia, ib]);
    assert.equal(await links.findByItem(t.wid, ib, x), null, 'IB no longer tracks the event');

    // IB is primary on C again and pushes: the event is made again, tracked by IB.
    await primary(t, t.second, { integrationId: ib, calendarId: c });
    await push(t, t.second, ib);
    await nothingLost(t, [x], [ia, ib]);
    assert.equal(mock.events(c).length, 1, 'the event is back');
    assert.equal((await links.findByItem(t.wid, ib, x))?.tombstonedAt, null);
  });

  it('a user’s own delete in Google, with no clean-up of that event, still deletes the to-do', async () => {
    const t = await team('user-delete');
    const ia = await connect(t, t.first);
    const c = await primary(t, t.first, { integrationId: ia, newCalendarName: 'Own' });
    const x = await todo(t, t.first, 'First owner’s to-do, deleted in Google', 1);
    await push(t, t.first, ia);
    assert.ok(mock.deleteEvent(c, (await import('./diff.js')).eventIdFor(x)));
    await push(t, t.first, ia);
    // A Google-side delete of the owner's own to-do: it is gone (soft-deleted), as before.
    assert.equal(await (await models.getItemRepository()).findById(t.wid, x), null);
    const link = await (await models.getCalendarLinkRepository()).findByItem(t.wid, ia, x);
    assert.equal(link?.deletedBy, 'google');
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
