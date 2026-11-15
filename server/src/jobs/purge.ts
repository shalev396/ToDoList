/**
 * The purge (DATA.md §4), meant to run nightly (no schedule invokes it for now):
 * - ends the sync runs still `running` more than 15 minutes after they started (a sync job's
 *   timeout is 5, the function's): `failed` with `timeout`. When such a run's integration was
 *   disconnected, the rows the dead run wrote or revived after the disconnect are deleted again;
 * - hard-deletes Items and Containers soft-deleted more than 30 days ago (swept by a sync, deleted
 *   at the source, or deleted by a user), in every workspace.
 *
 * Global maintenance on purpose: it runs from the `purge` direct-invoke action only (lambda.ts),
 * through the classes' explicitly global reads and writes: SyncRun.reapStuck (the reaper),
 * Item.purgeDeletedBefore and Container.purgeDeletedBefore. Dashboard versions are pruned where
 * they always are, on each save, not here.
 */
import { Integration } from '../classes/integration/index.js';
import { Container, Item } from '../classes/item/index.js';
import { SyncEngine } from '../classes/sync/SyncEngine.js';
import { SyncRun } from '../classes/sync/SyncRun.js';
import { logger } from '../services/logger.js';

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
 * Ends the runs still `running` STALE_RUN_AFTER_MS after they started (SyncRun.reapStuck: a
 * conditional write, so a run that finishes meanwhile keeps its own outcome). When such a run's
 * integration was disconnected, what the dead run wrote or revived after the disconnect is
 * deleted again. Returns how many runs it ended.
 */
async function endStaleRuns(now: Date): Promise<number> {
  const reaped = await SyncRun.reapStuck(now, STALE_RUN_AFTER_MS, STALE_RUNS_PER_PURGE);
  for (const run of reaped) {
    if ((await Integration.forWorker(run.integrationId)) !== null) continue;
    // Disconnected: what the dead run wrote or revived after the disconnect is deleted again.
    await SyncEngine.deleteWritesOf({ id: run.integrationId, workspaceId: run.workspaceId }, now);
  }
  if (reaped.length > 0) logger.warn('sync runs timed out', { count: reaped.length });
  return reaped.length;
}

export async function purgeDeleted(now: Date = new Date()): Promise<PurgeResult> {
  const timedOutRuns = await endStaleRuns(now);
  const before = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  const items = await Item.purgeDeletedBefore(before);
  const containers = await Container.purgeDeletedBefore(before);
  return { before, items, containers, timedOutRuns };
}
