/**
 * Two integrations of one workspace taking turns on one shared calendar (two owners, the same
 * Google account), end to end against the mock Google (fix round 3, R2: the re-review's probe).
 * Event ids are per item, so a create adopts the other integration's event: one tracker per event
 * (the commit drops the other integration's link) keeps a later move or clean-up by one from being
 * read as a Google-side delete by the other.
 * - a push move only, no clean-up: IA on C, IB on C, IA on D, IB on C again;
 * - the primary integration's own disconnect with "Also remove", then the other one back on C.
 * In both, no owner's to-do is soft-deleted and no other member's item is held back.
 * - a clean-up racing another integration's push (re-review 3's probe P4; phase 5's R1, R2, U1,
 *   U2, S1, W1 and O1): IB's push adopts IA's event while IA's owner presses Remove. IA claims
 *   (tombstones) its row before its DELETE and records when Google answers it, so IB's commit can't
 *   remove that row and sees the claim: IB drops its own link while the claim stands for its run
 *   (answered after the run was created, or unanswered and claimed at most a minute before it),
 *   whether its pull read the delete (P4), read C before it (R1), committed while the DELETE was in
 *   flight (R2), or the DELETE's answer was lost and a read settled it (U1, U2). No pull of IB reads
 *   TodoList's delete as the user's; IB's next push, created after the answer, makes the event
 *   again and tracks it at once, so a user's delete and the to-do's delete then count (W1, O1).
 *   IA's own push never revives IA's own claim (S1). A claim answered before IB's run, or one left
 *   unanswered for over a minute before it, is not this race; nor is a delete with no claim at all.
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

/** IA pushed the second owner's to-do X on C; IB is primary on C with a push run open. */
async function raced(tag: string): Promise<{
  t: Team;
  ia: string;
  ib: string;
  c: string;
  x: string;
  runId: string;
  ibData: Models.IntegrationData;
  iaLinkId: string;
  adopt: Json;
  cancelled: Json;
}> {
  const { eventIdFor, opIdOf, ORIGIN } = await import('./diff.js');
  const t = await team(tag);
  const ia = await connect(t, t.first);
  const ib = await connect(t, t.second);
  const c = await primary(t, t.first, { integrationId: ia, newCalendarName: `Race ${tag}` });
  const x = await todo(t, t.second, `Second owner’s raced to-do ${tag}`, 1);
  await push(t, t.first, ia);
  const iaLink = await (await models.getCalendarLinkRepository()).findByItem(t.wid, ia, x);
  assert.ok(iaLink !== null && iaLink.pushedHash !== null);
  // IB is made primary on C; its push runs (its adopt reaches Google: the event is live)…
  await primary(t, t.second, { integrationId: ib, calendarId: c });
  const run = await (
    await models.getSyncRunRepository()
  ).create(t.wid, { integrationId: ib, trigger: 'calendar_push', status: 'running' });
  const ibData = await (await models.getIntegrationRepository()).findById(t.wid, ib);
  assert.ok(ibData !== null);
  const eventId = eventIdFor(x);
  return {
    t,
    ia,
    ib,
    c,
    x,
    runId: run.id,
    ibData,
    iaLinkId: iaLink.id,
    adopt: { opId: opIdOf('create', x, iaLink.pushedHash), ok: true, eventId, etag: '"adopted"' },
    // Real Google lists a cancelled event on a full listing too; the mock drops it there, so a
    // pull's read of it is handed to the commit as Google would send it.
    cancelled: {
      id: eventId,
      status: 'cancelled',
      etag: '"cancelled"',
      priv: { origin: ORIGIN, todolistWs: t.wid, todolistItemId: x },
    },
  };
}

/** IB's commit: its op results and what its pull read of C. */
async function commitOf(
  r: Awaited<ReturnType<typeof raced>>,
  runId: string,
  opResults: Json[],
  events: Json[],
): Promise<void> {
  const { applyCommit } = await import('../testing/calendarCalls.js');
  await applyCommit(
    r.ibData,
    { runId, opResults, calendars: [{ id: r.c, events, nextSyncToken: null }] },
    new Date(),
    r.c,
  );
}

/** A later push run of IB (its next pull of C). */
async function nextRun(r: Awaited<ReturnType<typeof raced>>): Promise<string> {
  return (
    await (
      await models.getSyncRunRepository()
    ).create(r.t.wid, { integrationId: r.ib, trigger: 'calendar_push', status: 'running' })
  ).id;
}

/** IA's claim, set to stand where a test puts it: its tombstone and its answer, if any. */
async function setClaim(
  r: Awaited<ReturnType<typeof raced>>,
  claim: { tombstonedAt: Date; deleteAnsweredAt: Date | null },
): Promise<void> {
  const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
  await CalendarLinkMongoModel.updateOne({ _id: r.iaLinkId }, { $set: claim });
}

/** When IB's open push run was created (what a claim stands against). */
async function runCreatedAt(r: Awaited<ReturnType<typeof raced>>, runId: string): Promise<Date> {
  const run = await (await models.getSyncRunRepository()).findById(r.t.wid, runId);
  assert.ok(run !== null);
  return run.createdAt;
}

/** IA's owner moves the primary to D and presses Remove (its DELETE answered `delete`). */
async function iaRemovesWith(
  r: Awaited<ReturnType<typeof raced>>,
  status: number,
  body: (removed: Awaited<ReturnType<Team['call']>>) => void,
): Promise<void> {
  await primary(r.t, r.t.first, { integrationId: r.ia, calendarId: ALICE.email });
  const removed = await r.t.call(r.t.first, 'POST', `/integrations/${r.ia}/remove-pushed`);
  assert.equal(removed.status, status, removed.text);
  body(removed);
}

/** IA's owner moves the primary to D and presses Remove: IA's clean-up of its events on C. */
async function iaRemoves(r: Awaited<ReturnType<typeof raced>>): Promise<void> {
  await primary(r.t, r.t.first, { integrationId: r.ia, calendarId: ALICE.email });
  const removed = await r.t.call(r.t.first, 'POST', `/integrations/${r.ia}/remove-pushed`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(data(removed.body)['events'], 1);
  assert.equal(mock.events(r.c).length, 0, 'IA deleted the event');
}

describe('shared calendar, a clean-up racing another integration’s push', () => {
  it('P4: IB’s commit lands after IA’s Remove and its pull reads the delete: the to-do stays', async () => {
    const r = await raced('p4');
    await iaRemoves(r);
    await commitOf(r, r.runId, [r.adopt], [r.cancelled]);
    // The to-do stays; IB's row goes (no stop is kept), so nothing holds the event back.
    await nothingLost(r.t, [r.x], [r.ia, r.ib]);
    const links = await models.getCalendarLinkRepository();
    assert.equal(await links.findByItem(r.t.wid, r.ib, r.x), null, 'IB no longer tracks it');
    // IA's DELETE was answered after IB's run was created: that run's claim. IB's next push starts
    // after the answer: it makes the event again and tracks it at once.
    assert.ok((await links.findByItem(r.t.wid, r.ia, r.x))?.deleteAnsweredAt instanceof Date);
    await primary(r.t, r.t.second, { integrationId: r.ib, calendarId: r.c });
    await push(r.t, r.t.second, r.ib);
    await nothingLost(r.t, [r.x], [r.ia, r.ib]);
    assert.equal(mock.events(r.c).length, 1, 'the event is back');
    assert.equal((await links.findByItem(r.t.wid, r.ib, r.x))?.tombstonedAt, null, 'tracked');
  });

  it('R1: IB’s pull read C before IA’s Remove; its next pull, much later, keeps the to-do', async () => {
    const r = await raced('r1');
    await iaRemoves(r);
    // IB's commit: its adopt, and a pull that listed C before IA's delete (nothing for it).
    await commitOf(r, r.runId, [r.adopt], []);
    const links = await models.getCalendarLinkRepository();
    assert.equal(
      await links.findByItem(r.t.wid, r.ib, r.x),
      null,
      'IB doesn’t track a deleted event',
    );
    // Later, IB's next pull reads the cancellation: there is nothing of IB's to read it.
    await commitOf(r, await nextRun(r), [], [r.cancelled]);
    await nothingLost(r.t, [r.x], [r.ia, r.ib]);
  });

  it('R2: IB’s commit lands while IA’s DELETE is in flight; its next pull keeps the to-do', async () => {
    const r = await raced('r2');
    const links = await models.getCalendarLinkRepository();
    // IA's DELETE is held at Google while IB's commit (its adopt; its pull listed C before the
    // delete) lands: IA's row was claimed first, so IB's commit can't remove it, and sees it.
    let claimSeen: boolean | null = null;
    mock.holdNextWrite(async () => {
      const iaRow = await links.findByItem(r.t.wid, r.ia, r.x);
      claimSeen = iaRow?.deletedBy === 'dashboard' && iaRow.deleteAnsweredAt === null;
      await commitOf(r, r.runId, [r.adopt], []);
    });
    await iaRemoves(r);
    assert.equal(claimSeen, true, 'IA tombstoned its row before its DELETE, unanswered then');
    assert.equal((await links.findByItem(r.t.wid, r.ia, r.x))?.deletedBy, 'dashboard');
    assert.equal(await links.findByItem(r.t.wid, r.ib, r.x), null, 'IB doesn’t track it');
    // IB's next pull, at once, reads the cancellation.
    await commitOf(r, await nextRun(r), [], [r.cancelled]);
    await nothingLost(r.t, [r.x], [r.ia, r.ib]);
  });

  it('U1: IA’s DELETE is made but its answer lost; a read settles the claim; IB’s commit keeps the to-do', async () => {
    const r = await raced('u1');
    // Google applies the delete, then the answer is lost (a 5xx: the outcome is unknown).
    mock.holdNextWrite(() => {
      assert.ok(mock.deleteEvent(r.c, String(r.cancelled['id'])));
      mock.failNextWrite(503);
      return Promise.resolve();
    });
    await iaRemovesWith(r, 200, (removed) => {
      // The read showed it was made: the step is done, not "unknown".
      assert.equal(data(removed.body)['events'], 1);
    });
    const links = await models.getCalendarLinkRepository();
    const iaRow = await links.findByItem(r.t.wid, r.ia, r.x);
    assert.equal(iaRow?.deletedBy, 'dashboard', 'the claim is kept, never released blind');
    assert.ok(iaRow.deleteAnsweredAt instanceof Date, 'and settled by the read');
    await commitOf(r, r.runId, [r.adopt], [r.cancelled]);
    await nothingLost(r.t, [r.x], [r.ia, r.ib]);
    assert.equal(await links.findByItem(r.t.wid, r.ib, r.x), null);
  });

  it('U2: the same lost answer; IB’s pull read C before; its next pull keeps the to-do', async () => {
    const r = await raced('u2');
    mock.holdNextWrite(() => {
      assert.ok(mock.deleteEvent(r.c, String(r.cancelled['id'])));
      mock.failNextWrite(503);
      return Promise.resolve();
    });
    await iaRemovesWith(r, 200, () => undefined);
    await commitOf(r, r.runId, [r.adopt], []);
    const links = await models.getCalendarLinkRepository();
    assert.equal(await links.findByItem(r.t.wid, r.ib, r.x), null);
    await commitOf(r, await nextRun(r), [], [r.cancelled]);
    await nothingLost(r.t, [r.x], [r.ia, r.ib]);
  });

  it('S1: IA’s own push commit never revives its own clean-up claim: its owner’s to-do stays', async () => {
    const { eventIdFor, opIdOf, ORIGIN } = await import('./diff.js');
    const { applyCommit } = await import('../testing/calendarCalls.js');
    const t = await team('s1');
    const ia = await connect(t, t.first);
    const c = await primary(t, t.first, { integrationId: ia, newCalendarName: 'Own race' });
    const x = await todo(t, t.first, 'First owner’s own to-do s1', 1);
    await push(t, t.first, ia);
    // IA's push is in flight, an update of X on C planned while C was primary…
    const run = await (
      await models.getSyncRunRepository()
    ).create(t.wid, { integrationId: ia, trigger: 'calendar_push', status: 'running' });
    // …meanwhile the owner moves the primary to D and presses Remove: IA claims X's row on C and
    // deletes its event.
    await primary(t, t.first, { integrationId: ia, calendarId: ALICE.email });
    const removed = await t.call(t.first, 'POST', `/integrations/${ia}/remove-pushed`);
    assert.equal(removed.status, 200, removed.text);
    // IA's commit: its update landed before the DELETE, and its pull read the cancellation.
    const iaData = await (await models.getIntegrationRepository()).findById(t.wid, ia);
    assert.ok(iaData !== null);
    const eventId = eventIdFor(x);
    await applyCommit(
      iaData,
      {
        runId: run.id,
        opResults: [{ opId: opIdOf('update', x, '0123456789abcdef'), ok: true, eventId }],
        calendars: [
          {
            id: c,
            events: [
              {
                id: eventId,
                status: 'cancelled',
                etag: '"cx"',
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
    const row = await (await models.getCalendarLinkRepository()).findByItem(t.wid, ia, x);
    assert.equal(row?.deletedBy, 'dashboard', 'the claim stands: not revived by the update');
    await nothingLost(t, [x], [ia]);
  });

  it('W1, O1: a push that starts after the DELETE’s answer tracks at once: the user’s delete and the to-do’s delete count', async () => {
    const r = await raced('w1o1');
    await iaRemoves(r);
    await commitOf(r, r.runId, [r.adopt], [r.cancelled]);
    await primary(r.t, r.t.second, { integrationId: r.ib, calendarId: r.c });
    await push(r.t, r.t.second, r.ib);
    const links = await models.getCalendarLinkRepository();
    assert.equal((await links.findByItem(r.t.wid, r.ib, r.x))?.tombstonedAt, null, 'tracked');
    // O1: the to-do is deleted while tracked: its event goes with it.
    const y = await todo(r.t, r.t.second, 'Second owner’s to-do, deleted later', 2);
    await push(r.t, r.t.second, r.ib);
    const eventOfY = (await import('./diff.js')).eventIdFor(y);
    assert.ok(mock.events(r.c).some((event) => event.id === eventOfY));
    const gone = await r.t.call(r.t.second, 'DELETE', `/items/${y}`);
    assert.ok(gone.status === 200 || gone.status === 204, gone.text);
    assert.equal(
      mock.events(r.c).some((event) => event.id === eventOfY),
      false,
      'its event went',
    );
    // W1: the user deletes X's re-made event in Google: IB's next push reads it as theirs.
    assert.ok(mock.deleteEvent(r.c, String(r.cancelled['id'])));
    await push(r.t, r.t.second, r.ib);
    assert.equal(await (await models.getItemRepository()).findById(r.t.wid, r.x), null);
    assert.equal(
      mock.events(r.c).some((event) => event.id === r.cancelled['id']),
      false,
    );
  });

  it('the claim stands against a run by its answer, or (unanswered) by a minute before the run', async () => {
    const r = await raced('edge');
    await iaRemoves(r);
    const created = await runCreatedAt(r, r.runId);
    const links = await models.getCalendarLinkRepository();
    const at = (ms: number): Date => new Date(created.getTime() + ms);

    // Answered just before IB's run was created: the DELETE was made before IB's adopt. IB tracks.
    await setClaim(r, { tombstonedAt: at(-2_000), deleteAnsweredAt: at(-1) });
    await commitOf(r, r.runId, [r.adopt], []);
    assert.equal(
      (await links.findByItem(r.t.wid, r.ib, r.x))?.tombstonedAt,
      null,
      'answered before',
    );

    // Unanswered, claimed 61 s before IB's run: not this race either. IB tracks.
    const second = await nextRun(r);
    const secondCreated = await runCreatedAt(r, second);
    await setClaim(r, {
      tombstonedAt: new Date(secondCreated.getTime() - 61_000),
      deleteAnsweredAt: null,
    });
    await commitOf(r, second, [r.adopt], []);
    assert.equal((await links.findByItem(r.t.wid, r.ib, r.x))?.tombstonedAt, null, 'stale claim');

    // Unanswered, claimed 59 s before IB's run: it may still be in flight. IB drops its row.
    const third = await nextRun(r);
    const thirdCreated = await runCreatedAt(r, third);
    await setClaim(r, {
      tombstonedAt: new Date(thirdCreated.getTime() - 59_000),
      deleteAnsweredAt: null,
    });
    await commitOf(r, third, [r.adopt], []);
    assert.equal(await links.findByItem(r.t.wid, r.ib, r.x), null, 'in flight: dropped');

    // Answered after IB's run was created: dropped too (the race of P4, R1).
    const fourth = await nextRun(r);
    const fourthCreated = await runCreatedAt(r, fourth);
    await setClaim(r, {
      tombstonedAt: new Date(fourthCreated.getTime() - 1_000),
      deleteAnsweredAt: new Date(fourthCreated.getTime() + 1),
    });
    await commitOf(r, fourth, [r.adopt], []);
    assert.equal(await links.findByItem(r.t.wid, r.ib, r.x), null, 'answered after: dropped');
  });

  it('a claim answered before IB’s run: IB tracks its adopt, and the user’s later delete counts', async () => {
    const r = await raced('edge-user');
    await iaRemoves(r);
    const created = await runCreatedAt(r, r.runId);
    await setClaim(r, {
      tombstonedAt: new Date(created.getTime() - 2_000),
      deleteAnsweredAt: new Date(created.getTime() - 1),
    });
    await commitOf(r, r.runId, [r.adopt], []);
    const links = await models.getCalendarLinkRepository();
    assert.equal((await links.findByItem(r.t.wid, r.ib, r.x))?.tombstonedAt, null, 'IB tracks it');
    // The user deletes the event in Google; IB's next pull reads it. X is IB's owner's own to-do,
    // so it is soft-deleted, as any Google-side delete of one's own item.
    await commitOf(r, await nextRun(r), [], [r.cancelled]);
    assert.equal(await (await models.getItemRepository()).findById(r.t.wid, r.x), null);
    assert.equal((await links.findByItem(r.t.wid, r.ib, r.x))?.deletedBy, 'google');
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
});

describe('the outbound guard', () => {
  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
