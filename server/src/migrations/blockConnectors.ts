/**
 * PERMISSIONS-V2 (migration point 17): blocks name their sources (share-on-attach). For every
 * live dashboard, in its draft and its published copy, each data block without a connectors
 * field gets one (builder/connectors.ts migrateBlockConnectors):
 * - an old top-level `integrationId in [...]` rule (the D6 form) becomes its connectors;
 * - otherwise the dashboard creator's integrations matching the block's provider filter, or all
 *   of the creator's integrations without one (and `local` where it could show to-dos). A creator
 *   with none matching leaves the block without the field: it reads what each viewer may see
 *   (`[]` would read nothing).
 * Attaching shares: so the creator's integrations on their own dashboards are shared, as the
 * workspace saw them before.
 *
 * History ends at a changed dashboard (as the topics migration did): its versions become one
 * snapshot of the migrated draft (summary `history-reset`), so an undo or a revert never brings
 * back a block without connectors. Idempotent: a changed dashboard's reset entry marks it done,
 * so a rerun skips it even after its creator connects more, and a block with a connectors field
 * is never changed again. (A dashboard whose blocks matched nothing has no marker: a rerun after
 * a crash looks at it again.)
 */
import { HISTORY_RESET_SUMMARY } from '../builder/history.js';
import { migrateBlockConnectors, type BindableIntegration } from '../builder/connectors.js';
import { DASHBOARD_TABLE_NAME } from '../models/definitions/Dashboard.js';
import { DASHBOARD_VERSION_TABLE_NAME } from '../models/definitions/DashboardVersion.js';
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import { VIEW_TABLE_NAME } from '../models/definitions/View.js';
import type { Provider } from '../types/domain.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

function isRecord(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id of the history reset this migration writes: one per dashboard, so a rerun finds it. */
function resetId(dashboardId: string): string {
  return `${dashboardId}:${HISTORY_RESET_SUMMARY}:connectors`;
}

export const blockConnectors: Migration = {
  id: '2026-11-14-block-connectors',
  async run(db: Db, now: Date) {
    const counts = { dashboards: 0, blocks: 0 };
    const dashboards = db.collection<Doc>(DASHBOARD_TABLE_NAME);
    const integrations = db.collection<Doc>(INTEGRATION_TABLE_NAME);
    const views = db.collection<Doc>(VIEW_TABLE_NAME);
    const versions = db.collection<Doc>(DASHBOARD_VERSION_TABLE_NAME);
    const owned = new Map<string, BindableIntegration[]>();
    const creatorIntegrations = async (
      workspaceId: string,
      userId: string,
    ): Promise<BindableIntegration[]> => {
      const key = `${workspaceId}\u0000${userId}`;
      const cached = owned.get(key);
      if (cached !== undefined) return cached;
      const found = await integrations
        .find({ workspaceId, ownerUserId: userId, deletedAt: null })
        .sort({ createdAt: 1 })
        .toArray();
      const list = found.map((doc) => ({
        id: String(doc._id),
        provider: doc['provider'] as Provider,
      }));
      owned.set(key, list);
      return list;
    };

    for await (const dashboard of dashboards.find({ deletedAt: null })) {
      const workspaceId = String(dashboard['workspaceId']);
      const creator = String(dashboard['ownerUserId']);
      if ((await versions.countDocuments({ _id: resetId(String(dashboard._id)) as never })) > 0) {
        continue;
      }
      const mine = await creatorIntegrations(workspaceId, creator);
      let changed = 0;
      const migrate = async (blocks: unknown): Promise<unknown[]> => {
        const list = Array.isArray(blocks) ? (blocks as unknown[]) : [];
        const next: unknown[] = [];
        for (const block of list) {
          const viewId = isRecord(block) ? block['savedViewId'] : undefined;
          const view =
            typeof viewId === 'string'
              ? await views.findOne({ _id: viewId as never, workspaceId })
              : null;
          const migrated = migrateBlockConnectors(block, mine, view?.['query']);
          if (migrated !== block) changed += 1;
          next.push(migrated);
        }
        return next;
      };
      const blocks = await migrate(dashboard['blocks']);
      const published = isRecord(dashboard['published'])
        ? { ...dashboard['published'], blocks: await migrate(dashboard['published']['blocks']) }
        : null;
      if (changed === 0) continue;

      const dashboardId = String(dashboard._id);
      const updatedBy = isRecord(dashboard['updatedBy']) ? dashboard['updatedBy'] : {};
      const actor = updatedBy['userId'] ?? creator;
      await versions.deleteMany({ workspaceId, dashboardId });
      await versions.insertOne({
        _id: resetId(dashboardId) as never,
        workspaceId,
        dashboardId,
        version: Number(dashboard['version'] ?? 1),
        patch: [],
        inverse: [],
        snapshot: {
          title: dashboard['title'],
          scope: dashboard['scope'],
          vars: dashboard['vars'],
          layouts: dashboard['layouts'],
          blocks,
        },
        actorUserId: typeof actor === 'string' ? actor : '',
        actorAgentId: null,
        summary: HISTORY_RESET_SUMMARY,
        at: now,
      });
      await dashboards.updateOne(
        { _id: dashboard._id },
        { $set: { blocks, ...(published === null ? {} : { published }) } },
      );
      counts.dashboards += 1;
      counts.blocks += changed;
    }
    return counts;
  },
};
