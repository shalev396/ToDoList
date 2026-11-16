import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IAuditLogRepository } from '../models/definitions/AuditLog.js';
import type { IIntegrationRepository } from '../models/definitions/Integration.js';
import type { ISyncRunRepository, SyncRunData } from '../models/definitions/SyncRun.js';
import type { IWorkspaceRepository } from '../models/definitions/Workspace.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';
import { registerAdapter } from '../sync/registry.js';
import { createFakeAdapter, FAKE_PROVIDER } from '../testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { runJobInProcess } from '../testing/testSeams.js';
import type { JobRunner, SyncJob } from './syncJobs.js';

let db: TestDatabase;
let guard: OutboundGuard;
let workspaces: IWorkspaceRepository;
let integrations: IIntegrationRepository;
let runs: ISyncRunRepository;
let audit: IAuditLogRepository;
let workspaceId: string;

before(async () => {
  // The harness runs each job in this process (testing/testSeams.ts). Forced fixtures: runs
  // replay the fake adapter's fixtures.
  forceSyncModeForTests('fixtures');
  db = await startTestDatabase('todolist_sync_jobs_test');
  guard = installOutboundGuard();
  const m = await import('../models/index.js');
  workspaces = await m.getWorkspaceRepository();
  integrations = await m.getIntegrationRepository();
  runs = await m.getSyncRunRepository();
  audit = await m.getAuditLogRepository();
  workspaceId = (await workspaces.create({ name: 'Jobs', slug: 'jobs', ownerId: 'u-owner' })).id;
  registerAdapter(createFakeAdapter().adapter);
});

after(async () => {
  guard.restore();
  await db.stop();
});

async function fakeIntegration(accountId: string, demo = false): Promise<string> {
  const integration = await integrations.create(workspaceId, {
    connectedBy: 'u-owner',
    provider: FAKE_PROVIDER,
    accountId,
    label: 'Fake',
    authMethod: 'none',
    topicId: 'work',
    ...(demo ? { demo: true } : {}),
  });
  return integration.id;
}

/** The run once the in-process sync is done: its audit entry is the last thing it writes. */
async function finished(runId: string, integrationId: string): Promise<SyncRunData> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const entries = await audit.list(workspaceId, { action: 'sync.run' }, 50);
    if (entries.some((entry) => entry.targetId === integrationId)) {
      const run = await runs.findById(workspaceId, runId);
      assert.ok(run);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not finish`);
}

/** Runs `body` with `runner` starting the jobs (null: the default), then the harness's again. */
async function withRunner(runner: JobRunner | null, body: () => Promise<void>): Promise<void> {
  const { setJobRunnerForTests } = await import('./syncJobs.js');
  setJobRunnerForTests(runner);
  try {
    await body();
  } finally {
    setJobRunnerForTests(runJobInProcess);
  }
}

describe('parseSyncJob', () => {
  it('reads a sync-run or gcal-run job, keeping only its own keys', async () => {
    const { parseSyncJob } = await import('./syncJobs.js');
    assert.deepEqual(
      parseSyncJob({
        action: 'sync-run',
        integrationId: 'i-1',
        runId: 'r-1',
        mode: 'live',
        token: 'FAKE-token-never-kept',
      }),
      { action: 'sync-run', integrationId: 'i-1', runId: 'r-1', mode: 'live' },
    );
    assert.deepEqual(parseSyncJob({ action: 'gcal-run', integrationId: 'i-2', runId: 'x' }), {
      action: 'gcal-run',
      integrationId: 'i-2',
    });
  });

  it('refuses anything else, an HTTP event above all', async () => {
    const { parseSyncJob } = await import('./syncJobs.js');
    for (const event of [
      null,
      'sync-run',
      [],
      {},
      { action: 'sync-db' },
      { action: 'sync-run', integrationId: 'i-1', runId: 'r-1' },
      { action: 'sync-run', integrationId: 'i-1', runId: 'r-1', mode: 'turbo' },
      { action: 'sync-run', integrationId: 1, runId: 'r-1', mode: 'live' },
      { action: 'sync-run', integrationId: 'i 1; drop', runId: 'r-1', mode: 'live' },
      { action: 'gcal-run' },
      { action: 'gcal-run', integrationId: 'i-1', requestContext: {} },
    ]) {
      assert.equal(parseSyncJob(event), null, JSON.stringify(event));
    }
  });
});

describe('enqueueSync', () => {
  it('returns the run id at once; the queued run then runs (here, in this process)', async () => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    const integrationId = await fakeIntegration('jobs-1');
    const { runId } = await enqueueSync(integrationId, 'manual');
    const run = await finished(runId, integrationId);
    assert.deepEqual(
      [run.integrationId, run.trigger, run.status, run.counts['inserted']],
      [integrationId, 'manual', 'partial', 4],
    );
    assert.deepEqual(
      (await runs.listForIntegration(workspaceId, integrationId, 5)).map((r) => r.id),
      [runId],
      'one run: the queued one ran in place',
    );
  });

  it('starts one sync-run job per run: the ids and the mode only', async () => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    const started: SyncJob[] = [];
    await withRunner(
      (job) => {
        started.push(job);
        return Promise.resolve();
      },
      async () => {
        const integrationId = await fakeIntegration('jobs-2');
        const { runId } = await enqueueSync(integrationId, 'manual');
        assert.deepEqual(started, [{ action: 'sync-run', integrationId, runId, mode: 'fixtures' }]);
        assert.equal((await runs.findById(workspaceId, runId))?.status, 'queued');
      },
    );
  });

  it('marks the queued run failed when its job cannot be started, and throws', async () => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    await withRunner(
      () => Promise.reject(new Error('invoke refused')),
      async () => {
        const integrationId = await fakeIntegration('jobs-3');
        await assert.rejects(enqueueSync(integrationId, 'manual'), /invoke refused/);
        const [run] = await runs.listForIntegration(workspaceId, integrationId, 5);
        assert.deepEqual(
          [run?.status, run?.error],
          ['failed', { code: 'enqueue_failed', message: 'Could not queue the sync' }],
        );
      },
    );
  });

  it('refuses an unknown integration', async () => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    await assert.rejects(enqueueSync('no-such-integration', 'manual'), /not found/);
  });

  it('never queues demo data', async () => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    const integrationId = await fakeIntegration('jobs-demo', true);
    await assert.rejects(enqueueSync(integrationId, 'manual'), /demo integration never syncs/);
    assert.deepEqual(await runs.listForIntegration(workspaceId, integrationId, 5), []);
  });
});

describe('enqueueGcalSync', () => {
  it('starts one gcal-run job carrying the integration id only', async () => {
    const { enqueueGcalSync } = await import('./syncJobs.js');
    const started: SyncJob[] = [];
    await withRunner(
      (job) => {
        started.push(job);
        return Promise.resolve();
      },
      async () => {
        await enqueueGcalSync('i-calendar');
        assert.deepEqual(started, [{ action: 'gcal-run', integrationId: 'i-calendar' }]);
      },
    );
  });
});

describe('how a job starts by default', () => {
  it('outside Lambda (no AWS_LAMBDA_FUNCTION_NAME): inline, in this process', async () => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    assert.equal(process.env.AWS_LAMBDA_FUNCTION_NAME, undefined);
    await withRunner(null, async () => {
      const integrationId = await fakeIntegration('jobs-inline');
      const { runId } = await enqueueSync(integrationId, 'manual');
      assert.equal((await finished(runId, integrationId)).status, 'partial');
    });
  });

  it('on Lambda: an async invocation of the function itself, the job as its payload', async (t) => {
    const { enqueueSync } = await import('../testing/syncCalls.js');
    const { LambdaClient } = await import('@aws-sdk/client-lambda');
    const sent: Record<string, unknown>[] = [];
    // No AWS call: the client's send is replaced and records the command it would send.
    t.mock.method(LambdaClient.prototype, 'send', (command: { input: Record<string, unknown> }) => {
      sent.push(command.input);
      return Promise.resolve({ StatusCode: 202 });
    });
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'todolist-dev-api';
    await withRunner(null, async () => {
      const integrationId = await fakeIntegration('jobs-lambda');
      const { runId } = await enqueueSync(integrationId, 'manual');
      assert.equal(sent.length, 1);
      const [input] = sent;
      assert.equal(input?.['FunctionName'], 'todolist-dev-api');
      assert.equal(input['InvocationType'], 'Event');
      assert.deepEqual(JSON.parse(new TextDecoder().decode(input['Payload'] as Uint8Array)), {
        action: 'sync-run',
        integrationId,
        runId,
        mode: 'fixtures',
      });
      assert.equal((await runs.findById(workspaceId, runId))?.status, 'queued');
    }).finally(() => {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    });
  });

  it('never opened a connection outside this machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
