/**
 * TodoList's claims on the events it deletes (EventClaim), one integration, end to end against
 * the mock Google:
 * - P1 (phase 5 re-review): the push's own delete is made but its answer is lost; a read of the
 *   event settles the claim, so the push's own pull never reads that delete as the user's;
 * - the read fails too: the claim is kept (an orphaned event beats a lost to-do), and a later push
 *   reconciles it once it has stood unanswered for a while;
 * - a delete op whose link is no longer this integration's is not sent; a delete that was not made
 *   (rate limited) takes its claim back, and the next push sends it again;
 * - a to-do's delete whose DELETE fails takes its claim back;
 * - a database failure between the push's claims takes back what was claimed, and sends nothing;
 * - phase 5 re-review 2: claims stored before the field existed are never swept (A); a database
 *   failure while settling releases nothing whose DELETE was made (B); a DELETE that lands after
 *   the read said live leaves the claim kept, so the push's own pull reads nothing (C);
 * - phase 5 re-review 3: the list of integrations (`pushedEventCount`) sweeps at most 3 claims
 *   (R3-M1); a claim whose read always fails goes to the back of the line, so it never starves the
 *   others (R3-N3).
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
const ALICE = { sub: '100000000000000000081', email: 'alice.claims@example.test' };

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;

interface Owner {
  wid: string;
  token: string;
  iid: string;
  calendarId: string;
  call: (method: string, path: string, body?: unknown) => ReturnType<ApiHarness['call']>;
}

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_claims');
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

/** A workspace of one owner whose Google Calendar is read & write, pushing to a calendar of its own. */
async function owner(tag: string): Promise<Owner> {
  const token = (await api.login(`claims-${tag}@example.test`)).token;
  const me = data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  const wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({
      name: `Claims ${tag}`,
      slug: `claims-${tag}-${randomUUID().slice(0, 8)}`,
      ownerId: me,
    })
  ).id;
  await (await models.getMembershipRepository()).create(wid, { userId: me, role: 'owner' });
  const call = (method: string, path: string, body?: unknown): ReturnType<ApiHarness['call']> =>
    api.call(method, `/api/private/workspaces/${wid}${path}`, {
      token,
      ...(body === undefined ? {} : { body }),
    });
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
  const iid = /connected=([0-9a-f-]{36})/.exec(landed.headers.get('location') ?? '')?.[1];
  assert.ok(iid !== undefined);
  assert.equal((await call('PATCH', `/integrations/${iid}`, { mode: 'read_write' })).status, 200);
  const chosen = await call('PUT', '/primary-calendar', {
    integrationId: iid,
    newCalendarName: `Claims ${tag}`,
  });
  assert.equal(chosen.status, 200, chosen.text);
  return { wid, token, iid, calendarId: data(chosen.body)['calendarId'] as string, call };
}

async function push(o: Owner): Promise<void> {
  const pushed = await o.call('POST', '/gcal-sync', { integrationId: o.iid, confirm: true });
  assert.equal(pushed.status, 202, pushed.text);
}

async function todo(o: Owner, title: string): Promise<{ id: string; eventId: string }> {
  const made = await o.call('POST', '/items', {
    title,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(made.status, 201, made.text);
  const id = data(made.body)['id'] as string;
  return { id, eventId: (await import('./diff.js')).eventIdFor(id) };
}

async function undate(o: Owner, id: string): Promise<void> {
  assert.equal((await o.call('PATCH', `/items/${id}`, { dueAt: null })).status, 200);
}

async function link(o: Owner, itemId: string): Promise<Models.CalendarLinkData | null> {
  return (await models.getCalendarLinkRepository()).findByItem(o.wid, o.iid, itemId);
}

const live = (o: Owner, eventId: string): boolean =>
  mock.events(o.calendarId).some((event) => event.id === eventId);

/** How many event DELETEs the mock Google received so far. */
const deletes = (): number =>
  mock
    .requests()
    .filter((request) => request.method === 'DELETE' && request.path.includes('/events/')).length;

describe('a push’s own delete whose answer is lost (P1)', () => {
  it('is settled by a read of the event: its own pull never reads it as the user’s', async () => {
    const o = await owner('p1');
    const x = await todo(o, 'Undated soon');
    await push(o);
    // A second push, so the pull holds an incremental token for the calendar.
    await push(o);
    await undate(o, x.id);
    // Google applies the delete, then the answer is lost (a 5xx).
    mock.holdNextWrite(() => {
      assert.ok(mock.deleteEvent(o.calendarId, x.eventId));
      mock.failNextWrite(503);
      return Promise.resolve();
    });
    await push(o);
    const row = await link(o, x.id);
    assert.equal(row?.deletedBy, 'dashboard', 'the claim was kept, never released blind');
    assert.ok(row.deleteAnsweredAt instanceof Date, 'settled: the read showed it gone');
    const item = await (await models.getItemRepository()).findById(o.wid, x.id);
    assert.equal(item?.deletedAt, null, 'the undated to-do stays');
  });

  it('when the read fails too, the claim is kept; a later push reconciles it, and the delete goes out again', async () => {
    const o = await owner('kept');
    const x = await todo(o, 'Undated, its answer lost');
    await push(o);
    await undate(o, x.id);
    // No answer, and nothing made; then the read of the event fails as well.
    mock.holdNextWrite(() => {
      mock.failNextWrite(503);
      // Set once the write has taken its failure (taking it clears a pending read failure).
      setImmediate(() => {
        mock.failNextRead(500);
      });
      return Promise.resolve();
    });
    await push(o);
    let row = await link(o, x.id);
    assert.equal(row?.deletedBy, 'dashboard', 'kept: an orphan event beats a lost to-do');
    assert.equal(row.deleteAnsweredAt, null, 'unanswered');
    assert.ok(live(o, x.eventId), 'the event is still in Google');

    // Eleven minutes on (past STUCK_CLAIM_MS), the next push reconciles it: the event is live, and
    // its call is long over, so the claim goes back…
    const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
    await CalendarLinkMongoModel.updateOne(
      { _id: row.id },
      { $set: { tombstonedAt: new Date(Date.now() - 11 * 60_000) } },
    );
    await push(o);
    row = await link(o, x.id);
    assert.equal(row?.tombstonedAt, null, 'reconciled: live again');
    // …and the push after it deletes the undated to-do's event, for good.
    await push(o);
    assert.equal(live(o, x.eventId), false);
    row = await link(o, x.id);
    assert.equal(row?.deletedBy, 'dashboard');
    assert.ok(row.deleteAnsweredAt instanceof Date);
  });
});

describe('claims stored before the field existed (A)', () => {
  it('read as answered at their tombstone: the sweep never reads them, nor takes back a restored event', async () => {
    const o = await owner('old');
    const xs = [await todo(o, 'Old 0'), await todo(o, 'Old 1'), await todo(o, 'Old 2')];
    await push(o);
    for (const x of xs) await undate(o, x.id);
    await push(o);
    // As the old code left them: no deleteAnsweredAt, ten days old.
    const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
    await CalendarLinkMongoModel.collection.updateMany(
      { workspaceId: o.wid, integrationId: o.iid, deletedBy: 'dashboard' },
      {
        $unset: { deleteAnsweredAt: '' },
        $set: { tombstonedAt: new Date(Date.now() - 10 * 86_400_000) },
      },
    );
    // The user restored one event in Google.
    const [restored] = xs;
    assert.ok(restored !== undefined);
    mock.addEvent(o.calendarId, {
      id: restored.eventId,
      summary: 'Old 0 (restored)',
      start: { date: '2026-12-01' },
      end: { date: '2026-12-02' },
    });
    const before = mock.requests().length;
    await push(o);
    const reads = mock
      .requests()
      .slice(before)
      .filter((request) => request.method === 'GET' && /\/events\/[^/]+$/.test(request.path));
    assert.deepEqual(reads, [], 'no claim read: they are answered');
    const row = await link(o, restored.id);
    assert.equal(row?.deletedBy, 'dashboard', 'still TodoList’s delete, never taken back');
    assert.ok(row.deleteAnsweredAt instanceof Date, 'answered at its tombstone');
    await push(o);
    assert.ok(live(o, restored.eventId), 'the restored event stays');
  });
});

describe('the push’s claims', () => {
  it('a delete op whose link is no longer this integration’s is not sent', async () => {
    const o = await owner('skip');
    const x = await todo(o, 'Adopted elsewhere');
    await push(o);
    await undate(o, x.id);
    const { Actor } = await import('../classes/base/Actor.js');
    const { Caller } = await import('../classes/base/Caller.js');
    const { Calendar } = await import('../classes/calendar/index.js');
    const { Integration, isCalendarProvider } = await import('../classes/integration/index.js');
    const integration = await Integration.forWorker(o.iid);
    assert.ok(integration !== null && isCalendarProvider(integration));
    const plan = await (await Calendar.primaryFor(integration.toJSON())).plan(new Date());
    assert.ok(plan.ops.some((op) => op.type === 'delete'));
    // Between the plan and the push, the row goes (another integration adopted the event).
    const row = await link(o, x.id);
    assert.ok(row !== null);
    await (await models.getCalendarLinkRepository()).remove(o.wid, row.id);
    const caller = await Caller.enter(o.wid, Actor.user(integration.ownerUserId));
    assert.ok(caller !== null);
    const before = deletes();
    await integration.push(caller, { ops: plan.ops, now: new Date(), calendarId: o.calendarId });
    assert.equal(deletes(), before, 'no DELETE was sent');
    assert.ok(live(o, x.eventId));
  });

  it('a delete that was not made (rate limited) takes its claim back; the next push sends it again', async () => {
    const o = await owner('retry');
    const x = await todo(o, 'Rate limited');
    await push(o);
    await undate(o, x.id);
    mock.failNextWrite(429);
    await push(o);
    assert.equal((await link(o, x.id))?.tombstonedAt, null, 'released');
    assert.ok(live(o, x.eventId));
    await push(o);
    assert.equal(live(o, x.eventId), false, 'sent again and made');
    assert.ok((await link(o, x.id))?.deleteAnsweredAt instanceof Date);
  });

  it('a database failure between the claims takes back what was claimed, and sends nothing', async (t) => {
    const o = await owner('db');
    const x = await todo(o, 'First undated');
    const y = await todo(o, 'Second undated');
    await push(o);
    await undate(o, x.id);
    await undate(o, y.id);
    const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
    const claims = t.mock.method(CalendarLinkMongoModel, 'findOneAndUpdate');
    // The push's second claim (the second findOneAndUpdate from now) fails.
    claims.mock.mockImplementationOnce(() => {
      throw new Error('database blip');
    }, claims.mock.callCount() + 1);
    const before = deletes();
    const pushed = await o.call('POST', '/gcal-sync', { integrationId: o.iid, confirm: true });
    assert.equal(pushed.status, 500, pushed.text);
    claims.mock.restore();
    assert.equal(deletes(), before, 'nothing was sent');
    assert.equal((await link(o, x.id))?.tombstonedAt, null, 'the first claim was taken back');
    assert.equal((await link(o, y.id))?.tombstonedAt, null);
    assert.ok(live(o, x.eventId) && live(o, y.eventId));
  });
});

describe('re-review 2: a made DELETE is never released, a live reading never trusted at once', () => {
  it('B: a database failure while settling releases nothing; the claims stay', async (t) => {
    const o = await owner('blind');
    const x = await todo(o, 'Blind X');
    const y = await todo(o, 'Blind Y');
    await push(o);
    await undate(o, x.id);
    await undate(o, y.id);
    const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
    const settles = t.mock.method(CalendarLinkMongoModel, 'updateOne');
    settles.mock.mockImplementationOnce(() => {
      throw new Error('database blip');
    });
    await push(o);
    settles.mock.restore();
    for (const item of [x, y]) {
      assert.equal(live(o, item.eventId), false, 'both DELETEs were made');
      assert.equal((await link(o, item.id))?.deletedBy, 'dashboard', 'and both claims stay');
    }
    // The one whose settle failed waits, unanswered, for the sweep; the other is settled.
    const answered = [await link(o, x.id), await link(o, y.id)].map(
      (row) => row?.deleteAnsweredAt instanceof Date,
    );
    assert.deepEqual(answered.sort(), [false, true]);
  });

  it('C: a DELETE that lands after the read said live: the claim is kept, the to-do stays', async () => {
    const o = await owner('slow');
    const x = await todo(o, 'Slow delete');
    await push(o);
    await push(o);
    await undate(o, x.id);
    // No answer; the read finds the event live; only then does the DELETE land.
    mock.holdNextWrite(() => {
      mock.failNextWrite(503);
      mock.afterNextRead(() => {
        assert.ok(mock.deleteEvent(o.calendarId, x.eventId));
      });
      return Promise.resolve();
    });
    await push(o);
    let row = await link(o, x.id);
    assert.equal(row?.deletedBy, 'dashboard', 'kept: a live reading may come before the delete');
    assert.equal(row.deleteAnsweredAt, null);
    const item = await (await models.getItemRepository()).findById(o.wid, x.id);
    assert.equal(
      item?.deletedAt,
      null,
      'the push’s own pull read nothing of ours: the to-do stays',
    );
    // Eleven minutes on, the sweep reads it gone: settled.
    const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
    await CalendarLinkMongoModel.updateOne(
      { _id: row.id },
      { $set: { tombstonedAt: new Date(Date.now() - 11 * 60_000) } },
    );
    await push(o);
    row = await link(o, x.id);
    assert.ok(row?.deleteAnsweredAt instanceof Date, 'settled by the sweep');
  });
});

/**
 * `count` claims stuck for 11 minutes (the oldest first, one minute apart), their events live in
 * Google again: as a delete whose answer was lost and whose read failed leaves them.
 */
async function stuckClaims(o: Owner, count: number): Promise<{ id: string; eventId: string }[]> {
  const xs: { id: string; eventId: string }[] = [];
  for (let n = 0; n < count; n += 1) xs.push(await todo(o, `Stuck ${String(n)}`));
  await push(o);
  for (const x of xs) await undate(o, x.id);
  await push(o);
  const { CalendarLinkMongoModel } = await import('../models/mongoose/CalendarLink.js');
  for (const [n, x] of xs.entries()) {
    await CalendarLinkMongoModel.updateOne(
      { workspaceId: o.wid, integrationId: o.iid, itemId: x.id },
      {
        $set: {
          deleteAnsweredAt: null,
          tombstonedAt: new Date(Date.now() - (11 + count - n) * 60_000),
        },
      },
    );
    mock.addEvent(o.calendarId, {
      id: x.eventId,
      summary: `Stuck ${String(n)}`,
      start: { date: '2026-12-01' },
      end: { date: '2026-12-02' },
    });
  }
  return xs;
}

const eventReads = (since: number): number =>
  mock
    .requests()
    .slice(since)
    .filter((request) => request.method === 'GET' && /\/events\/[^/]+$/.test(request.path)).length;

describe('re-review 3: the sweep of the list stays small, and fair', () => {
  it('R3-M1: GET /integrations reads at most 3 claims, even with a read failing', async () => {
    const o = await owner('listcap');
    const xs = await stuckClaims(o, 10);
    const before = mock.requests().length;
    mock.failNextRead(500);
    const listed = await api.call('GET', `/api/private/workspaces/${o.wid}/integrations`, {
      token: o.token,
    });
    assert.equal(listed.status, 200, listed.text);
    assert.ok(eventReads(before) <= 3, `reads: ${String(eventReads(before))}`);
    assert.equal(eventReads(before), 3);
    const stillClaims = (await Promise.all(xs.map((x) => link(o, x.id)))).filter(
      (row) => row?.deletedBy === 'dashboard' && row.deleteAnsweredAt === null,
    );
    assert.ok(stillClaims.length >= 8, 'the rest wait for a later call');
  });

  it('R3-N3: a claim whose read always fails goes to the back of the line', async () => {
    const o = await owner('fair');
    const xs = await stuckClaims(o, 4);
    const { EventClaim } = await import('../classes/calendar/EventClaim.js');
    const owned = { id: o.iid, workspaceId: o.wid };
    // Every read fails: three sweeps of two claims each go round the four claims.
    const seen: string[] = [];
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const stuck = await EventClaim.stuck(owned, 2);
      for (const claim of stuck) seen.push(claim.itemId);
      await EventClaim.reconcile(stuck, () => Promise.resolve('unknown'));
    }
    assert.deepEqual(
      seen,
      [xs[0], xs[1], xs[2], xs[3], xs[0], xs[1]].map((x) => x?.id),
      'never swept first, then the least recently swept',
    );
    for (const x of xs) assert.equal((await link(o, x.id))?.deleteAnsweredAt, null, 'all kept');
  });
});

describe('a to-do’s delete (deleteLinkedEvent)', () => {
  it('whose DELETE fails takes its claim back; the next push removes the event', async () => {
    const o = await owner('item');
    const x = await todo(o, 'Deleted while Google is busy');
    await push(o);
    mock.failNextWrite(403, 'rateLimitExceeded');
    const deleted = await o.call('DELETE', `/items/${x.id}`);
    assert.ok(deleted.status === 200 || deleted.status === 204, deleted.text);
    assert.equal((await link(o, x.id))?.tombstonedAt, null, 'released: still tracked');
    assert.ok(live(o, x.eventId));
    await push(o);
    assert.equal(live(o, x.eventId), false, 'the next push removed it');
  });
});

describe('the outbound guard', () => {
  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
