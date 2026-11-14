/**
 * gcal-dispatch: only live OAuth Google Calendar integrations with a push target get a
 * background job, one each, carrying the integration id and nothing else.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IIntegrationRepository, IntegrationData } from '../models/definitions/Integration.js';
import type { JobRunner, SyncJob } from '../services/syncJobs.js';
import { findSecrets } from '../services/secretPatterns.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { runJobInProcess } from '../testing/testSeams.js';
import type { IntegrationStatus } from '../types/domain.js';

let db: TestDatabase;
let integrations: IIntegrationRepository;
let workspaceId: string;
let sent: SyncJob[] = [];
let failFor: string | null = null;
const eligible: IntegrationData[] = [];

interface Variant {
  status?: IntegrationStatus;
  provider?: 'google_calendar' | 'jira';
  authMethod?: 'oauth' | 'service_account' | 'api_token_basic';
  target?: string | null;
  credentialId?: string | null;
}

before(async () => {
  db = await startTestDatabase('todolist_gcal_dispatch_test', { ENV: 'dev' });
  const m = await import('../models/index.js');
  integrations = await m.getIntegrationRepository();
  // Jobs are recorded, not run; one integration's job can be made to fail to start.
  const { setJobRunnerForTests } = await import('../services/syncJobs.js');
  const runner: JobRunner = (job) => {
    if (job.integrationId === failFor) return Promise.reject(new Error('invoke refused'));
    sent.push(job);
    return Promise.resolve();
  };
  setJobRunnerForTests(runner);
  workspaceId = (
    await (await m.getWorkspaceRepository()).create({ name: 'G', slug: 'gcal-d', ownerId: 'u-g' })
  ).id;
  await (await m.getMembershipRepository()).create(workspaceId, { userId: 'u-g', role: 'owner' });

  const make = (accountId: string, over: Variant = {}): Promise<IntegrationData> =>
    integrations.create(workspaceId, {
      connectedBy: 'u-g',
      provider: over.provider ?? 'google_calendar',
      accountId,
      label: accountId,
      authMethod: over.authMethod ?? 'oauth',
      topicId: 'personal',
      status: over.status ?? 'active',
      credentialId: over.credentialId === undefined ? `cred-${accountId}` : over.credentialId,
      config: over.target === null ? {} : { targetCalendarId: over.target ?? 'primary' },
    });

  eligible.push(
    await make('g-active'),
    await make('g-expiring', { status: 'expiring' }),
    await make('g-error', { status: 'error' }),
  );
  await make('g-paused', { status: 'paused' });
  await make('g-expired', { status: 'expired' });
  await make('g-no-target', { target: null });
  await make('g-no-credential', { credentialId: null });
  await make('g-service-account', { authMethod: 'service_account' });
  await make('g-jira', { provider: 'jira', authMethod: 'api_token_basic' });
  const deleted = await make('g-deleted');
  await integrations.softDelete(workspaceId, deleted.id);
  // Its owner left: never scheduled again (PERMISSIONS-V2 ruling 6).
  await integrations.create(workspaceId, {
    connectedBy: 'u-left',
    provider: 'google_calendar',
    accountId: 'g-owner-left',
    label: 'g-owner-left',
    authMethod: 'oauth',
    topicId: 'personal',
    status: 'active',
    credentialId: 'cred-g-owner-left',
    config: { targetCalendarId: 'primary' },
  });
  const authFailed = await make('g-auth-failed');
  await integrations.update(workspaceId, authFailed.id, {
    status: 'error',
    lastError: { code: 'auth_failed', message: 'Reconnect required' },
  });
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

describe('dispatchGcalSyncs', () => {
  it('starts a job only for live OAuth calendars with a push target; jobs carry the id only', async () => {
    const { dispatchGcalSyncs } = await import('./gcalDispatcher.js');
    assert.deepEqual(await dispatchGcalSyncs(), { dispatched: 3, failed: 0 });
    assert.equal(sent.length, 3);
    const ids: string[] = [];
    for (const job of sent) {
      const message = job as unknown as Record<string, unknown>;
      assert.deepEqual(Object.keys(message).sort(), ['action', 'integrationId']);
      assert.equal(message['action'], 'gcal-run');
      assert.deepEqual(findSecrets(message), []);
      ids.push(String(message['integrationId']));
    }
    assert.deepEqual(ids.sort(), eligible.map((integration) => integration.id).sort());
  });

  it('counts a job that could not be started and carries on with the rest', async () => {
    const { dispatchGcalSyncs } = await import('./gcalDispatcher.js');
    const [first] = eligible;
    assert.ok(first);
    failFor = first.id;
    assert.deepEqual(await dispatchGcalSyncs(), { dispatched: 2, failed: 1 });
  });
});
