/**
 * What kind of thing a row is, for the controls it gets. A to-do (TodoList's own, `local`) is
 * ticked off: a checkbox, a status, a kanban card to drag. A time block, an area and a travel leg
 * are reserved time (`@api-types/scheduled`): no status, never ticked, never dragged between
 * status columns. A mirrored item belongs to its provider ("Open in ..."). Pure.
 */
import { isScheduledKind } from '@api-types/scheduled.ts';

export { isScheduledKind };

/** What the kind checks read of a row (a block row, the item sheet's item). */
export interface KindedRow {
  kind: string;
  source: { provider: string };
}

/** A to-do the user ticks off: TodoList's own, and not reserved time. */
export function isMarkable(row: KindedRow): boolean {
  return row.source.provider === 'local' && !isScheduledKind(row.kind);
}
