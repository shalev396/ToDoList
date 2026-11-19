/**
 * The week grid's geometry and how an event's chip fills it (owner, 2026-11-19: no time of day on
 * the chip; the icon on the first line and the title below it, on as many lines as the chip holds;
 * a chip too short for that has the icon and the title on one line). Pure; unit-tested.
 *
 * FullCalendar draws an event at least `eventMinHeight` tall and decides what overlaps from the
 * span it draws, not from the times. With its defaults (15px, on 20px half-hour rows) a 15-minute
 * event was drawn into the next half hour, so an event starting when it ended counted as
 * overlapping and was squeezed beside it. Here `eventMinHeight` is 0: what overlaps follows the
 * true times, whatever an event's length, so events that only touch never share the width (a
 * 10-minute walk before a lecture included). Events that do overlap sit side by side
 * (`slotEventOverlap: false`), none drawn over another.
 *
 * A chip shorter than a line of text is stretched to READABLE_PX only when that runs into free
 * time (`stretchedEvents`: no event starts there); otherwise it keeps its true height and a
 * smaller line (`tiny`). The stretch is CSS on the event (`tc-stretch`), so it never moves the
 * overlap math.
 */

/** One row of the week grid. */
export const SLOT_MINUTES = 30;
/** One row's height in px (index.css reads it as `--tc-slot`). */
export const SLOT_PX = 30;
export const PX_PER_MINUTE = SLOT_PX / SLOT_MINUTES;
/** FullCalendar's `eventMinHeight`: none, so its overlaps are the true times'. */
export const EVENT_MIN_PX = 0;

/** The gap FullCalendar leaves under every event (`.fc-timegrid-event { margin-bottom: 1px }`). */
const EVENT_GAP_PX = 1;
/** The chip's padding, top and bottom together. */
const CHIP_PADDING_PX = 2;
/** The icon line of a stacked chip. */
export const ICON_LINE_PX = 14;
/** One line of the title (11px text). */
export const TITLE_LINE_PX = 13;
/** The height that holds one line of text (the icon and the title): a quarter hour's. */
export const READABLE_PX = EVENT_GAP_PX + CHIP_PADDING_PX / 2 + TITLE_LINE_PX;
/** The minutes READABLE_PX takes in the grid. */
export const READABLE_MINUTES = READABLE_PX / PX_PER_MINUTE;
/**
 * A chip drawn this tall or taller has its icon on a line of its own above the title; a shorter one
 * has both on one line. FullCalendar's `eventShortHeight`, so its `fc-timegrid-event-short` agrees.
 */
export const STACKED_MIN_PX = EVENT_GAP_PX + CHIP_PADDING_PX + ICON_LINE_PX + TITLE_LINE_PX;

/** The FullCalendar options the week grid's layout rests on. */
export const TIME_GRID_LAYOUT = {
  slotDuration: `00:${String(SLOT_MINUTES)}:00`,
  slotEventOverlap: false,
  eventMinHeight: EVENT_MIN_PX,
  eventShortHeight: STACKED_MIN_PX,
} as const;

export interface DrawnSpan {
  /** px from the start of the day. */
  top: number;
  bottom: number;
}

/** Where FullCalendar draws an event of these minutes of the day (computeSegVCoords). */
export function drawnSpan(startMinute: number, endMinute: number): DrawnSpan {
  const top = startMinute * PX_PER_MINUTE;
  return { top, bottom: Math.max(top + EVENT_MIN_PX, endMinute * PX_PER_MINUTE) };
}

/**
 * Two events FullCalendar places side by side: their drawn spans meet. One that ends when the
 * other starts only touches it.
 */
export function drawnOverlap(a: DrawnSpan, b: DrawnSpan): boolean {
  return a.top < b.bottom && b.top < a.bottom;
}

const DAY_MS = 24 * 3600_000;
/** An event without an end is drawn this long (FullCalendar's `defaultTimedEventDuration`). */
export const DEFAULT_EVENT_MINUTES = 30;

/**
 * The minutes of one day's piece of an event (FullCalendar's dates hold the wall clock as UTC): an
 * event past midnight is drawn in a piece per day, each only as tall as its own day's part.
 */
export function chipMinutes(
  start: Date,
  end: Date | null,
  isStart: boolean,
  isEnd: boolean,
): number {
  const from = start.getTime();
  const to = end?.getTime() ?? from + DEFAULT_EVENT_MINUTES * 60_000;
  if (!isStart && !isEnd) {
    return 24 * 60;
  }
  if (!isStart) {
    return (to % DAY_MS) / 60_000;
  }
  if (!isEnd) {
    return (DAY_MS - (from % DAY_MS)) / 60_000;
  }
  return (to - from) / 60_000;
}

export type ChipLayout =
  | { kind: 'stacked'; titleLines: number }
  | { kind: 'inline'; titleLines: 1 }
  /** Shorter than a line: one line of `linePx` (smaller text), clipped to the event. */
  | { kind: 'tiny'; titleLines: 1; linePx: number };

/**
 * How a chip of `minutes` lays out in the week grid: stacked (the icon line, then the title on
 * every whole line left) when it is drawn at least STACKED_MIN_PX tall; inline when it holds a
 * line; tiny when it is shorter (and not `stretched` to READABLE_PX).
 */
export function chipLayout(minutes: number, stretched = false): ChipLayout {
  const drawn = Math.max(stretched ? READABLE_PX : 0, minutes * PX_PER_MINUTE);
  if (drawn >= STACKED_MIN_PX) {
    const forTitle = drawn - EVENT_GAP_PX - CHIP_PADDING_PX - ICON_LINE_PX;
    return { kind: 'stacked', titleLines: Math.max(1, Math.floor(forTitle / TITLE_LINE_PX)) };
  }
  if (drawn >= READABLE_PX) {
    return { kind: 'inline', titleLines: 1 };
  }
  return { kind: 'tiny', titleLines: 1, linePx: Math.max(0, Math.floor(drawn - EVENT_GAP_PX)) };
}

export interface TimedSpan {
  key: string;
  /** ms */
  start: number;
  end: number;
}

/**
 * The short events (under READABLE_MINUTES) drawn a line tall: those after which no event starts
 * before that line ends, so the stretch only ever covers free time. One followed at once by
 * another (a walk that ends when the lecture starts) keeps its true height.
 */
export function stretchedEvents(events: readonly TimedSpan[]): Set<string> {
  const readable = READABLE_MINUTES * 60_000;
  const stretched = new Set<string>();
  for (const event of events) {
    if (event.end - event.start >= readable) {
      continue;
    }
    const until = event.start + readable;
    const blocked = events.some(
      (other) => other.key !== event.key && other.start >= event.end && other.start < until,
    );
    if (!blocked) {
      stretched.add(event.key);
    }
  }
  return stretched;
}
