import { ITEM_STATUS_ORDER, type KanbanStatus } from './kanbanColumns.ts';

export interface DragSubject {
  source: { provider: string };
  status: string;
}

/** Only local items are draggable: a mirrored card belongs to its provider ("Open in ..."). */
export function isDraggable(row: DragSubject): boolean {
  return row.source.provider === 'local';
}

/**
 * The status a drop changes a card to, or null when nothing should be written: a mirrored card, a
 * drop outside any column, an unknown column, or the column it is already in.
 */
export function statusAfterDrop(row: DragSubject, overColumn: string | null): KanbanStatus | null {
  if (!isDraggable(row) || overColumn === null) {
    return null;
  }
  const target = ITEM_STATUS_ORDER.find((status) => status === overColumn);
  return target === undefined || target === row.status ? null : target;
}
