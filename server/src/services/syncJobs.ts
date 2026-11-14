/**
 * Background syncs, without a queue (like Elytra). A sync runs as a job, apart from the request
 * or action that asked for it, and the caller gets the queued run's id at once to poll:
 * - on Lambda, the function invokes ITSELF asynchronously (InvocationType `Event`) with the job as
 *   a direct-invoke event, and lambda.ts runs it (sync/worker.ts). It finds its own name in
 *   AWS_LAMBDA_FUNCTION_NAME, which Lambda sets in every execution environment. Lambda retries a
 *   job that throws twice more (about one, then two minutes later), then drops it;
 * - anywhere else (src/local.ts, the stage-backed local API), the job runs inline, in this
 *   process: started at once and not awaited, so the caller still answers right away.
 *
 * The two jobs carry ids and the mode only: never a secret, a token or provider data.
 * - `{action: 'sync-run', integrationId, runId, mode}`: one queued run of one integration
 *   (enqueueSync: "Sync now", the sync-dispatch action, MCP);
 * - `{action: 'gcal-run', integrationId}`: one Google Calendar push + pull (enqueueGcalSync, the
 *   gcal-dispatch action). No run exists yet: it opens when the push starts.
 */
import type { LambdaClient } from '@aws-sdk/client-lambda';

import { GCAL_RUN_ACTION, SYNC_RUN_ACTION } from '../../infra/lib/constants.js';
import { assertUnderTest } from '../config/testSwitches.js';
import { getIntegrationRepository, getSyncRunRepository } from '../models/index.js';
import { SYNC_ERROR_MESSAGES } from '../sync/runSync.js';
import { syncModeFor } from '../sync/syncMode.js';
import type { SyncTrigger } from '../types/domain.js';
import type { SyncMode } from '../types/env.d.ts';
import { logger } from './logger.js';

export interface SyncRunJob {
  action: typeof SYNC_RUN_ACTION;
  integrationId: string;
  runId: string;
  mode: SyncMode;
}

export interface GcalRunJob {
  action: typeof GCAL_RUN_ACTION;
  integrationId: string;
}

export type SyncJob = SyncRunJob | GcalRunJob;

/** Integration and run ids are UUIDs; anything else in a job is not ours. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The job a direct invoke carries, with exactly its own keys; null when the event is not a
 * well-formed job. An API Gateway event always has `requestContext`, so HTTP is never a job.
 */
export function parseSyncJob(event: unknown): SyncJob | null {
  if (typeof event !== 'object' || event === null || 'requestContext' in event) return null;
  const { action, integrationId, runId, mode } = event as Record<string, unknown>;
  if (typeof integrationId !== 'string' || !ID.test(integrationId)) return null;
  if (action === GCAL_RUN_ACTION) return { action, integrationId };
  if (action !== SYNC_RUN_ACTION) return null;
  if (typeof runId !== 'string' || !ID.test(runId)) return null;
  if (mode !== 'live' && mode !== 'fixtures') return null;
  return { action, integrationId, runId, mode };
}

/** Starts one job: an async invocation of this function on Lambda, a run in this process elsewhere. */
export type JobRunner = (job: SyncJob) => Promise<void>;

let lambda: LambdaClient | null = null;

/** Outside Lambda: the job runs here and now, not awaited; a throw is logged (no retry). */
function runInline(job: SyncJob): void {
  void import('../sync/worker.js')
    .then(({ runSyncJob }) => runSyncJob(job))
    .catch((error: unknown) => {
      logger.error('background sync job failed', {
        action: job.action,
        integrationId: job.integrationId,
        error,
      });
    });
}

const startJob: JobRunner = async (job) => {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME ?? '';
  if (functionName === '') {
    runInline(job);
    return;
  }
  // Loaded on first use: only a deployed function invokes itself.
  const { InvokeCommand, LambdaClient } = await import('@aws-sdk/client-lambda');
  lambda ??= new LambdaClient({});
  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(job)),
    }),
  );
};

let runner: JobRunner = startJob;

/** Tests only (node:test): replaces how a job starts; null restores it. It throws in a server. */
export function setJobRunnerForTests(replacement: JobRunner | null): void {
  assertUnderTest('setJobRunnerForTests');
  runner = replacement ?? startJob;
}

/**
 * Queues one sync and returns the queued run's id. The lookup is global (by id): the caller must
 * already have checked that the user may sync this integration. Never for a demo integration
 * (seed/seedWorkspace.ts), whose credential is FAKE. When the job cannot be started (the invoke
 * failed), the queued run ends `failed` with `enqueue_failed` and this throws.
 */
export async function enqueueSync(
  integrationId: string,
  trigger: SyncTrigger,
): Promise<{ runId: string }> {
  const integration = await (await getIntegrationRepository()).findByIdForWorker(integrationId);
  if (integration === null) throw new Error('enqueueSync: integration not found');
  // Demo data never syncs: its credential is FAKE (the dispatcher and "Sync now" skip it first).
  if (integration.demo) throw new Error('enqueueSync: a demo integration never syncs');
  const runs = await getSyncRunRepository();
  const { workspaceId } = integration;
  const queued = await runs.create(workspaceId, { integrationId, trigger, status: 'queued' });
  const mode = syncModeFor(integration);

  try {
    await runner({ action: SYNC_RUN_ACTION, integrationId, runId: queued.id, mode });
  } catch (error) {
    await runs.update(workspaceId, queued.id, {
      status: 'failed',
      finishedAt: new Date(),
      error: { code: 'enqueue_failed', message: SYNC_ERROR_MESSAGES.enqueue_failed },
    });
    throw error;
  }
  return { runId: queued.id };
}

/** Queues one Google Calendar push + pull. No run row yet: the run opens when the push starts. */
export async function enqueueGcalSync(integrationId: string): Promise<void> {
  await runner({ action: GCAL_RUN_ACTION, integrationId });
}
