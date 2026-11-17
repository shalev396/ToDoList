export const ITEM_STATUS_ORDER = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type KanbanStatus = (typeof ITEM_STATUS_ORDER)[number];

export interface KanbanColumn<R> {
  key: string;
  rows: R[];
}

/**
 * Columns for a kanban. Grouped by status (the default), the four statuses always show, in
 * workflow order, so a card can be dropped into an empty one. Any other groupBy shows the groups
 * the data has, in first-seen order.
 */
export function kanbanColumns<R>(
  rows: readonly R[],
  keyOf: (row: R) => string,
  byStatus: boolean,
): KanbanColumn<R>[] {
  const keys: string[] = byStatus ? [...ITEM_STATUS_ORDER] : [];
  for (const row of rows) {
    const key = keyOf(row);
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys.map((key) => ({ key, rows: rows.filter((row) => keyOf(row) === key) }));
}
