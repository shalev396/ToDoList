/**
 * Right-to-left grids. Layouts are always stored left-to-right; a Hebrew page shows them mirrored,
 * `x' = cols − x − w`, so the block that leads a row in English leads it in Hebrew too. The same
 * function turns a drag or resize on the mirrored grid back into stored positions: mirroring twice
 * is the identity. Positions are assumed to fit the grid (`x + w ≤ cols`).
 */

export function mirrorX(item: { x: number; w: number }, cols: number): number {
  return cols - item.x - item.w;
}

export function mirrorLayout<T extends { x: number; w: number }>(
  layout: readonly T[],
  cols: number,
): T[] {
  return layout.map((item) => ({ ...item, x: mirrorX(item, cols) }));
}
