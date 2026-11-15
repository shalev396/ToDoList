/**
 * The owner's Phase 6 ruling: deleting a workspace deletes its dashboards, their versions and its
 * saved views (the cascade's dashboards step). Workspaces deleted before that step existed left
 * theirs behind: unreachable (requireWorkspace answers 404 for a deleted workspace) and never
 * purged. So every dashboard, dashboard version and view whose workspace no longer exists, or is
 * soft-deleted, is removed for good, deleted dashboards too.
 *
 * Counts only, never a value. Idempotent: what it removes is gone, and a live workspace's
 * documents are never touched. The purge runs the same rule nightly (Dashboard.removeOrphans), for
 * what a request in flight writes after its workspace's cascade.
 */
import { DASHBOARD_TABLE_NAME } from '../models/definitions/Dashboard.js';
import { DASHBOARD_VERSION_TABLE_NAME } from '../models/definitions/DashboardVersion.js';
import { VIEW_TABLE_NAME } from '../models/definitions/View.js';
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

export const orphanedDashboards: Migration = {
  id: '2026-11-15-orphaned-dashboards',
  async run(db: Db) {
    const dashboards = db.collection<Doc>(DASHBOARD_TABLE_NAME);
    const versions = db.collection<Doc>(DASHBOARD_VERSION_TABLE_NAME);
    const views = db.collection<Doc>(VIEW_TABLE_NAME);
    const referenced = new Set<string>();
    for (const collection of [dashboards, versions, views]) {
      for (const id of await collection.distinct('workspaceId')) {
        if (typeof id === 'string') referenced.add(id);
      }
    }
    const live = new Set(
      (
        await db
          .collection<Doc>(WORKSPACE_TABLE_NAME)
          .find(
            { _id: { $in: [...referenced] as never[] }, deletedAt: null },
            { projection: { _id: 1 } },
          )
          .toArray()
      ).map((workspace) => String(workspace._id)),
    );
    const gone = [...referenced].filter((id) => !live.has(id));
    const counts = { dashboards: 0, versions: 0, views: 0 };
    if (gone.length === 0) return counts;
    const ofGone = { workspaceId: { $in: gone } };
    // Dashboards before their versions, as the cascade and the purge's sweep remove them.
    counts.dashboards = (await dashboards.deleteMany(ofGone)).deletedCount;
    counts.versions = (await versions.deleteMany(ofGone)).deletedCount;
    counts.views = (await views.deleteMany(ofGone)).deletedCount;
    return counts;
  },
};
