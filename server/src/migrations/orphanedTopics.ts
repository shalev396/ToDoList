/**
 * The owner's phase 7 ruling: topics go with their workspace (the cascade's topics step).
 * Workspaces deleted before that step existed left theirs behind: unreachable (requireWorkspace
 * answers 404 for a deleted workspace) and never purged. So every topic whose workspace no longer
 * exists, or is soft-deleted, is removed for good.
 *
 * Counts only, never a value. Idempotent: what it removes is gone, and a live workspace's topics
 * are never touched (one stored without `deletedAt` is live too). "Gone or live" is read from the
 * primary, ids only, before anything is deleted, so a failed read deletes nothing. The purge runs
 * the same rule when invoked (Topic.removeOrphans; no schedule), for what a request in flight writes after its
 * workspace's cascade.
 */
import { TOPIC_TABLE_NAME } from '../models/definitions/Topic.js';
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

/** The decision "gone or live" is read where every committed workspace is visible. */
const PRIMARY = { readPreference: 'primary' } as const;

export const orphanedTopics: Migration = {
  id: '2026-11-16-orphaned-topics',
  async run(db: Db) {
    const topics = db.collection<Doc>(TOPIC_TABLE_NAME);
    const referenced = (await topics.distinct('workspaceId', {}, PRIMARY)).filter(
      (id): id is string => typeof id === 'string',
    );
    if (referenced.length === 0) return { topics: 0 };
    const live = new Set(
      (
        await db
          .collection<Doc>(WORKSPACE_TABLE_NAME)
          .find(
            { _id: { $in: referenced as never[] }, deletedAt: null },
            { projection: { _id: 1 }, ...PRIMARY },
          )
          .toArray()
      ).map((workspace) => String(workspace._id)),
    );
    const gone = referenced.filter((id) => !live.has(id));
    if (gone.length === 0) return { topics: 0 };
    return { topics: (await topics.deleteMany({ workspaceId: { $in: gone } })).deletedCount };
  },
};
