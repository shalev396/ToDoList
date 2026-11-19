/**
 * Series ends (B-159): every stored series (an item with a line in `props.recurrence`: a Google
 * master, a local time block) gets `props.recurrenceEnd`, when its last occurrence ends (ISO), or
 * null when it never ends, as a sync and a block's save write it now. A time view reads a series
 * whose end is missing or not before its range (builder/compile.ts), so a master synced before the
 * field existed (last semester's lectures: a full sync lists only events that end after a month
 * ago, so it is never written again) was read for every range, sorted first, and took the row cap
 * from the rows in range.
 *
 * The end is worked out from the stored rule (UNTIL or COUNT; a local series' moved occurrences
 * too) on the wall clock of the item's workspace (`settings.timezone`, the zone the expansion and
 * the sync use), by the shared `recurrenceEndOf`. A rule that never ends, can't be read or has too
 * many slots stays null: read for every range, as before. Only items without the field are read,
 * and each write is conditional on it still missing: idempotent, and a sync that set it meanwhile
 * wins. Counts only.
 */
import { ITEM_TABLE_NAME } from '../models/definitions/Item.js';
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import { recurrenceEndOf } from '../types/recurrence/occurrences.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

/** The zone a workspace stored without one is read in (the schema's default). */
const DEFAULT_ZONE = 'Asia/Jerusalem';

const MISSING = {
  'props.recurrence.0': { $type: 'string' },
  'props.recurrenceEnd': { $exists: false },
};

function instant(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

export const seriesEnds: Migration = {
  id: '2026-11-18-series-ends',
  async run(db: Db) {
    const items = db.collection<Doc>(ITEM_TABLE_NAME);
    const workspaces = db.collection<Doc>(WORKSPACE_TABLE_NAME);
    const zones = new Map<string, string>();
    const zoneOf = async (workspaceId: unknown): Promise<string> => {
      const id = String(workspaceId);
      let zone = zones.get(id);
      if (zone === undefined) {
        const workspace = await workspaces.findOne(
          { _id: id as never },
          { projection: { 'settings.timezone': 1 } },
        );
        const settings = workspace?.['settings'] as { timezone?: unknown } | undefined;
        zone = typeof settings?.timezone === 'string' ? settings.timezone : DEFAULT_ZONE;
        zones.set(id, zone);
      }
      return zone;
    };
    let series = 0;
    let ended = 0;
    const cursor = items.find(MISSING, {
      projection: { workspaceId: 1, startAt: 1, endAt: 1, props: 1 },
    });
    for await (const doc of cursor) {
      const props = (doc['props'] ?? {}) as Record<string, unknown>;
      const end = recurrenceEndOf(
        { startAt: instant(doc['startAt']), endAt: instant(doc['endAt']), props },
        await zoneOf(doc['workspaceId']),
      );
      const { modifiedCount } = await items.updateOne(
        { _id: doc._id, 'props.recurrenceEnd': { $exists: false } },
        { $set: { 'props.recurrenceEnd': end } },
      );
      series += modifiedCount;
      if (end !== null) ended += modifiedCount;
    }
    return { series, ended };
  },
};
