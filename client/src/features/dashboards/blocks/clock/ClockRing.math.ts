/**
 * Pure time and geometry helpers for the 24-hour ClockRing.
 *
 * Angles are degrees clockwise from midnight at 12 o'clock: 00:00 is 0°, 06:00 is 90°, 12:00 is
 * 180° and 18:00 is 270°. Times are read on the wall clock of an IANA time zone, so the ring shows
 * the workspace's local day whatever zone the browser runs in.
 *
 * No DOM and no React: `npm run test:unit` runs these under `node --test`.
 */
import { endOfZonedDay, startOfZonedDay, zonedParts } from '@api-types/recurrence/zoned.ts';

// The wall-clock helpers are shared with the server; re-exported so callers keep their imports.
export {
  endOfZonedDay,
  startOfZonedDay,
  timeZoneOffsetMinutes,
  zonedParts,
  zonedTime,
  type ZonedParts,
} from '@api-types/recurrence/zoned.ts';

export interface TimeRange {
  start: Date;
  end: Date;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Degrees clockwise from midnight for the wall-clock time of `date` in `timeZone`: 0 at 00:00,
 * 90 at 06:00, 180 at 12:00, 270 at 18:00. Always in [0, 360).
 */
export function angleForTime(date: Date, timeZone: string): number {
  const { hour, minute, second } = zonedParts(date, timeZone);
  const minutes = hour * 60 + minute + (second + date.getUTCMilliseconds() / 1000) / 60;
  return (minutes / MINUTES_PER_DAY) * 360;
}

/**
 * The part of `range` that falls on the calendar day containing `day` (in `timeZone`), or null
 * when they don't overlap. An event that crosses midnight is cut at the day's edges.
 */
export function clipToDay(range: TimeRange, day: Date, timeZone: string): TimeRange | null {
  const dayStart = startOfZonedDay(day, timeZone).getTime();
  const dayEnd = endOfZonedDay(day, timeZone).getTime();
  const start = Math.max(range.start.getTime(), dayStart);
  const end = Math.min(range.end.getTime(), dayEnd);
  if (end <= start) {
    return null;
  }
  return { start: new Date(start), end: new Date(end) };
}

export interface ArcAngles {
  startAngle: number;
  endAngle: number;
}

/**
 * Start and end angles for `range` on the ring of the day containing `day`, after clipping it to
 * that day. An event that runs to midnight ends at 360°, not 0°. Null when it isn't on that day.
 */
export function dayArcAngles(range: TimeRange, day: Date, timeZone: string): ArcAngles | null {
  const clipped = clipToDay(range, day, timeZone);
  if (!clipped) {
    return null;
  }
  const endsAtMidnight = clipped.end.getTime() >= endOfZonedDay(day, timeZone).getTime();
  const startAngle = angleForTime(clipped.start, timeZone);
  const endAngle = endsAtMidnight ? 360 : angleForTime(clipped.end, timeZone);
  // On the night clocks go back, an event can end at an earlier wall time than it starts.
  return { startAngle, endAngle: Math.max(endAngle, startAngle) };
}

export interface Point {
  x: number;
  y: number;
}

/** A point at `radius` from the centre, `angle` degrees clockwise from 12 o'clock. */
export function polar(radius: number, angle: number): Point {
  const radians = (angle * Math.PI) / 180;
  return { x: radius * Math.sin(radians), y: -radius * Math.cos(radians) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function point(p: Point): string {
  return `${round(p.x)} ${round(p.y)}`;
}

export interface ArcPathOptions {
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
  /**
   * Width of the surface gap between neighbouring arcs, in the same units as the radii. Half of it
   * is taken off each end, measured along each edge, so the gap has parallel sides.
   */
  gap?: number;
  /** The shortest edge an arc keeps, so a very short event never disappears. */
  minLength?: number;
}

function trimmedEdge(
  radius: number,
  startAngle: number,
  endAngle: number,
  gap: number,
  minLength: number,
): [number, number] {
  const toDegrees = (length: number) => (radius > 0 ? (length / radius) * (180 / Math.PI) : 0);
  const trim = toDegrees(gap / 2);
  const minSweep = Math.min(toDegrees(minLength), endAngle - startAngle);
  let from = startAngle + trim;
  let to = endAngle - trim;
  if (to - from < minSweep) {
    const middle = (startAngle + endAngle) / 2;
    from = middle - minSweep / 2;
    to = middle + minSweep / 2;
  }
  return [from, to];
}

/**
 * SVG path data for a ring segment (an annular sector) centred on the origin, from `startAngle`
 * to `endAngle` degrees clockwise from 12 o'clock. Returns '' when the arc is empty. A sweep of
 * 360° or more draws the whole ring.
 */
export function arcPath({
  innerRadius,
  outerRadius,
  startAngle,
  endAngle,
  gap = 0,
  minLength = 0,
}: ArcPathOptions): string {
  const sweep = endAngle - startAngle;
  if (sweep <= 0 || outerRadius <= innerRadius) {
    return '';
  }
  if (sweep >= 360) {
    // A full ring: the outer circle clockwise, the inner one counter-clockwise (a hole).
    const outer = round(outerRadius);
    const inner = round(innerRadius);
    return (
      `M 0 ${-outer} A ${outer} ${outer} 0 1 1 0 ${outer} A ${outer} ${outer} 0 1 1 0 ${-outer} Z ` +
      `M 0 ${-inner} A ${inner} ${inner} 0 1 0 0 ${inner} A ${inner} ${inner} 0 1 0 0 ${-inner} Z`
    );
  }
  const [outerFrom, outerTo] = trimmedEdge(outerRadius, startAngle, endAngle, gap, minLength);
  const [innerFrom, innerTo] = trimmedEdge(innerRadius, startAngle, endAngle, gap, minLength);
  const largeOuter = outerTo - outerFrom > 180 ? 1 : 0;
  const largeInner = innerTo - innerFrom > 180 ? 1 : 0;
  const r = round(outerRadius);
  const ri = round(innerRadius);
  return [
    `M ${point(polar(outerRadius, outerFrom))}`,
    `A ${r} ${r} 0 ${largeOuter} 1 ${point(polar(outerRadius, outerTo))}`,
    `L ${point(polar(innerRadius, innerTo))}`,
    `A ${ri} ${ri} 0 ${largeInner} 0 ${point(polar(innerRadius, innerFrom))}`,
    'Z',
  ].join(' ');
}

/**
 * Splits overlapping events into concentric lanes: each event takes the outermost lane (0) that
 * is free at its start. Events that only touch share a lane. Past `maxLanes`, an event goes to the
 * lane that frees up first, so it may overlap there. Returns one lane index per input, in order.
 */
export function assignLanes(ranges: readonly TimeRange[], maxLanes = 3): number[] {
  const order = ranges
    .map((range, index) => ({ index, start: range.start.getTime(), end: range.end.getTime() }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(ranges.length).fill(0);
  for (const item of order) {
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      if (laneEnds.length < Math.max(1, maxLanes)) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        lane = laneEnds.indexOf(Math.min(...laneEnds));
      }
    }
    laneEnds[lane] = Math.max(laneEnds[lane] ?? item.end, item.end);
    lanes[item.index] = lane;
  }
  return lanes;
}
