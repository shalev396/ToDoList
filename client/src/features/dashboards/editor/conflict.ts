/**
 * What to do when a layout save answers 409 because the dashboard changed elsewhere meanwhile
 * (plan "Review focus 5": UI autosave versus an agent op). The caller has refetched the draft.
 *
 * Only the blocks the user moved or resized are mine to re-apply; the blocks they pushed out of
 * the way follow the fresh layout (another writer may have placed them since).
 * - Every block I moved still exists: put them where I left them on the fresh version, pack the
 *   other blocks around them (mine held in place), then pack everything upward as the grid does,
 *   on each breakpoint's own grid, and save that once more. My blocks keep their place however
 *   the fresh layout happens to list the blocks.
 * - One of them is gone: drop my change and show the fresh copy. Never apply part of it.
 * - The fresh version already has my positions: nothing is left to save.
 */
import { cloneLayout, verticalCompactor } from 'react-grid-layout/core';
import type { Block, LayoutItem, Layouts } from '@api-types/builder.ts';
import { BREAKPOINTS, GRID_COLS } from '../grid/constants.ts';
import {
  changedItems,
  overlayLayout,
  plainLayout,
  type MovedBlocks,
  type PendingLayouts,
} from '../grid/layouts.ts';

export type ConflictPlan =
  | { kind: 'reapply'; expectedVersion: number; layouts: PendingLayouts }
  | { kind: 'resolved' }
  | { kind: 'drop'; missing: string[] };

export interface FreshDashboard {
  version: number;
  blocks: readonly Pick<Block, 'id'>[];
  layouts: Layouts;
}

/** My unsaved positions, and which of those blocks I moved or resized myself. */
export interface MyLayoutChange {
  layouts: PendingLayouts;
  moved: MovedBlocks;
}

/** The positions of the blocks I moved, per breakpoint. */
function movedPositions({ layouts, moved }: MyLayoutChange): PendingLayouts {
  const mine: PendingLayouts = {};
  for (const breakpoint of BREAKPOINTS) {
    const ids = new Set(moved[breakpoint] ?? []);
    const items = (layouts[breakpoint] ?? []).filter((item) => ids.has(item.i));
    if (items.length > 0) {
      mine[breakpoint] = items;
    }
  }
  return mine;
}

/** `current` with `mine` placed first: the rest packs around them, then everything upward. */
function packAround(current: readonly LayoutItem[], mine: readonly LayoutItem[], cols: number) {
  const pinned = new Set(mine.map((item) => item.i));
  const held = cloneLayout(overlayLayout(current, mine)).map((item) => ({
    ...item,
    static: pinned.has(item.i),
  }));
  const settled = verticalCompactor.compact(held, cols).map((item) => ({ ...item, static: false }));
  return plainLayout(verticalCompactor.compact(settled, cols));
}

export function planConflictRecovery(change: MyLayoutChange, fresh: FreshDashboard): ConflictPlan {
  const mine = movedPositions(change);
  const exists = new Set(fresh.blocks.map((block) => block.id));
  const missing = new Set<string>();
  for (const breakpoint of BREAKPOINTS) {
    for (const item of mine[breakpoint] ?? []) {
      if (!exists.has(item.i)) {
        missing.add(item.i);
      }
    }
  }
  if (missing.size > 0) {
    return { kind: 'drop', missing: [...missing] };
  }

  const layouts: PendingLayouts = {};
  for (const breakpoint of BREAKPOINTS) {
    const items = mine[breakpoint];
    if (items === undefined) {
      continue;
    }
    const current = fresh.layouts[breakpoint];
    const changes = changedItems(packAround(current, items, GRID_COLS[breakpoint]), current);
    if (changes.length > 0) {
      layouts[breakpoint] = changes;
    }
  }
  return Object.keys(layouts).length === 0
    ? { kind: 'resolved' }
    : { kind: 'reapply', expectedVersion: fresh.version, layouts };
}
