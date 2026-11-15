/**
 * SyncRun, the state machine: every transition of the table (its writes, as stored), every
 * illegal one refused before anything is written, the conditional cancel (a run that finished
 * meanwhile keeps its outcome), the reaper, the request (its job, a failed start, the owner and
 * demo checks) and the sanitized view. SyncCursor, the value object.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SyncStateData } from '../../models/definitions/SyncState.js';
import type { ISyncRunRepository } from '../../models/definitions/SyncRun.js';
import type { JobRunner, SyncJob } from '../../services/syncJobs.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { SyncRunStatus } from '../../types/domain.js';
import { SyncCursor } from './SyncCursor.js';
import type * as SyncRunModule from './SyncRun.js';

let db: TestDatabase;
let runs: ISyncRunRepository;
let m: typeof SyncRunModule;
let setJobRunner: (runner: JobRunner | null) => void;

const WS = 'w-sync-run';
const OWNER = { id: 'i-sync-run', workspaceId: WS };
const AT = new Date('2026-11-15T10:00:00.000Z');
const ERROR = { code: 'network', message: 'Could not reach the provider' };

before(async () => {
  db = await startTestDatabase('todolist_classes_sync_run');
  runs = await (await import('../../models/index.js')).getSyncRunRepository();
  m = await import('./SyncRun.js');
  ({ setJobRunnerForTests: setJobRunner } = await import('../../services/syncJobs.js'));
});

afterEach(() => {
  setJobRunner(null);
});

after(async () => {
  await db.stop();
});

/** A stored run of OWNER in `status`, loaded as a SyncRun. */
async function runIn(status: SyncRunStatus): Promise<SyncRunModule.SyncRun> {
  const created = await runs.create(WS, { integrationId: OWNER.id, trigger: 'manual', status });
  const run = await m.SyncRun.find(WS, created.id);
  assert.ok(run !== null);
  return run;
}

async function stored(id: string): Promise<{ status: SyncRunStatus; error: unknown }> {
  const run = await runs.findById(WS, id);
  assert.ok(run !== null);
  return { status: run.status, error: run.error };
}

describe('SyncRun: the transitions table', () => {
  it('created: queue → queued, begin → running, skipNew → failed (zero counts, its error)', async () => {
    const queued = await m.SyncRun.queue(OWNER, 'schedule');
    assert.equal(queued.status, 'queued');
    const begun = await m.SyncRun.begin(OWNER, 'calendar_push', AT);
    assert.equal(begun.status, 'running');
    assert.equal(begun.startedAt.getTime(), AT.getTime());
    const skipped = await m.SyncRun.skipNew(
      OWNER,
      'manual',
      AT,
      m.SyncRun.error('skipped_paused'),
      { fetched: 0 },
    );
    const row = await runs.findById(WS, skipped.id);
    assert.equal(row?.status, 'failed');
    assert.deepEqual(row.error, { code: 'skipped_paused', message: 'The integration is paused' });
    assert.deepEqual(row.counts, { fetched: 0 });
    assert.equal(row.finishedAt?.getTime(), AT.getTime());
  });

  it('start: queued → running, its counts, error and failures reset', async () => {
    const run = await runIn('queued');
    await run.start(AT);
    assert.equal(run.status, 'running');
    const row = await runs.findById(WS, run.id);
    assert.equal(row?.status, 'running');
    assert.equal(row.startedAt.getTime(), AT.getTime());
    assert.equal(row.finishedAt, null);
    assert.deepEqual(row.failures, []);
  });

  it('retry: a started run (its job run again) → running; never a queued one', async () => {
    for (const status of ['running', 'succeeded', 'partial', 'failed'] as const) {
      const run = await runIn(status);
      await run.retry(AT);
      assert.equal(run.status, 'running', status);
      assert.equal((await stored(run.id)).status, 'running');
    }
    const queued = await runIn('queued');
    await assert.rejects(queued.retry(AT), { name: 'IllegalSyncRunTransitionError' });
    assert.equal((await stored(queued.id)).status, 'queued', 'nothing written');
  });

  it('succeed: running → succeeded, or partial; with the skipped records when given', async () => {
    const run = await runIn('running');
    await run.succeed(
      { counts: { fetched: 2, failed: 1 }, failures: [{ externalId: 'x', code: 'missing_url' }] },
      { finishedAt: AT, partial: true },
    );
    assert.equal(run.status, 'partial');
    const row = await runs.findById(WS, run.id);
    assert.equal(row?.status, 'partial');
    assert.deepEqual(row.failures, [{ externalId: 'x', code: 'missing_url' }]);
    assert.equal(row.error, null);
    const clean = await runIn('running');
    await clean.succeed({ counts: { pulled: 1 } }, { finishedAt: AT, partial: false });
    assert.equal((await stored(clean.id)).status, 'succeeded');
  });

  it('fail: queued (its job never started) or running → failed with its error', async () => {
    for (const status of ['queued', 'running'] as const) {
      const run = await runIn(status);
      await run.fail(ERROR, AT);
      assert.equal(run.status, 'failed');
      assert.deepEqual(await stored(run.id), { status: 'failed', error: ERROR });
    }
  });

  it('refuses every illegal transition before anything is written', async () => {
    const cases: [SyncRunStatus, (run: SyncRunModule.SyncRun) => Promise<unknown>][] = [
      ['running', (run): Promise<unknown> => run.start(AT)],
      ['failed', (run): Promise<unknown> => run.start(AT)],
      [
        'queued',
        (run): Promise<unknown> => run.succeed({ counts: {} }, { finishedAt: AT, partial: false }),
      ],
      [
        'failed',
        (run): Promise<unknown> => run.succeed({ counts: {} }, { finishedAt: AT, partial: false }),
      ],
      ['succeeded', (run): Promise<unknown> => run.fail(ERROR, AT)],
      ['partial', (run): Promise<unknown> => run.fail(ERROR, AT)],
    ];
    for (const [status, transition] of cases) {
      const run = await runIn(status);
      await assert.rejects(transition(run), { name: 'IllegalSyncRunTransitionError' });
      assert.equal(run.status, status);
      assert.equal((await stored(run.id)).status, status, 'nothing written');
    }
  });

  it('skip: any run of a held integration → failed at once', async () => {
    for (const status of ['queued', 'running', 'succeeded', 'partial', 'failed'] as const) {
      const run = await runIn(status);
      await run.skip(AT, m.SyncRun.error('skipped_expired'), {});
      assert.equal(run.status, 'failed');
      assert.equal((await stored(run.id)).status, 'failed');
    }
  });

  it('cancel: ends a run only while it is stored open; a finished one keeps its outcome', async () => {
    const queued = await runIn('queued');
    assert.equal(await queued.cancel(m.SyncRun.error('integration_deleted'), AT), true);
    assert.equal(queued.status, 'failed');
    // Loaded running, finished by its own job meanwhile: the conditional write leaves it.
    const raced = await runIn('running');
    await runs.update(WS, raced.id, { status: 'succeeded', finishedAt: AT });
    assert.equal(await raced.cancel(m.SyncRun.error('timeout'), AT), false);
    assert.equal(raced.status, 'running', 'the object keeps what it knew');
    assert.equal((await stored(raced.id)).status, 'succeeded');
  });
});

describe('SyncRun.reapStuck', () => {
  it('ends the runs still running past the cut-off as timed out, and only those', async () => {
    const now = new Date('2030-01-01T12:00:00.000Z');
    const stale = await runs.create(WS, {
      integrationId: OWNER.id,
      trigger: 'manual',
      status: 'running',
      startedAt: new Date(now.getTime() - 20 * 60_000),
    });
    const fresh = await runs.create(WS, {
      integrationId: OWNER.id,
      trigger: 'manual',
      status: 'running',
      startedAt: new Date(now.getTime() - 60_000),
    });
    const reaped = await m.SyncRun.reapStuck(now, 15 * 60_000, 500);
    assert.ok(reaped.some((run) => run.id === stale.id));
    assert.ok(!reaped.some((run) => run.id === fresh.id));
    assert.deepEqual(await stored(stale.id), {
      status: 'failed',
      error: { code: 'timeout', message: 'The sync did not finish in time' },
    });
    assert.equal((await stored(fresh.id)).status, 'running');
  });
});

describe('SyncRun.request', () => {
  // An integration of its own: the reaper's runs above start in 2030, newest first.
  const target = {
    id: 'i-sync-run-request',
    workspaceId: WS,
    ownerUserId: 'u-owner',
    demo: false,
    authMethod: 'personal_token' as const,
  };

  it('queues the run and starts its job: ids and the mode only', async () => {
    const jobs: SyncJob[] = [];
    setJobRunner((job) => {
      jobs.push(job);
      return Promise.resolve();
    });
    const run = await m.SyncRun.request(null, target, 'schedule');
    assert.equal(run.status, 'queued');
    assert.deepEqual(jobs, [
      { action: 'sync-run', integrationId: target.id, runId: run.id, mode: 'live' },
    ]);
  });

  it('a job that cannot be started ends its run failed (enqueue_failed) and throws', async () => {
    setJobRunner(() => Promise.reject(new Error('invoke refused')));
    const before = (await runs.listForIntegration(WS, target.id, 100)).length;
    await assert.rejects(m.SyncRun.request(null, target, 'manual'), /invoke refused/);
    const [newest] = await runs.listForIntegration(WS, target.id, 1);
    assert.equal((await runs.listForIntegration(WS, target.id, 100)).length, before + 1);
    assert.equal(newest?.status, 'failed');
    assert.equal(newest.error?.code, 'enqueue_failed');
  });

  it('never for demo data, nor for a caller who is not its owner', async () => {
    setJobRunner(() => Promise.resolve());
    await assert.rejects(
      m.SyncRun.request(null, { ...target, demo: true }, 'manual'),
      /demo integration never syncs/,
    );
    const { Caller } = await import('../base/Caller.js');
    const { Actor } = await import('../base/Actor.js');
    const stranger = Caller.fromContext(
      { id: WS, role: 'owner', settings: {} as never },
      Actor.user('u-someone-else'),
    );
    await assert.rejects(m.SyncRun.request(stranger, target, 'manual'), { statusCode: 404 });
  });
});

describe('SyncRun#toView', () => {
  it('shows named counts and a known code with its fixed message, never failures or stored text', async () => {
    const created = await runs.create(WS, { integrationId: OWNER.id, trigger: 'manual' });
    await runs.update(WS, created.id, {
      status: 'failed',
      counts: { fetched: 3, 'bad key': 1 },
      error: { code: 'auth_failed', message: 'provider said: token xyz expired' },
      failures: [{ externalId: 'secret-ish', code: 'missing_url' }],
    });
    const run = await m.SyncRun.find(WS, created.id);
    const view = run?.toView();
    assert.deepEqual(view?.counts, { fetched: 3 });
    assert.deepEqual(view.error, { code: 'auth_failed', message: 'Reconnect required' });
    assert.equal(JSON.stringify(view).includes('secret-ish'), false);
  });
});

describe('SyncCursor', () => {
  const state = (patch: Partial<SyncStateData> = {}): SyncStateData => ({
    id: 's1',
    workspaceId: WS,
    integrationId: OWNER.id,
    resource: 'calendar:primary',
    cursor: null,
    syncToken: 'tok-1',
    etag: null,
    updatedSince: null,
    lastFullSyncAt: new Date('2026-11-14T00:00:00.000Z'),
    lastIncrementalAt: null,
    backoffUntil: null,
    consecutiveErrors: 0,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  });

  it('none: never synced, a full sync due, no state for the adapter', () => {
    assert.equal(SyncCursor.none.exists, false);
    assert.equal(SyncCursor.of(null), SyncCursor.none);
    assert.equal(SyncCursor.none.isFullSyncDue(AT, 1000), true);
    assert.equal(SyncCursor.none.toState(), null);
    assert.equal(SyncCursor.none.consecutiveErrors, 0);
  });

  it('is equal by value, immutable, and hands adapters a copy of the stored state', () => {
    const a = SyncCursor.of(state());
    assert.ok(a.equals(SyncCursor.of(state())));
    assert.ok(!a.equals(SyncCursor.of(state({ syncToken: 'tok-2' }))));
    assert.ok(Object.isFrozen(a));
    const copy = a.toState();
    assert.ok(copy !== null);
    copy.syncToken = 'changed';
    assert.equal(a.syncToken, 'tok-1');
  });

  it('its dates never leave it: getters return copies; the row it came from can’t change it', () => {
    const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
    const row = state();
    const cursor = SyncCursor.of(row);
    const read = cursor.lastFullSyncAt;
    assert.ok(read !== null);
    read.setTime(0);
    row.lastFullSyncAt?.setTime(0);
    row.syncToken = 'changed';
    assert.equal(iso(cursor.lastFullSyncAt), '2026-11-14T00:00:00.000Z');
    assert.equal(cursor.syncToken, 'tok-1');
    const handed = cursor.toState();
    handed?.lastFullSyncAt?.setTime(0);
    assert.equal(iso(cursor.lastFullSyncAt), '2026-11-14T00:00:00.000Z');
    assert.ok(cursor.equals(SyncCursor.of(state())));
  });

  it('a full sync is due once the last complete one is at least the interval old', () => {
    const cursor = SyncCursor.of(state());
    const day = 24 * 60 * 60 * 1000;
    assert.equal(cursor.isFullSyncDue(new Date('2026-11-14T10:00:00.000Z'), day), false);
    assert.equal(cursor.isFullSyncDue(new Date('2026-11-15T00:00:00.000Z'), day), true);
  });
});
