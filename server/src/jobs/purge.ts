/**
 * The purge (DATA.md §4), meant to run nightly (no schedule invokes it for now):
 * - ends the sync runs still `running` more than 15 minutes after they started (a sync job's
 *   timeout is 5, the function's): `failed` with `timeout`. When such a run's integration was
 *   disconnected, the rows the dead run wrote or revived after the disconnect are deleted again;
 * - hard-deletes Items and Containers soft-deleted more than 30 days ago (swept by a sync, deleted
 *   at the source, or deleted by a user), in every workspace.
 *
 * Global maintenance on purpose: it runs from the `purge` direct-invoke action only (lambda.ts),
 * through the repositories' explicitly global purgeDeletedBefore() and
 * listRunningStartedBefore().
 */
import {
  getContainerRepository,
  getIntegrationRepository,
  getItemRepository,
  getSyncRunRepository,
} from '../models/index.js';
import { logger } from '../services/logger.js';
import { SYNC_ERROR_MESSAGES } from '../sync/runSync.js';

export const PURGE_AFTER_DAYS = 30;
/** A run still `running` this long after it started is dead: a sync job's timeout is 5 min. */
export const STALE_RUN_AFTER_MS = 15 * 60 * 1000;
/** Stale runs one purge ends at most (the next purge ends the rest). */
const STALE_RUNS_PER_PURGE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeResult {
  /** Rows soft-deleted before this were removed. */
  before: Date;
  items: number;
  containers: number;
  /** Runs still `running` long after they started, now `failed` with `timeout`. */
  timedOutRuns: number;
}

/**
 * Ends the runs still `running` STALE_RUN_AFTER_MS after they started (a conditional write, so a
 * run that finishes meanwhile keeps its own outcome). Returns how many it ended.
 */
async function endStaleRuns(now: Date): Promise<number> {
  const runs = await getSyncRunRepository();
  const stale = await runs.listRunningStartedBefore(
    new Date(now.getTime() - STALE_RUN_AFTER_MS),
    STALE_RUNS_PER_PURGE,
  );
  const error = { code: 'timeout', message: SYNC_ERROR_MESSAGES.timeout };
  let ended = 0;
  for (const run of stale) {
    const closed = await runs.updateIfStatus(run.workspaceId, run.id, ['running'], {
      status: 'failed',
      finishedAt: now,
      error,
    });
    if (closed === null) continue;
    ended += 1;
    if ((await (await getIntegrationRepository()).findByIdForWorker(run.integrationId)) !== null) {
      continue;
    }
    // Disconnected: what the dead run wrote or revived after the disconnect is deleted again.
    const { workspaceId, integrationId } = run;
    await (await getItemRepository()).softDeleteForIntegration(workspaceId, integrationId, now);
    await (
      await getContainerRepository()
    ).softDeleteForIntegration(workspaceId, integrationId, now);
  }
  if (ended > 0) logger.warn('sync runs timed out', { count: ended });
  return ended;
}

export async function purgeDeleted(now: Date = new Date()): Promise<PurgeResult> {
  const timedOutRuns = await endStaleRuns(now);
  const before = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  const items = await (await getItemRepository()).purgeDeletedBefore(before);
  const containers = await (await getContainerRepository()).purgeDeletedBefore(before);
  return { before, items, containers, timedOutRuns };
}
