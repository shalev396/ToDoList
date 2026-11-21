/**
 * Which painted areas lie under a tap on the week grid (time-blocks design, "Areas"). A tap on
 * free time covers one slot of the grid, so the test is overlap with `[from, to)`, as the band
 * is drawn: an area that only touches the slot's edge is not under it (the same rule as
 * dragPreset's topic). Pure; unit-tested.
 */

/** An area occurrence as far as the hit test goes (an `Occurrence` fits). */
export interface AreaSpan {
  key: string;
  start: Date;
  /** Null: an area without an end holds no time. */
  end: Date | null;
}

/**
 * The areas that cover any part of `[from, to)`, earliest start first (then by key, so the order
 * never depends on the input's). `to` equal to `from` asks about one instant: an area covers it
 * from its start up to, but not including, its end.
 */
export function areasAt<A extends AreaSpan>(areas: readonly A[], from: Date, to: Date): A[] {
  const fromMs = from.getTime();
  const toMs = Math.max(to.getTime(), fromMs);
  return areas
    .filter((area) => {
      if (area.end === null) {
        return false;
      }
      const start = area.start.getTime();
      const end = area.end.getTime();
      return toMs === fromMs ? start <= fromMs && fromMs < end : start < toMs && end > fromMs;
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key));
}
