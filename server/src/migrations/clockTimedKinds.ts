/**
 * Clocks show reserved time (time-blocks spec: a time-shaped view always includes blocks, areas
 * and travel): every clock stored with the old default filter, `kind = event` (the main
 * dashboard's "Today") or `kind = event` and `topic = $page.topic` (a topic page's), gets the
 * timed kinds instead, `kind in [event, block, travel]`, with the topic rule kept. A clock is
 * time-shaped, so its own kind rule wins over the view's default: without this, the clocks made
 * before the change never show a block, an area or a leg.
 *
 * Only a where-group that is EXACTLY one of the two old defaults is rewritten (keys, order and
 * values); a clock whose filter differs in any way was chosen by someone and stays. In the draft
 * and the published copy of every live dashboard. History ends at a changed dashboard (as the
 * connectors migration did): its versions become one snapshot of the migrated draft (summary
 * `history-reset`), so an undo or a revert never brings the old filter back. Items are never
 * read or written. Idempotent: a rewritten clock no longer matches. Counts only.
 *
 * Frozen: the kinds are written out here, as they were on 2026-11-18, not read from the code.
 */
import { HISTORY_RESET_SUMMARY } from '../builder/history.js';
import { DASHBOARD_TABLE_NAME } from '../models/definitions/Dashboard.js';
import { DASHBOARD_VERSION_TABLE_NAME } from '../models/definitions/DashboardVersion.js';
import { stableStringify } from '../utils/stableStringify.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

const EVENT = { field: 'kind', operator: '=', value: 'event' };
const PAGE_TOPIC = { field: 'topic', operator: '=', value: '$page.topic' };
const TIMED = { field: 'kind', operator: 'in', value: ['event', 'block', 'travel'] };

/** The old default where-groups (as stored, compared whole) and what each becomes. */
const REWRITES: ReadonlyMap<string, Doc> = new Map([
  [stableStringify({ combinator: 'and', rules: [EVENT] }), { combinator: 'and', rules: [TIMED] }],
  [
    stableStringify({ combinator: 'and', rules: [EVENT, PAGE_TOPIC] }),
    { combinator: 'and', rules: [TIMED, PAGE_TOPIC] },
  ],
]);

function isRecord(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id of the history reset this migration writes: one per dashboard. */
function resetId(dashboardId: string): string {
  return `${dashboardId}:${HISTORY_RESET_SUMMARY}:clock-timed-kinds`;
}

/** The block, its filter rewritten when it is a clock with an old default; else the same block. */
function migrated(block: unknown): unknown {
  if (!isRecord(block) || block['type'] !== 'clock' || !isRecord(block['query'])) return block;
  const query = block['query'];
  if (!isRecord(query['where'])) return block;
  const next = REWRITES.get(stableStringify(query['where']));
  if (next === undefined) return block;
  return { ...block, query: { ...query, where: structuredClone(next) } };
}

export const clockTimedKinds: Migration = {
  id: '2026-11-18-clock-timed-kinds',
  async run(db: Db, now: Date) {
    const counts = { dashboards: 0, clocks: 0 };
    const dashboards = db.collection<Doc>(DASHBOARD_TABLE_NAME);
    const versions = db.collection<Doc>(DASHBOARD_VERSION_TABLE_NAME);
    for await (const dashboard of dashboards.find({
      deletedAt: null,
      $or: [{ 'blocks.type': 'clock' }, { 'published.blocks.type': 'clock' }],
    })) {
      let changed = 0;
      const migrate = (blocks: unknown): unknown[] =>
        (Array.isArray(blocks) ? (blocks as unknown[]) : []).map((block) => {
          const next = migrated(block);
          if (next !== block) changed += 1;
          return next;
        });
      const blocks = migrate(dashboard['blocks']);
      const draftChanged = changed;
      const published = isRecord(dashboard['published'])
        ? { ...dashboard['published'], blocks: migrate(dashboard['published']['blocks']) }
        : null;
      if (changed === 0) continue;

      const workspaceId = String(dashboard['workspaceId']);
      const dashboardId = String(dashboard._id);
      if (draftChanged > 0) {
        const updatedBy = isRecord(dashboard['updatedBy']) ? dashboard['updatedBy'] : {};
        const actor = updatedBy['userId'] ?? dashboard['ownerUserId'];
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
            // As the dashboard reads its draft: an importance when set, views when there are any.
            ...(dashboard['importance'] === null || dashboard['importance'] === undefined
              ? {}
              : { importance: dashboard['importance'] }),
            ...(Array.isArray(dashboard['views']) && dashboard['views'].length > 0
              ? { views: dashboard['views'] }
              : {}),
          },
          actorUserId: typeof actor === 'string' ? actor : '',
          actorAgentId: null,
          summary: HISTORY_RESET_SUMMARY,
          at: now,
        });
      }
      await dashboards.updateOne(
        { _id: dashboard._id },
        { $set: { blocks, ...(published === null ? {} : { published }) } },
      );
      counts.dashboards += 1;
      counts.clocks += changed;
    }
    return counts;
  },
};
