/**
 * Where the area chooser goes: beside the tap, never under it. A touch is followed by a
 * synthesized click at the same point, which would land on a row drawn there; so the menu starts
 * `GAP` px away from the point on both axes. It stays inside the viewport, flips above the point
 * when there is no room below, and extends toward the end side (leftwards in Hebrew). Pure;
 * unit-tested.
 */

export const CHOOSER_GAP = 10;
const MARGIN = 8;

export interface ChooserPlaceInput {
  /** The tap, in viewport px. */
  point: { x: number; y: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Right-to-left page: the start edge is the right one. */
  rtl: boolean;
}

export interface ChooserPlace {
  /** px from the viewport's start edge (left in LTR, right in RTL): `inset-inline-start`. */
  start: number;
  /** px from the viewport's top. */
  top: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high));

export function chooserPlace({ point, size, viewport, rtl }: ChooserPlaceInput): ChooserPlace {
  const fromStart = rtl ? viewport.width - point.x : point.x;
  const start = clamp(fromStart + CHOOSER_GAP, MARGIN, viewport.width - size.width - MARGIN);
  const below = point.y + CHOOSER_GAP;
  const top =
    below + size.height + MARGIN <= viewport.height
      ? below
      : clamp(point.y - CHOOSER_GAP - size.height, MARGIN, viewport.height - size.height - MARGIN);
  return { start, top };
}
