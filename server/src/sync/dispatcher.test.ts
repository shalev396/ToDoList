import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IIntegrationRepository, IntegrationData } from '../models/definitions/Integration.js';
import type { ISyncRunRepository } from '../models/definitions/SyncRun.js';
import type { IWorkspaceRepository } from '../models/definitions/Workspace.js';
import type { JobRunner, SyncJob } from '../services/syncJobs.js';
import { findSecrets } from '../services/secretPatterns.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { runJobInProcess } from '../testing/testSeams.js';
import type { IntegrationStatus } from '../types/domain.js';

let db: TestDatabase;
let workspaces: IWorkspaceRepository;
let integrations: IIntegrationRepository;
let runs: ISyncRunRepository;
let sent: SyncJob[] = [];
let failFor: string | null = null;

before(async () => {
  db = await startTestDatabase('todolist_dispatcher_test', { ENV: 'dev' });
  const m = await import('../models/index.js');
  workspaces = await m.getWorkspaceRepository();
  integrations = await m.getIntegrationRepository();
  runs = await m.getSyncRunRepository();
  // Jobs are recorded, not run; one integration's job can be made to fail to start.
  const { setJobRunnerForTests } = await import('../services/syncJobs.js');
  const runner: JobRunner = (job) => {
    if (job.integrationId === failFor) return Promise.reject(new Error('invoke refused'));
    sent.push(job);
    return Promise.resolve();
  };
  setJobRunnerForTests(runner);
});

after(async () => {
  const { setJobRunnerForTests } = await import('../services/syncJobs.js');
  setJobRunnerForTests(runJobInProcess);
  await db.stop();
});

afterEach(() => {
  sent = [];
  failFor = null;
});

/** u-owner, who connects every integration here, as an active member. */
async function member(workspaceId: string): Promise<void> {
  const m = await import('../models/index.js');
  await (
    await m.getMembershipRepository()
  ).create(workspaceId, { userId: 'u-owner', role: 'owner' });
}

async function connect(
  workspaceId: string,
  accountId: string,
  status: IntegrationStatus,
  credentialId: string | null = `cred-${accountId}`,
): Promise<IntegrationData> {
  return integrations.create(workspaceId, {
    connectedBy: 'u-owner',
    provider: 'jira',
    accountId,
    label: `Jira ${accountId}`,
    authMethod: 'api_token_basic',
    topicId: 'work',
    status,
    credentialId,
  });
}

describe('dispatchAllSyncs', () => {
  // Dispatched: active, expiring, and error after failed runs (retried). Not dispatched: expired,
  // paused, deleted, failed auth (lastError auth_failed: reconnect first), no credential yet, and
  // one whose owner is no longer a member.
  let dispatchable: IntegrationData[];

  before(async () => {
    const a = await workspaces.create({ name: 'A', slug: 'dispatch-a', ownerId: 'u-a' });
    const b = await workspaces.create({ name: 'B', slug: 'dispatch-b', ownerId: 'u-b' });
    await member(a.id);
    await member(b.id);
    dispatchable = [
      await connect(a.id, 'a-active', 'active'),
      await connect(a.id, 'a-expiring', 'expiring'),
      await connect(a.id, 'a-error', 'error'),
      await connect(b.id, 'b-active', 'active'),
    ];
    await connect(a.id, 'a-expired', 'expired');
    await connect(a.id, 'a-paused', 'paused');
    const deleted = await connect(b.id, 'b-deleted', 'active');
    await integrations.softDelete(b.id, deleted.id);
    // Failed auth: the user must reconnect it first, so it is not retried on a schedule.
    const reconnect = await connect(b.id, 'b-auth-failed', 'active');
    await integrations.update(b.id, reconnect.id, {
      status: 'error',
      lastError: { code: 'auth_failed', message: 'Reconnect required' },
    });
    // No credential (R6): a run could only fail on the missing secret, schedule after schedule.
    // Created without one, an integration starts in error with credential_missing (R5).
    const missing = await connect(b.id, 'b-no-credential', 'error', null);
    await integrations.update(b.id, missing.id, {
      lastError: {
        code: 'credential_missing',
        message: 'Save the credential to finish connecting',
      },
    });
    await connect(a.id, 'a-active-no-credential', 'active', null);
    // Its owner left: never scheduled again (ruling 6, defence in depth).
    await integrations.create(a.id, {
      connectedBy: 'u-left',
      provider: 'jira',
      accountId: 'a-owner-left',
      label: 'Jira of a former member',
      authMethod: 'api_token_basic',
      topicId: 'work',
      status: 'active',
      credentialId: 'cred-a-owner-left',
    });
  });

  it('queues one run per dispatchable integration; each job carries only ids and the mode', async () => {
    const { dispatchAllSyncs } = await import('./dispatcher.js');
    assert.deepEqual(await dispatchAllSyncs(), { dispatched: 4, failed: 0 });
    assert.equal(sent.length, 4);

    const byIntegration = new Map(dispatchable.map((integration) => [integration.id, integration]));
    const seen: string[] = [];
    for (const job of sent) {
      const message = job as unknown as Record<string, unknown>;
      assert.deepEqual(Object.keys(message).sort(), ['action', 'integrationId', 'mode', 'runId']);
      assert.equal(message['action'], 'sync-run');
      assert.equal(message['mode'], 'live');
      assert.deepEqual(findSecrets(message), []);
      const integration = byIntegration.get(String(message['integrationId']));
      assert.ok(integration, 'a dispatchable integration');
      seen.push(integration.id);
      const run = await runs.findById(integration.workspaceId, String(message['runId']));
      assert.deepEqual(
        [run?.integrationId, run?.status, run?.trigger],
        [integration.id, 'queued', 'schedule'],
      );
    }
    assert.deepEqual(seen.sort(), [...byIntegration.keys()].sort());
  });

  it('passes its trigger on to the runs', async () => {
    const { dispatchAllSyncs } = await import('./dispatcher.js');
    await dispatchAllSyncs('manual');
    for (const job of sent) {
      assert.ok(job.action === 'sync-run');
      const integration = dispatchable.find((candidate) => candidate.id === job.integrationId);
      assert.ok(integration);
      assert.equal((await runs.findById(integration.workspaceId, job.runId))?.trigger, 'manual');
    }
  });

  it('one job that cannot be started does not stop the rest, and its queued run is marked failed', async () => {
    const { dispatchAllSyncs } = await import('./dispatcher.js');
    const unlucky = dispatchable[1];
    assert.ok(unlucky);
    failFor = unlucky.id;
    assert.deepEqual(await dispatchAllSyncs(), { dispatched: 3, failed: 1 });
    const [latest] = await runs.listForIntegration(unlucky.workspaceId, unlucky.id, 1);
    assert.deepEqual(
      [latest?.status, latest?.error],
      ['failed', { code: 'enqueue_failed', message: 'Could not queue the sync' }],
    );
  });
});
