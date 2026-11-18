/**
 * The sync worker (BACKEND.md §3): runs one background job (services/syncJobs.ts). On Lambda the
 * job is an async invocation of the API function by itself, which lambda.ts hands here; elsewhere
 * it runs in the process that started it.
 * - `sync-run`: the queued run of one integration that the job names;
 * - `gcal-run`: one Google Calendar push + pull (gcal/scheduledSync.ts).
 *
 * A job throws, so Lambda's async invocation runs it again (twice, then drops it), when:
 * - the run threw (the database was unreachable, say);
 * - the run failed for a reason that may pass: the provider was unreachable, rate-limited or
 *   erroring, or an internal error;
 * - a calendar run threw (a refused or failed push is recorded on its run and not retried: the
 *   next gcal-dispatch lists the integration again anyway).
 * Other failed runs are recorded on the run and the integration, and not retried: they need the
 * user (auth_failed, a paused or expired integration, a disconnect) or a code fix (no_adapter,
 * adapter_error, invalid_data, fixtures_missing), and would fail the same way again.
 *
 * After a run that didn't fail, and after a calendar run, the members with travel in the
 * integration's workspace get their legs made again (TravelPlanner.afterSync: its events may have
 * moved, been cancelled or added). Travel failing is logged and never fails or retries the job.
 *
 * A failed run counts once toward the integration's failed runs in a row, however often it is
 * tried (the `__run__` state remembers the runs it counted). What is logged is ids and a code;
 * the error thrown for a retry carries no more, so nothing else reaches Lambda's own log line.
 */
import { GCAL_RUN_ACTION } from '../../infra/lib/constants.js';
import { Integration } from '../classes/integration/index.js';
import type { SyncRunOptions } from '../classes/sync/index.js';
import { TravelPlanner } from '../classes/travel/index.js';
import { runScheduledGcalSync } from '../gcal/scheduledSync.js';
import { logger } from '../services/logger.js';
import type { SyncJob } from '../services/syncJobs.js';
import type { SyncErrorCode, SyncRunSummary } from './types.js';

const RETRYABLE: ReadonlySet<string> = new Set<SyncErrorCode>([
  'network',
  'server_error',
  'rate_limited',
  'internal',
]);

/** A job that a retry may fix: thrown so that Lambda runs it again. */
export class RetrySyncJob extends Error {
  constructor(job: SyncJob, reason: string) {
    super(`${job.action} ${job.integrationId} ${reason}: retry`);
    this.name = 'RetrySyncJob';
  }
}

/** One sync of one integration by id (Integration.runSync; a test's stand-in). */
export type SyncRunner = (
  integrationId: string,
  options: SyncRunOptions,
) => Promise<SyncRunSummary>;

const runIntegrationSync: SyncRunner = (integrationId, options) =>
  Integration.runSync(integrationId, options);

/** What travel does after a sync of one integration (TravelPlanner.afterSync; a test's stand-in). */
export type AfterSync = (integrationId: string) => Promise<void>;

const travelAfterSync: AfterSync = (integrationId) => TravelPlanner.afterSync(integrationId);

/** Travel after a sync: its failure is logged, never the job's. */
async function refreshTravel(job: SyncJob, afterSync: AfterSync): Promise<void> {
  try {
    await afterSync(job.integrationId);
  } catch (error) {
    logger.error('sync worker: travel after the sync failed', {
      action: job.action,
      integrationId: job.integrationId,
      error,
    });
  }
}

export async function runSyncJob(
  job: SyncJob,
  run: SyncRunner = runIntegrationSync,
  runGcal: typeof runScheduledGcalSync = runScheduledGcalSync,
  afterSync: AfterSync = travelAfterSync,
): Promise<void> {
  const ids = { action: job.action, integrationId: job.integrationId };
  if (job.action === GCAL_RUN_ACTION) {
    try {
      await runGcal(job.integrationId);
    } catch (error) {
      logger.error('sync worker: calendar run threw', { ...ids, error });
      throw new RetrySyncJob(job, 'threw');
    }
    await refreshTravel(job, afterSync);
    return;
  }
  let code: string | undefined;
  let failed = false;
  try {
    // A test that forced fixtures (testSwitches) pins that mode in the engine, whatever the job says.
    const summary = await run(job.integrationId, { runId: job.runId, mode: job.mode });
    failed = summary.status === 'failed';
    if (failed) code = summary.error?.code;
  } catch (error) {
    logger.error('sync worker: run threw', { ...ids, runId: job.runId, error });
    throw new RetrySyncJob(job, 'threw');
  }
  if (!failed) await refreshTravel(job, afterSync);
  if (code !== undefined && RETRYABLE.has(code)) {
    logger.warn('sync worker: run failed, retrying', { ...ids, runId: job.runId, code });
    throw new RetrySyncJob(job, `failed with ${code}`);
  }
}
