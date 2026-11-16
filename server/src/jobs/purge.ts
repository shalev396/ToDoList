/**
 * The purge (DATA.md §4), run only when invoked directly (no schedule invokes it):
 * - ends the sync runs still `running` more than 15 minutes after they started (a sync job's
 *   timeout is 5, the function's): `failed` with `timeout`. When such a run's integration was
 *   disconnected, the rows the dead run wrote or revived after the disconnect are deleted again;
 * - hard-deletes Items and Containers soft-deleted more than 30 days ago (swept by a sync, deleted
 *   at the source, or deleted by a user), in every workspace;
 * - removes the dashboards, versions and views of workspaces that are gone or deleted
 *   (Dashboard.removeOrphans: what a request in flight wrote after its workspace's cascade), and
 *   their topics (Topic.removeOrphans).
 *
 * Global maintenance on purpose: it runs from the `purge` direct-invoke action only (lambda.ts),
 * through the classes' explicitly global reads and writes: SyncRun.reapStuck (the reaper) and
 * SyncedRows.purgeDeletedBefore (internal to the sync: only this job may name it). Dashboard
 * versions are pruned where they always are, on each save, not here.
 */
import { Dashboard } from '../classes/dashboard/Dashboard.js';
import { Integration } from '../classes/integration/index.js';
import { SyncedRows } from '../classes/sync/SyncedRows.js';
import { SyncRun } from '../classes/sync/SyncRun.js';
import { Topic } from '../classes/workspace/Topic.js';
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
  /** What deleted workspaces had left: dashboards (deleted ones too), versions, views. */
  orphanedDashboards: { dashboards: number; versions: number; views: number };
  /** And their topics. */
  orphanedTopics: number;
}

/**
 * Ends the runs still `running` STALE_RUN_AFTER_MS after they started (SyncRun.reapStuck: a
 * conditional write, so a run that finishes meanwhile keeps its own outcome), one at a time: when
 * a run's integration was disconnected, what the dead run wrote or revived after the disconnect is
 * deleted again before the next run is reaped. A throw stops the purge with every later run still
 * `running`, so the next purge does both for them. Returns how many runs it ended.
 */
async function endStaleRuns(now: Date): Promise<number> {
  const reaped = await SyncRun.reapStuck(
    now,
    STALE_RUN_AFTER_MS,
    STALE_RUNS_PER_PURGE,
    async (run) => {
      if (await Integration.isConnected(run.integrationId)) return;
      // Disconnected: what the dead run wrote or revived after the disconnect is deleted again.
      await SyncedRows.of({ id: run.integrationId, workspaceId: run.workspaceId }).softDeleteAll(
        now,
      );
    },
  );
  if (reaped.length > 0) logger.warn('sync runs timed out', { count: reaped.length });
  return reaped.length;
}

export async function purgeDeleted(now: Date = new Date()): Promise<PurgeResult> {
  const timedOutRuns = await endStaleRuns(now);
  const before = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  const { items, containers } = await SyncedRows.purgeDeletedBefore(before);
  const orphanedDashboards = await Dashboard.removeOrphans();
  const orphanedTopics = await Topic.removeOrphans();
  return { before, items, containers, timedOutRuns, orphanedDashboards, orphanedTopics };
}
