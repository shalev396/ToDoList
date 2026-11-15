/**
 * gcal-dispatch: only live, read & write OAuth Google Calendar integrations that their
 * workspace's primary calendar is on get a background job, one each, carrying the integration id
 * and nothing else.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IIntegrationRepository, IntegrationData } from '../models/definitions/Integration.js';
import type { JobRunner, SyncJob } from '../services/syncJobs.js';
import { findSecrets } from '../services/secretPatterns.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { runJobInProcess } from '../testing/testSeams.js';
import type { IntegrationMode, IntegrationStatus } from '../types/domain.js';

let db: TestDatabase;
let integrations: IIntegrationRepository;
let sent: SyncJob[] = [];
let failFor: string | null = null;
const eligible: IntegrationData[] = [];

interface Variant {
  status?: IntegrationStatus;
  provider?: 'google_calendar' | 'jira';
  authMethod?: 'oauth' | 'service_account' | 'api_token_basic';
  /** The calendar its workspace's primary calendar is on it with; null: no primary calendar. */
  target?: string | null;
  /** Its workspace's primary calendar is on another integration. */
  primaryElsewhere?: boolean;
  credentialId?: string | null;
  mode?: IntegrationMode;
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
  const workspaces = await m.getWorkspaceRepository();
  const memberships = await m.getMembershipRepository();

  /** One workspace per integration: each has its own primary calendar (or none). */
  const make = async (
    accountId: string,
    over: Variant = {},
    connectedBy = 'u-g',
  ): Promise<IntegrationData> => {
    const workspaceId = (
      await workspaces.create({ name: 'G', slug: `gcal-d-${accountId}`, ownerId: 'u-g' })
    ).id;
    await memberships.create(workspaceId, { userId: 'u-g', role: 'owner' });
    const integration = await integrations.create(workspaceId, {
      connectedBy,
      provider: over.provider ?? 'google_calendar',
      accountId,
      label: accountId,
      authMethod: over.authMethod ?? 'oauth',
      topicId: 'personal',
      // Pushing writes to the calendar: only a read & write integration is scheduled.
      mode: over.mode ?? 'read_write',
      status: over.status ?? 'active',
      credentialId: over.credentialId === undefined ? `cred-${accountId}` : over.credentialId,
      config: { calendars: [] },
    });
    if (over.target !== null) {
      await workspaces.setPrimaryCalendar(workspaceId, {
        integrationId: over.primaryElsewhere === true ? 'another-integration' : integration.id,
        calendarId: over.target ?? 'primary',
      });
    }
    return integration;
  };

  eligible.push(
    await make('g-active'),
    await make('g-expiring', { status: 'expiring' }),
    await make('g-error', { status: 'error' }),
  );
  await make('g-paused', { status: 'paused' });
  await make('g-expired', { status: 'expired' });
  await make('g-no-target', { target: null });
  await make('g-not-primary', { primaryElsewhere: true });
  await make('g-no-credential', { credentialId: null });
  await make('g-service-account', { authMethod: 'service_account' });
  await make('g-jira', { provider: 'jira', authMethod: 'api_token_basic' });
  // Read-only (the default of every connection): never pushed on a schedule.
  await make('g-read-only', { mode: 'read' });
  const deleted = await make('g-deleted');
  await integrations.softDelete(deleted.workspaceId, deleted.id);
  // Its owner left: never scheduled again (PERMISSIONS-V2 ruling 6).
  await make('g-owner-left', {}, 'u-left');
  const authFailed = await make('g-auth-failed');
  await integrations.update(authFailed.workspaceId, authFailed.id, {
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
  it('starts a job only for live OAuth calendars their workspace pushes to; jobs carry the id only', async () => {
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
