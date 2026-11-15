/**
 * The dispatched calendar sync, worker side, against the in-process mock Google: a
 * `{action: 'gcal-run', integrationId}` job runs the same push and two-way pull as the manual
 * gcal-sync, honours maxOpsPerRun and the daily create cap, and skips what is no longer eligible.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import { findSecrets } from '../services/secretPatterns.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import { pointAppAtMockGoogle, startMockGoogle, type MockGoogle } from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import type { GcalRunJob } from '../services/syncJobs.js';
import { eventIdFor } from './diff.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000012', email: 'alice.scheduled@example.test' };

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let token: string;
let userId: string;
let wid: string;
let iid: string;

const due = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

async function connect(): Promise<string> {
  const base = `/api/private/workspaces/${wid}/integrations/google-calendar/oauth/start`;
  const started = await fetch(`${api.baseUrl}${base}`, {
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
  // Its primary calendar becomes the workspace's: the pushes go there.
  const primary = await api.call('PUT', `/api/private/workspaces/${wid}/primary-calendar`, {
    token,
    body: { integrationId: id, calendarId: ALICE.email },
  });
  assert.equal(primary.status, 200, primary.text);
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
  api = await startApiHarness('todolist_gcal_scheduled');
  // Google sends the browser back to the API itself here (no browser app in between).
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  token = (await api.login('gcal-scheduled-owner@example.test')).token;
  const me = await api.call('GET', '/api/private/me', { token });
  userId = (me.body?.['data'] as { id: string }).id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Calendar', slug: `cal-${randomUUID().slice(0, 8)}`, ownerId: userId });
  wid = workspace.id;
  await (await models.getMembershipRepository()).create(wid, { userId, role: 'owner' });
  iid = await connect();
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

/** What the worker gets: the calendar job, ids only. It throws only when a retry may help. */
async function work(id = iid): Promise<void> {
  const { runSyncJob } = await import('../sync/worker.js');
  const job: GcalRunJob = { action: 'gcal-run', integrationId: id };
  assert.deepEqual(findSecrets(job), []);
  assert.deepEqual(Object.keys(job).sort(), ['action', 'integrationId']);
  await runSyncJob(job);
}

async function runCount(): Promise<number> {
  return (await (await models.getSyncRunRepository()).listForIntegration(wid, iid, 100)).length;
}
async function addItem(title: string): Promise<string> {
  const items = await models.getItemRepository();
  return (
    await items.createLocal(wid, { ownerUserId: userId, title, topicId: 'personal', dueAt: due(2) })
  ).id;
}
const summaryOf = (itemId: string): string | undefined =>
  mock.events(ALICE.email).find((event) => event.id === eventIdFor(itemId))?.summary;

describe('the scheduled calendar worker, against the mock Google', () => {
  it('pushes the dashboard items as a calendar_push run', async () => {
    const first = await addItem('First');
    await work();
    assert.equal(summaryOf(first), 'First');
    const [run] = await (await models.getSyncRunRepository()).listForIntegration(wid, iid, 10);
    assert.ok(run);
    assert.equal(run.trigger, 'calendar_push');
    assert.equal(run.counts['created'], 1);
    assert.equal(run.counts['echoesSkipped'], 1);
  });

  it('pulls a Google-side edit into the item', async () => {
    const first = (
      await (
        await models.getItemRepository()
      ).aggregate<{ _id: string }>(wid, [{ $match: { title: 'First' } }])
    )[0];
    assert.ok(first);
    assert.ok(mock.editEvent(ALICE.email, eventIdFor(first._id), { summary: 'Edited in Google' }));
    await work();
    const [after] = await (
      await models.getItemRepository()
    ).aggregate<{ title: string }>(wid, [{ $match: { _id: first._id } }]);
    assert.equal(after?.title, 'Edited in Google');
  });

  it('respects maxOpsPerRun', async () => {
    const integrations = await models.getIntegrationRepository();
    const current = await integrations.findByIdForWorker(iid);
    assert.ok(current);
    await integrations.update(wid, iid, { config: { ...current.config, maxOpsPerRun: 1 } });
    const before = mock.events(ALICE.email).length;
    await addItem('Second');
    await addItem('Third');
    await work();
    assert.equal(mock.events(ALICE.email).length, before + 1);
    await work();
    assert.equal(mock.events(ALICE.email).length, before + 2);
  });

  it('creates nothing once the day’s create cap is used up', async () => {
    const { DAILY_CREATE_CAP } = await import('./plan.js');
    const repo = await models.getSyncRunRepository();
    const used = await repo.create(wid, {
      integrationId: iid,
      trigger: 'calendar_push',
      status: 'succeeded',
    });
    await repo.update(wid, used.id, { counts: { created: DAILY_CREATE_CAP } });
    const before = mock.events(ALICE.email).length;
    await addItem('Over the cap');
    await work();
    assert.equal(mock.events(ALICE.email).length, before);
  });

  it('skips a paused, expired or auth_failed integration: no run, no write', async () => {
    const integrations = await models.getIntegrationRepository();
    const runs = await runCount();
    const events = mock.events(ALICE.email).length;
    await integrations.update(wid, iid, { status: 'paused' });
    await work();
    await integrations.update(wid, iid, { status: 'expired' });
    await work();
    await integrations.update(wid, iid, {
      status: 'error',
      lastError: { code: 'auth_failed', message: 'Reconnect required' },
    });
    await work();
    assert.equal(await runCount(), runs);
    assert.equal(mock.events(ALICE.email).length, events);
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
