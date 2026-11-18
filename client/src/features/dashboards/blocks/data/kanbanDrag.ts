import { isMarkable } from '../../../items/kinds.ts';
import { ITEM_STATUS_ORDER, type KanbanStatus } from './kanbanColumns.ts';

export interface DragSubject {
  kind: string;
  source: { provider: string };
  status: string;
}

/**
 * Only local to-dos are draggable: a mirrored card belongs to its provider ("Open in ..."), and a
 * time block or a travel leg has no status column to move to.
 */
export function isDraggable(row: DragSubject): boolean {
  return isMarkable(row);
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

export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The part of `rect` that is inside `viewport` (a scrolled list's visible window), or null. */
export function clipToViewport(rect: Box, viewport: Box): Box | null {
  const clipped = {
    top: Math.max(rect.top, viewport.top),
    left: Math.max(rect.left, viewport.left),
    bottom: Math.min(rect.bottom, viewport.bottom),
    right: Math.min(rect.right, viewport.right),
  };
  return clipped.top < clipped.bottom && clipped.left < clipped.right ? clipped : null;
}

export function pointIn(point: { x: number; y: number }, box: Box): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}
