import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IIntegrationRepository } from '../models/definitions/Integration.js';
import type { ISyncRunRepository } from '../models/definitions/SyncRun.js';
import type { SyncJob, SyncRunJob } from '../services/syncJobs.js';
import { createFakeAdapter, FAKE_PROVIDER } from '../testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { runJobInProcess } from '../testing/testSeams.js';
import { registerAdapter } from './registry.js';
import type { SyncRunOptions } from '../testing/syncCalls.js';
import { setVaultLoaderForTests } from './secrets.js';
import type { SyncRunSummary } from './types.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';

forceSyncModeForTests('fixtures');

let db: TestDatabase;
let guard: OutboundGuard;
let integrations: IIntegrationRepository;
let runs: ISyncRunRepository;
let workspaceId: string;
const started: SyncJob[] = [];

before(async () => {
  // Forced fixtures: never decrypt, never call out. Jobs are recorded here, run by each test.
  db = await startTestDatabase('todolist_worker_test');
  guard = installOutboundGuard();
  const m = await import('../models/index.js');
  integrations = await m.getIntegrationRepository();
  runs = await m.getSyncRunRepository();
  const workspace = await (
    await m.getWorkspaceRepository()
  ).create({ name: 'Worker', slug: 'worker', ownerId: 'u-owner' });
  workspaceId = workspace.id;
  registerAdapter(createFakeAdapter().adapter);
  const { setJobRunnerForTests } = await import('../services/syncJobs.js');
  setJobRunnerForTests((job) => {
    started.push(job);
    return Promise.resolve();
  });
});

after(async () => {
  const { setJobRunnerForTests } = await import('../services/syncJobs.js');
  setJobRunnerForTests(runJobInProcess);
  setVaultLoaderForTests(null);
  guard.restore();
  await db.stop();
});

/** Queues a run for a new fake integration and returns the sync-run job enqueueSync started. */
async function queuedJob(accountId: string): Promise<SyncRunJob> {
  const integration = await integrations.create(workspaceId, {
    connectedBy: 'u-owner',
    provider: FAKE_PROVIDER,
    accountId,
    label: 'Fake',
    authMethod: 'none',
    topicId: 'work',
  });
  const { enqueueSync } = await import('../testing/syncCalls.js');
  await enqueueSync(integration.id, 'schedule');
  const job = started.at(-1);
  assert.ok(job?.action === 'sync-run');
  return job;
}

const outcome = (code: string | null): SyncRunSummary => ({
  runId: 'r',
  status: code === null ? 'succeeded' : 'failed',
  counts: { fetched: 0, inserted: 0, updated: 0, unchanged: 0, closed: 0, deleted: 0, failed: 0 },
  error: code === null ? null : { code, message: 'fixed text' },
});

describe('runSyncJob: sync-run', () => {
  it('runs the queued run the job names', async () => {
    const { runSyncJob } = await import('./worker.js');
    const job = await queuedJob('worker-1');
    await runSyncJob(job);
    const run = await runs.findById(workspaceId, job.runId);
    assert.deepEqual(
      [run?.status, run?.trigger, run?.counts['inserted']],
      ['partial', 'schedule', 4],
    );
  });

  it('throws (so Lambda retries) for a run that threw or failed for a reason that may pass, not one that needs the user', async () => {
    const { runSyncJob } = await import('./worker.js');
    const outcomes: Record<string, SyncRunSummary | 'throw'> = {
      'i-ok': outcome(null),
      'i-throws': 'throw',
      'i-network': outcome('network'),
      'i-server': outcome('server_error'),
      'i-rate': outcome('rate_limited'),
      'i-internal': outcome('internal'),
      'i-auth': outcome('auth_failed'),
      'i-adapter': outcome('no_adapter'),
      // Deterministic: the same input fails the same way, so a retry would not help.
      'i-bug': outcome('adapter_error'),
      'i-data': outcome('invalid_data'),
      'i-fixture': outcome('fixtures_missing'),
      'i-too-large': outcome('listing_too_large'),
      'i-deleted': outcome('integration_deleted'),
      'i-paused': outcome('skipped_paused'),
      'i-expired': outcome('skipped_expired'),
    };
    const calls: [string, SyncRunOptions][] = [];
    const runner = (integrationId: string, opts: SyncRunOptions): Promise<SyncRunSummary> => {
      calls.push([integrationId, opts]);
      const result = outcomes[integrationId];
      if (result === undefined || result === 'throw') {
        return Promise.reject(new Error('database unreachable at FAKE-host'));
      }
      return Promise.resolve(result);
    };
    const retried: string[] = [];
    for (const integrationId of Object.keys(outcomes)) {
      const job: SyncJob = { action: 'sync-run', integrationId, runId: 'r-1', mode: 'fixtures' };
      try {
        await runSyncJob(job, runner);
      } catch (error) {
        assert.ok(error instanceof Error && error.name === 'RetrySyncJob');
        // The error Lambda logs carries the job's ids and a code, never the cause's text.
        assert.doesNotMatch(error.message, /FAKE-host|fixed text/);
        retried.push(integrationId);
      }
    }
    assert.deepEqual(retried, ['i-throws', 'i-network', 'i-server', 'i-rate', 'i-internal']);
    assert.deepEqual(calls[0], ['i-ok', { runId: 'r-1', mode: 'fixtures' }]);
  });

  it('under forced fixtures never decrypts, even when a job says live', async () => {
    const { runSyncJob } = await import('./worker.js');
    let vaultLoads = 0;
    setVaultLoaderForTests(() => {
      vaultLoads += 1;
      return Promise.reject(new Error('the vault must not be loaded'));
    });
    const job = await queuedJob('worker-live');
    await runSyncJob({ ...job, mode: 'live' });
    assert.equal(vaultLoads, 0);
    assert.equal((await runs.findById(workspaceId, job.runId))?.status, 'partial');
  });
});

describe('runSyncJob: gcal-run', () => {
  it('runs the calendar sync of the integration the job names', async () => {
    const { runSyncJob } = await import('./worker.js');
    const ran: string[] = [];
    await runSyncJob(
      { action: 'gcal-run', integrationId: 'i-calendar' },
      () => Promise.reject(new Error('not a sync run')),
      (integrationId) => {
        ran.push(integrationId);
        return Promise.resolve({ ran: false, reason: 'refused' });
      },
    );
    assert.deepEqual(ran, ['i-calendar']);
  });

  it('throws (so Lambda retries) only when the calendar run threw', async () => {
    const { runSyncJob } = await import('./worker.js');
    await assert.rejects(
      runSyncJob(
        { action: 'gcal-run', integrationId: 'i-calendar' },
        () => Promise.reject(new Error('not a sync run')),
        () => Promise.reject(new Error('database unreachable')),
      ),
      { name: 'RetrySyncJob' },
    );
  });

  it('never opened a connection outside this machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
