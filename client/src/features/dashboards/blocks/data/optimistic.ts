/**
 * Optimistic edits of cached block results: a to-do completed or moved on a board shows its new
 * state at once, in every block that holds it, and goes back if the server refuses. A time block,
 * an area or a travel leg has no status, so its row is never patched (the server refuses it).
 */
import { isScheduledKind } from '../../../items/kinds.ts';

interface ResultLike {
  rows?: unknown[];
  [key: string]: unknown;
}

interface RowPatch {
  status: string;
  closedAt: string | null;
}

/** The fields an item gets when it ends up with `status`. */
export function patchForStatus(status: string, now: Date): RowPatch {
  return {
    status,
    closedAt: status === 'done' || status === 'cancelled' ? now.toISOString() : null,
  };
}

/**
 * The result with item `id`'s row patched; the same object when nothing matched (or the row is
 * reserved time, which has no status).
 */
export function patchRow<T>(result: T, id: string, patch: RowPatch): T {
  if (typeof result !== 'object' || result === null) {
    return result;
  }
  const value = result as ResultLike;
  const rows = value.rows;
  if (!Array.isArray(rows)) {
    return result;
  }
  const matches = (row: unknown): boolean => {
    if (typeof row !== 'object' || row === null) {
      return false;
    }
    const { id: rowId, kind } = row as { id?: unknown; kind?: unknown };
    return rowId === id && !(typeof kind === 'string' && isScheduledKind(kind));
  };
  if (!rows.some(matches)) {
    return result;
  }
  const next = rows.map((row: unknown) => (matches(row) ? { ...(row as object), ...patch } : row));
  return { ...value, rows: next } as T;
}
