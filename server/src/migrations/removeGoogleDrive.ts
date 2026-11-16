/**
 * Google Drive is gone (DECISIONS: Drive removed, with the file-tree block). For a stage that held
 * Drive data:
 * 1. every live google_drive integration is disconnected as a user's disconnect would: `deletedAt`,
 *    its credential hard-deleted (then checked gone), its items and containers soft-deleted (the
 *    purge job removes them later), and an `integration.disconnect` audit entry (actor `system`);
 * 2. every `fileTree` block leaves the dashboards' drafts and published copies, with its layout
 *    cells, so no stored dashboard names a block type the code no longer reads.
 *
 * Saved history snapshots are left as they are. Idempotent: a deleted integration and a dashboard
 * without a file tree are never changed again.
 */
import { randomUUID } from 'node:crypto';

import { AUDIT_LOG_TABLE_NAME } from '../models/definitions/AuditLog.js';
import { CONTAINER_TABLE_NAME } from '../models/definitions/Container.js';
import { CREDENTIAL_TABLE_NAME } from '../models/definitions/Credential.js';
import { DASHBOARD_TABLE_NAME } from '../models/definitions/Dashboard.js';
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import { ITEM_TABLE_NAME } from '../models/definitions/Item.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

function isRecord(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The blocks and layouts without any file tree; `removed` counts the blocks dropped. */
function withoutFileTrees(
  content: Doc,
): { blocks: unknown[]; layouts: unknown; removed: number } | null {
  const blocks = Array.isArray(content['blocks']) ? (content['blocks'] as unknown[]) : [];
  const trees = new Set<string>();
  for (const block of blocks) {
    if (isRecord(block) && block['type'] === 'fileTree') trees.add(String(block['id']));
  }
  if (trees.size === 0) return null;
  const layouts = isRecord(content['layouts'])
    ? Object.fromEntries(
        Object.entries(content['layouts']).map(([breakpoint, cells]) => [
          breakpoint,
          Array.isArray(cells)
            ? (cells as unknown[]).filter(
                (cell) => !(isRecord(cell) && trees.has(String(cell['i']))),
              )
            : cells,
        ]),
      )
    : content['layouts'];
  return {
    blocks: blocks.filter((block) => !(isRecord(block) && trees.has(String(block['id'])))),
    layouts,
    removed: trees.size,
  };
}

export const removeGoogleDrive: Migration = {
  id: '2026-11-15-remove-google-drive',
  async run(db: Db, now: Date) {
    const counts = { integrations: 0, credentials: 0, items: 0, containers: 0, fileTrees: 0 };
    const integrations = db.collection<Doc>(INTEGRATION_TABLE_NAME);
    const credentials = db.collection<Doc>(CREDENTIAL_TABLE_NAME);

    for await (const integration of integrations.find({
      provider: 'google_drive',
      deletedAt: null,
    })) {
      const workspaceId = String(integration['workspaceId']);
      const integrationId = String(integration._id);
      const removed = await integrations.updateOne(
        { _id: integration._id, deletedAt: null },
        { $set: { deletedAt: now } },
      );
      if (removed.modifiedCount === 0) continue;
      counts.integrations += 1;
      counts.credentials += (
        await credentials.deleteMany({ workspaceId, integrationId })
      ).deletedCount;
      if ((await credentials.countDocuments({ workspaceId, integrationId })) > 0) {
        throw new Error('remove-google-drive: a disconnect left its credential behind');
      }
      const live = { workspaceId, integrationId, deletedAt: null };
      counts.items += (
        await db.collection<Doc>(ITEM_TABLE_NAME).updateMany(live, { $set: { deletedAt: now } })
      ).modifiedCount;
      counts.containers += (
        await db
          .collection<Doc>(CONTAINER_TABLE_NAME)
          .updateMany(live, { $set: { deletedAt: now } })
      ).modifiedCount;
      await db.collection<Doc>(AUDIT_LOG_TABLE_NAME).insertOne({
        _id: randomUUID() as never,
        workspaceId,
        actorUserId: 'system',
        actorAgentId: null,
        action: 'integration.disconnect',
        targetType: 'integration',
        targetId: integrationId,
        ip: null,
        userAgent: null,
        meta: { provider: 'google_drive', reason: 'provider_removed' },
        at: now,
      });
    }

    const dashboards = db.collection<Doc>(DASHBOARD_TABLE_NAME);
    for await (const dashboard of dashboards.find({ deletedAt: null })) {
      const draft = withoutFileTrees(dashboard);
      const published = isRecord(dashboard['published'])
        ? withoutFileTrees(dashboard['published'])
        : null;
      if (draft === null && published === null) continue;
      const set: Doc = {};
      if (draft !== null) {
        set['blocks'] = draft.blocks;
        set['layouts'] = draft.layouts;
        counts.fileTrees += draft.removed;
      }
      if (published !== null && isRecord(dashboard['published'])) {
        set['published'] = {
          ...dashboard['published'],
          blocks: published.blocks,
          layouts: published.layouts,
        };
        counts.fileTrees += published.removed;
      }
      await dashboards.updateOne({ _id: dashboard._id }, { $set: set });
    }
    return counts;
  },
};
