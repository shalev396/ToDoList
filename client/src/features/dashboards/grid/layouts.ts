/**
 * Layout helpers for the grid and the editor. Positions are stored left-to-right on each
 * breakpoint's own grid (constants.ts); pending positions are only the items a user moved or
 * resized since the last save, per breakpoint.
 */
import type { LayoutItem, Layouts } from '@api-types/builder.ts';
import { BREAKPOINTS, type Breakpoint } from './constants.ts';

export type PendingLayouts = Partial<Record<Breakpoint, LayoutItem[]>>;

/** Of the pending positions, the blocks the user moved or resized (the rest were pushed). */
export type MovedBlocks = Partial<Record<Breakpoint, string[]>>;

interface GridSize {
  w: number;
  h: number;
}

/** The width of a 12-column size on a grid of `cols` columns: rounded, at least one. */
export function scaleWidth(w: number, cols: number): number {
  return Math.min(cols, Math.max(1, Math.round((w * cols) / 12)));
}

/** Only what the API stores (`{i, x, y, w, h}`): react-grid-layout adds flags of its own. */
export function plainLayout(layout: readonly LayoutItem[]): LayoutItem[] {
  return layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
}

function samePosition(a: LayoutItem, b: LayoutItem): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** The items of `next` that moved, resized or are new relative to `base`. */
export function changedItems(
  next: readonly LayoutItem[],
  base: readonly LayoutItem[],
): LayoutItem[] {
  const before = new Map(base.map((item) => [item.i, item]));
  return plainLayout(
    next.filter((item) => {
      const previous = before.get(item.i);
      return previous === undefined || !samePosition(item, previous);
    }),
  );
}

/** `base` with the positions of `overlay` on top; overlay items `base` lacks come last. */
export function overlayLayout(
  base: readonly LayoutItem[],
  overlay: readonly LayoutItem[],
): LayoutItem[] {
  const over = new Map(overlay.map((item) => [item.i, item]));
  const known = new Set(base.map((item) => item.i));
  return plainLayout([
    ...base.map((item) => over.get(item.i) ?? item),
    ...overlay.filter((item) => !known.has(item.i)),
  ]);
}

/** The stored layouts with the pending positions on top (the same object when none are). */
export function withPending(layouts: Layouts, pending: PendingLayouts | null): Layouts {
  if (pending === null) {
    return layouts;
  }
  return {
    lg: pending.lg === undefined ? layouts.lg : overlayLayout(layouts.lg, pending.lg),
    md: pending.md === undefined ? layouts.md : overlayLayout(layouts.md, pending.md),
    sm: pending.sm === undefined ? layouts.sm : overlayLayout(layouts.sm, pending.sm),
  };
}

/**
 * Takes `withPending(before, applied)` back where it still holds: each applied block still at its
 * applied position returns to where `before` had it (or goes, if `before` had no position for
 * it). A block that changed again since (a reload, another writer) is left as it is.
 */
export function revertPending(current: Layouts, applied: PendingLayouts, before: Layouts): Layouts {
  const result: Layouts = { ...current };
  for (const breakpoint of BREAKPOINTS) {
    const items = applied[breakpoint];
    if (items === undefined) {
      continue;
    }
    const mine = new Map(items.map((item) => [item.i, item]));
    const was = new Map(before[breakpoint].map((item) => [item.i, item]));
    result[breakpoint] = current[breakpoint].flatMap((item) => {
      const placed = mine.get(item.i);
      if (placed === undefined || !samePosition(item, placed)) {
        return [item];
      }
      const previous = was.get(item.i);
      return previous === undefined ? [] : [previous];
    });
  }
  return result;
}

/** `older` with `newer` on top, per breakpoint (a save in flight, then the changes made since). */
export function mergePending(older: PendingLayouts, newer: PendingLayouts | null): PendingLayouts {
  const merged: PendingLayouts = {};
  for (const breakpoint of BREAKPOINTS) {
    const before = older[breakpoint];
    const after = newer?.[breakpoint];
    const items =
      before === undefined ? after : after === undefined ? before : overlayLayout(before, after);
    if (items !== undefined && items.length > 0) {
      merged[breakpoint] = items;
    }
  }
  return merged;
}

/** Both sets of moved blocks, per breakpoint, each block once. */
export function mergeMoved(a: MovedBlocks, b: MovedBlocks | null): MovedBlocks {
  const merged: MovedBlocks = {};
  for (const breakpoint of BREAKPOINTS) {
    const ids = [...new Set([...(a[breakpoint] ?? []), ...(b?.[breakpoint] ?? [])])];
    if (ids.length > 0) {
      merged[breakpoint] = ids;
    }
  }
  return merged;
}

/**
 * Every block on one breakpoint's grid: its stored position (clamped into the grid), or, for a
 * block this breakpoint has no position for, its default size at the bottom. Positions of blocks
 * that no longer exist are dropped.
 */
export function placeBlocks(
  layout: readonly LayoutItem[],
  blocks: readonly { id: string; type: string }[],
  cols: number,
  defaultSize: (type: string) => GridSize,
): LayoutItem[] {
  const stored = new Map(layout.map((item) => [item.i, item]));
  const placed: LayoutItem[] = [];
  const unplaced: { id: string; type: string }[] = [];
  for (const block of blocks) {
    const item = stored.get(block.id);
    if (item === undefined) {
      unplaced.push(block);
      continue;
    }
    const w = Math.min(Math.max(item.w, 1), cols);
    placed.push({
      i: item.i,
      x: Math.min(Math.max(item.x, 0), cols - w),
      y: Math.max(item.y, 0),
      w,
      h: Math.max(item.h, 1),
    });
  }
  let bottom = placed.reduce((lowest, item) => Math.max(lowest, item.y + item.h), 0);
  for (const block of unplaced) {
    const size = defaultSize(block.type);
    placed.push({ i: block.id, x: 0, y: bottom, w: scaleWidth(size.w, cols), h: size.h });
    bottom += size.h;
  }
  return placed;
}
