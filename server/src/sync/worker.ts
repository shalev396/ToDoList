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
 * A failed run counts once toward the integration's failed runs in a row, however often it is
 * tried (the `__run__` state remembers the runs it counted). What is logged is ids and a code;
 * the error thrown for a retry carries no more, so nothing else reaches Lambda's own log line.
 */
import { GCAL_RUN_ACTION } from '../../infra/lib/constants.js';
import { runScheduledGcalSync } from '../gcal/scheduledSync.js';
import { logger } from '../services/logger.js';
import type { SyncJob } from '../services/syncJobs.js';
import { runIntegrationSync } from './runSync.js';
import type { SyncErrorCode } from './types.js';

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

export async function runSyncJob(
  job: SyncJob,
  run: typeof runIntegrationSync = runIntegrationSync,
  runGcal: typeof runScheduledGcalSync = runScheduledGcalSync,
): Promise<void> {
  const ids = { action: job.action, integrationId: job.integrationId };
  if (job.action === GCAL_RUN_ACTION) {
    try {
      await runGcal(job.integrationId);
    } catch (error) {
      logger.error('sync worker: calendar run threw', { ...ids, error });
      throw new RetrySyncJob(job, 'threw');
    }
    return;
  }
  let code: string | undefined;
  try {
    // A test that forced fixtures (testSwitches) pins that mode in the engine, whatever the job says.
    const summary = await run(job.integrationId, { runId: job.runId, mode: job.mode });
    if (summary.status === 'failed') code = summary.error?.code;
  } catch (error) {
    logger.error('sync worker: run threw', { ...ids, runId: job.runId, error });
    throw new RetrySyncJob(job, 'threw');
  }
  if (code !== undefined && RETRYABLE.has(code)) {
    logger.warn('sync worker: run failed, retrying', { ...ids, runId: job.runId, code });
    throw new RetrySyncJob(job, `failed with ${code}`);
  }
}
