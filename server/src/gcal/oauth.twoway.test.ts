/**
 * Two-way sync on the OAuth path against the mock Google: Google-side edits and
 * deletes of events we pushed come back through the same commit logic as the bridge's. A local
 * item takes the edit (last write wins, a tie to Google); a provider item is overwritten on the
 * next push and a Google delete only stops its projection; our own echo is skipped; a tombstone
 * blocks re-creation.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { CalendarLinkData } from '../models/definitions/CalendarLink.js';
import type { ItemData } from '../models/definitions/Item.js';
import type * as Models from '../models/index.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import { pointAppAtMockGoogle, startMockGoogle, type MockGoogle } from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { eventIdFor } from './diff.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000011', email: 'alice.calendar@example.test' };

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let token: string;
let wid: string;
let iid: string;
let localId: string;
let providerId: string;

const integrationsPath = (rest = ''): string =>
  `/api/private/workspaces/${wid}/integrations${rest}`;

/** Start → the mock's authorize (auto-approved) → the callback. The integration's id. */
async function connect(): Promise<string> {
  const started = await fetch(`${api.baseUrl}${integrationsPath('/google-calendar/oauth/start')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  const text = await started.text();
  assert.equal(started.status, 200, text);
  const cookie = /todolist_oauth=[A-Za-z0-9_-]{43}/.exec(
    started.headers.get('set-cookie') ?? '',
  )?.[0];
  assert.ok(cookie !== undefined);
  const { authorizeUrl } = (JSON.parse(text) as { data: { authorizeUrl: string } }).data;
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = authorized.headers.get('location') ?? '';
  const landed = await fetch(back, { redirect: 'manual', headers: { cookie } });
  const id = /connected=([0-9a-f-]{36})$/.exec(landed.headers.get('location') ?? '')?.[1];
  assert.ok(id !== undefined, landed.headers.get('location') ?? '');
  // Every connection starts read-only; these tests push, so its owner switches it on.
  const switched = await api.call('PATCH', `/api/private/workspaces/${wid}/integrations/${id}`, {
    token,
    body: { mode: 'read_write' },
  });
  assert.equal(switched.status, 200, switched.text);
  return id;
}

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_oauth_twoway');
  // Google sends the browser back to the API itself here (no browser app in between).
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  const login = await api.login('gcal-twoway-owner@example.test');
  token = login.token;
  const me = await api.call('GET', '/api/private/me', { token });
  const userId = (me.body?.['data'] as { id: string }).id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Calendar', slug: `calendar-${randomUUID().slice(0, 8)}`, ownerId: userId });
  wid = workspace.id;
  await (await models.getMembershipRepository()).create(wid, { userId, role: 'owner' });
  iid = await connect();

  const items = await models.getItemRepository();
  const due = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  localId = (
    await items.createLocal(wid, {
      ownerUserId: userId,
      title: 'Local task',
      topicId: 'personal',
      dueAt: due(2),
    })
  ).id;
  await items.bulkUpsert(wid, [
    {
      integrationId: iid,
      kind: 'task',
      topicId: 'personal',
      title: 'Linear ticket',
      status: 'open',
      dueAt: due(3),
      source: {
        provider: 'linear',
        accountId: 'acct',
        externalId: 'FAKE-1',
        key: null,
        url: 'https://linear.app/fake/issue/FAKE-1',
        updatedAtSource: null,
        etag: null,
        hash: 'h1',
      },
    },
  ]);
  const [doc] = await items.aggregate<{ _id: string }>(wid, [
    { $match: { 'source.externalId': 'FAKE-1' } },
  ]);
  assert.ok(doc);
  providerId = doc._id;
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

const call = (method: string, path: string, body?: unknown): ReturnType<ApiHarness['call']> =>
  api.call(method, path, { token, ...(body === undefined ? {} : { body }) });

/** A confirmed push (the writes, then the pull); the run's counts. */
async function push(): Promise<Record<string, number>> {
  const res = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
    integrationId: iid,
    confirm: true,
  });
  assert.equal(res.status, 202, res.text);
  const run = await (
    await models.getSyncRunRepository()
  ).findById(wid, (res.body?.['data'] as { runId: string }).runId);
  assert.ok(run);
  return run.counts;
}

async function item(id: string): Promise<ItemData> {
  // aggregate, not findById: a soft-deleted item is still there to look at.
  const [found] = await (
    await models.getItemRepository()
  ).aggregate<ItemData & { _id: string }>(wid, [{ $match: { _id: id } }]);
  assert.ok(found);
  return found;
}
const link = async (id: string): Promise<CalendarLinkData | null> =>
  (await models.getCalendarLinkRepository()).findByItem(wid, iid, id);
const summaryOf = (id: string): string | undefined =>
  mock.events(ALICE.email).find((event) => event.id === eventIdFor(id))?.summary;
async function nothingToPush(): Promise<void> {
  const res = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
    integrationId: iid,
  });
  assert.deepEqual(res.body?.['data'], {
    dryRun: true,
    counts: { create: 0, update: 0, remove: 0 },
  });
}

describe('Google Calendar two-way sync with OAuth, against the mock', () => {
  it('pushes both items; our own events are skipped on the pull (echo)', async () => {
    const counts = await push();
    assert.equal(counts['created'], 2);
    assert.equal(counts['echoesSkipped'], 2);
    assert.equal(summaryOf(localId), 'Local task');
    assert.equal(summaryOf(providerId), 'Linear ticket');
    await nothingToPush();
  });

  it('a Google edit of a local item flows back into the item', async () => {
    assert.ok(mock.editEvent(ALICE.email, eventIdFor(localId), { summary: 'Edited in Google' }));
    const counts = await push();
    assert.equal(counts['updated'], 1);
    assert.equal((await item(localId)).title, 'Edited in Google');
    assert.equal(summaryOf(localId), 'Edited in Google');
    await nothingToPush();
  });

  it('a Google edit of a provider item is overwritten on the push, never written back', async () => {
    assert.ok(mock.editEvent(ALICE.email, eventIdFor(providerId), { summary: 'Hacked in Google' }));
    await push(); // the pull sees the edit, keeps ours and clears the hash …
    assert.equal((await item(providerId)).title, 'Linear ticket');
    await push(); // … and this push puts our version over Google's
    assert.equal(summaryOf(providerId), 'Linear ticket');
    assert.equal((await item(providerId)).title, 'Linear ticket');
  });

  it('a dashboard edit pushed by us is an echo, not a change', async () => {
    await (await models.getItemRepository()).updateLocal(wid, localId, { title: 'Renamed here' });
    const counts = await push();
    assert.equal(counts['updated'], 1);
    assert.equal(counts['echoesSkipped'], 1);
    assert.equal(counts['conflicts'], 0);
    assert.equal((await item(localId)).title, 'Renamed here');
    assert.equal(summaryOf(localId), 'Renamed here');
  });

  it('a tie between the dashboard edit and Google’s goes to Google', async () => {
    const edited = await (
      await models.getItemRepository()
    ).updateLocal(wid, localId, { title: 'Dashboard side' });
    assert.ok(edited);
    assert.ok(
      mock.editEvent(ALICE.email, eventIdFor(localId), {
        summary: 'Google side',
        updated: edited.updatedAt.toISOString(),
      }),
    );
    const counts = await push();
    // The patch's 412 and the pull's last-write-wins call each count one.
    assert.equal(counts['conflicts'], 2);
    assert.equal((await item(localId)).title, 'Google side');
    assert.equal(summaryOf(localId), 'Google side');
  });

  it('a Google delete soft-deletes a local item; the tombstone blocks re-creation', async () => {
    assert.ok(mock.deleteEvent(ALICE.email, eventIdFor(localId)));
    await push();
    assert.notEqual((await item(localId)).deletedAt, null);
    assert.notEqual((await link(localId))?.tombstonedAt, null);
    await push();
    assert.equal(summaryOf(localId), undefined, 'not re-created');
    await nothingToPush();
  });

  it('a Google delete of a provider item stops its projection and leaves it as it is', async () => {
    assert.ok(mock.deleteEvent(ALICE.email, eventIdFor(providerId)));
    await push();
    const after = await item(providerId);
    assert.equal(after.deletedAt, null);
    assert.equal(after.title, 'Linear ticket');
    assert.equal(after.overlay.calendarSync, false);
    assert.notEqual((await link(providerId))?.tombstonedAt, null);
    await push();
    assert.equal(summaryOf(providerId), undefined, 'not re-created');
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
