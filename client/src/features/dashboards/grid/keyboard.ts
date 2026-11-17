/**
 * Moving and resizing blocks without a mouse (FRONTEND.md §11). With a block focused in edit mode:
 * - an arrow moves it one cell, Shift and an arrow resize it one cell, clamped to the grid;
 * - Enter opens its menu (whose Move and Resize items take the same steps).
 *
 * The arrows follow the screen: in a right-to-left page the left arrow moves toward the end of the
 * row, which is a larger stored x (layouts are stored left-to-right, see rtl.ts). A step is applied
 * as a drag would be: react-grid-layout's own move (which swaps with a block it passes) and
 * vertical packing, so keyboard and mouse leave the same layout. Blocks pack upward, so one row
 * down is packed straight back: up and down take the smallest step that changes the layout, which
 * passes the next block. Phones (one column) only reorder.
 */
import { cloneLayout, moveElement, verticalCompactor } from 'react-grid-layout/core';
import type { LayoutItem } from '@api-types/builder.ts';

export type GridDirection = 'ltr' | 'rtl';

export interface GridKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean | undefined;
  metaKey?: boolean | undefined;
  altKey?: boolean | undefined;
}

export interface GridKeyOptions {
  cols: number;
  dir: GridDirection;
  /** False on phones: one column, reorder only. */
  horizontal: boolean;
  resizable: boolean;
  /** The smallest size a block may be resized to, in this grid's cells. Default 1 × 1. */
  minSize?: ((id: string) => { w: number; h: number }) | undefined;
}

/** `dx` is logical: +1 toward the end of the row (right in LTR, left in RTL). */
export type GridStep =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; dw: number; dh: number };

export type GridKeyResult =
  /** Not a grid key: let the browser have it. */
  | { type: 'ignored' }
  /** Enter: open the block's menu. */
  | { type: 'menu' }
  /** A grid key that changes nothing here (an edge, a minimum, a phone). */
  | { type: 'unchanged' }
  | { type: 'changed'; change: GridStep['kind']; layout: LayoutItem[]; item: LayoutItem };

const UNCHANGED = { type: 'unchanged' } as const;

/** The end of the row is +1 stored x; the arrow that points there depends on the direction. */
function endwardStep(key: 'ArrowLeft' | 'ArrowRight', dir: GridDirection): number {
  const pointsRight = key === 'ArrowRight';
  return pointsRight === (dir === 'ltr') ? 1 : -1;
}

function stepFor(event: GridKeyEvent, dir: GridDirection): GridStep | 'menu' | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
    return null;
  }
  if (event.key === 'Enter') {
    return event.shiftKey ? null : 'menu';
  }
  let dx = 0;
  let dy = 0;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
      dx = endwardStep(event.key, dir);
      break;
    case 'ArrowUp':
      dy = -1;
      break;
    case 'ArrowDown':
      dy = 1;
      break;
    default:
      return null;
  }
  return event.shiftKey ? { kind: 'resize', dw: dx, dh: dy } : { kind: 'move', dx, dy };
}

function plain({ i, x, y, w, h }: LayoutItem): LayoutItem {
  return { i, x, y, w, h };
}

function samePosition(a: LayoutItem, b: LayoutItem): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** The packed result in the input's order, or UNCHANGED when nothing moved. */
function settle(
  before: readonly LayoutItem[],
  after: readonly LayoutItem[],
  id: string,
  change: GridStep['kind'],
): GridKeyResult {
  const byId = new Map(after.map((item) => [item.i, item]));
  const layout = before.map((item) => plain(byId.get(item.i) ?? item));
  const item = layout.find((entry) => entry.i === id);
  const moved = layout.some((entry, index) => {
    const original = before[index];
    return original === undefined || !samePosition(entry, original);
  });
  return item === undefined || !moved ? UNCHANGED : { type: 'changed', change, layout, item };
}

/** The layout after dragging `id` to (x, y) and letting the blocks pack upward. */
function dragTo(
  layout: readonly LayoutItem[],
  id: string,
  x: number,
  y: number,
  cols: number,
): GridKeyResult {
  const working = cloneLayout(layout);
  const target = working.find((entry) => entry.i === id);
  if (target === undefined) {
    return UNCHANGED;
  }
  const moved = moveElement(working, target, x, y, true, false, 'vertical', cols);
  return settle(layout, verticalCompactor.compact(moved, cols), id, 'move');
}

function bottomRow(layout: readonly LayoutItem[]): number {
  return layout.reduce((lowest, item) => Math.max(lowest, item.y + item.h), 0);
}

/** One step for one block: the packed layout, or UNCHANGED at an edge or a minimum. */
export function applyGridStep(
  layout: readonly LayoutItem[],
  id: string,
  step: GridStep,
  options: GridKeyOptions,
): GridKeyResult {
  const { cols } = options;
  const item = layout.find((entry) => entry.i === id);
  if (item === undefined) {
    return UNCHANGED;
  }

  if (step.kind === 'move') {
    if (step.dx !== 0) {
      if (!options.horizontal) {
        return UNCHANGED;
      }
      const x = Math.min(Math.max(item.x + step.dx, 0), Math.max(cols - item.w, 0));
      return x === item.x ? UNCHANGED : dragTo(layout, id, x, item.y, cols);
    }
    // Up or down: the first row that changes the layout (the next block passed), if any.
    const direction = Math.sign(step.dy);
    const last = direction > 0 ? bottomRow(layout) : 0;
    for (let y = item.y + direction; direction > 0 ? y <= last : y >= last; y += direction) {
      const result = dragTo(layout, id, item.x, y, cols);
      if (result.type === 'changed') {
        return result;
      }
    }
    return UNCHANGED;
  }

  if (!options.resizable) {
    return UNCHANGED;
  }
  const working = cloneLayout(layout);
  const target = working.find((entry) => entry.i === id);
  if (target === undefined) {
    return UNCHANGED;
  }
  const min = options.minSize?.(id) ?? { w: 1, h: 1 };
  // Narrowing stops at the minimum (or the current size, when that is already smaller);
  // widening stops at the end of the row.
  const w =
    step.dw < 0
      ? Math.max(item.w + step.dw, Math.min(min.w, item.w), 1)
      : Math.min(item.w + step.dw, cols - item.x);
  const h = step.dh < 0 ? Math.max(item.h + step.dh, Math.min(min.h, item.h), 1) : item.h + step.dh;
  if (w === item.w && h === item.h) {
    return UNCHANGED;
  }
  target.w = w;
  target.h = h;
  return settle(layout, verticalCompactor.compact(working, cols), id, 'resize');
}

/** What a key does to the focused block (see the module comment). */
export function reduceGridKey(
  layout: readonly LayoutItem[],
  id: string,
  event: GridKeyEvent,
  options: GridKeyOptions,
): GridKeyResult {
  const step = stepFor(event, options.dir);
  if (step === null) {
    return { type: 'ignored' };
  }
  if (step === 'menu') {
    return { type: 'menu' };
  }
  return applyGridStep(layout, id, step, options);
}
