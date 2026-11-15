/**
 * A dashboard's grid (BUILDER.md §5), as an immutable value object: one list of placed blocks per
 * breakpoint (lg, md, sm; react-grid-layout items `{i, x, y, w, h}`). It keeps the stored lists
 * exactly as they are, so what it gives back is what was stored. Pure.
 */
import type { Breakpoint } from '../../builder/ops.js';
import type { DashboardLayouts } from '../../models/definitions/Dashboard.js';
import { stableStringify } from '../../utils/stableStringify.js';

/** Freezes a value and everything it holds. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Where a placed block ends, top to bottom: its `y + h`, 0 for anything that isn't a placement. */
function bottomOf(item: unknown): number {
  if (typeof item !== 'object' || item === null) return 0;
  const { y, h } = item as { y?: unknown; h?: unknown };
  return typeof y === 'number' && typeof h === 'number' ? y + h : 0;
}

export class Layout {
  /** A page with nothing placed yet. */
  static readonly EMPTY = new Layout({ lg: [], md: [], sm: [] });

  readonly #layouts: Readonly<DashboardLayouts>;

  private constructor(layouts: DashboardLayouts) {
    this.#layouts = deepFreeze(structuredClone(layouts));
    Object.freeze(this);
  }

  /** The stored layouts, as they are. */
  static of(layouts: DashboardLayouts): Layout {
    return new Layout(layouts);
  }

  /** The placements at one breakpoint. */
  at(breakpoint: Breakpoint): readonly unknown[] {
    return this.#layouts[breakpoint];
  }

  /** The first free row below everything placed at `breakpoint` (0 on an empty grid). */
  bottom(breakpoint: Breakpoint): number {
    return this.at(breakpoint).reduce<number>(
      (lowest, item) => Math.max(lowest, bottomOf(item)),
      0,
    );
  }

  /** Nothing placed at any breakpoint. */
  get isEmpty(): boolean {
    return (
      this.#layouts.lg.length === 0 &&
      this.#layouts.md.length === 0 &&
      this.#layouts.sm.length === 0
    );
  }

  /** A copy of the stored layouts. */
  toJSON(): DashboardLayouts {
    return structuredClone(this.#layouts);
  }

  /** The same placements at every breakpoint (compared canonically: key order doesn't count). */
  equals(other: Layout | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      stableStringify(other.#layouts) === stableStringify(this.#layouts)
    );
  }
}
