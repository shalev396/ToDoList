/**
 * The dashboard grid (FRONTEND.md §12, DESIGN.md "Layout"): 12 columns from 1200px, 8 from 768px,
 * one below (phones: reorder only). The columns match the server's auto-placement
 * (server/src/builder/ops.ts GRID_COLUMNS). The breakpoints are viewport widths, like the app's
 * own: the sidebar appears at 768px.
 */
export const BREAKPOINTS = ['lg', 'md', 'sm'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

export const GRID_COLS: Readonly<Record<Breakpoint, number>> = { lg: 12, md: 8, sm: 1 };

/** The smallest viewport width of each breakpoint, in px. */
export const GRID_BREAKPOINT_WIDTHS: Readonly<Record<Breakpoint, number>> = {
  lg: 1200,
  md: 768,
  sm: 0,
};

/** One grid row, in px: DESIGN.md's 36px desktop row. */
export const GRID_ROW_HEIGHT = 36;
/** The gutter between blocks, both ways (DESIGN.md: 16px). */
export const GRID_GAP = 16;

/** The block's height in px for `h` rows. */
export function rowsToPx(h: number): number {
  return h * GRID_ROW_HEIGHT + Math.max(0, h - 1) * GRID_GAP;
}
