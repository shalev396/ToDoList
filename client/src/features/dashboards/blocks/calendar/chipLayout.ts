/**
 * The week grid's geometry and how an event's chip fills it (owner, 2026-11-19: no time of day on
 * the chip; the icon on the first line and the title below it, on as many lines as the chip holds;
 * a chip too short for that has the icon and the title on one line). Pure; unit-tested.
 *
 * FullCalendar draws an event at least `eventMinHeight` tall and decides what overlaps from the
 * span it draws, not from the times. With its defaults (15px, on 20px half-hour rows) a 15-minute
 * event was drawn into the next half hour, so an event starting when it ended counted as
 * overlapping and was squeezed beside it. Rows of SLOT_PX and EVENT_MIN_PX under a quarter hour
 * keep every event of 15 minutes or more at its true height: events that only touch never meet.
 * Events that do overlap sit side by side (`slotEventOverlap: false`), none drawn over another.
 */

/** One row of the week grid. */
export const SLOT_MINUTES = 30;
/** One row's height in px (index.css reads it as `--tc-slot`). */
export const SLOT_PX = 30;
export const PX_PER_MINUTE = SLOT_PX / SLOT_MINUTES;
/** The shortest an event is drawn (FullCalendar's `eventMinHeight`): less than 15 minutes' worth. */
export const EVENT_MIN_PX = 14;

/** The gap FullCalendar leaves under every event (`.fc-timegrid-event { margin-bottom: 1px }`). */
const EVENT_GAP_PX = 1;
/** The chip's padding, top and bottom together. */
const CHIP_PADDING_PX = 2;
/** The icon line of a stacked chip. */
export const ICON_LINE_PX = 14;
/** One line of the title (11px text). */
export const TITLE_LINE_PX = 13;
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
  | { kind: 'inline'; titleLines: 1 };

/**
 * How a chip of `minutes` lays out in the week grid: stacked (the icon line, then the title on
 * every whole line left) when it is drawn at least STACKED_MIN_PX tall, otherwise inline.
 */
export function chipLayout(minutes: number): ChipLayout {
  const drawn = Math.max(EVENT_MIN_PX, minutes * PX_PER_MINUTE);
  if (drawn < STACKED_MIN_PX) {
    return { kind: 'inline', titleLines: 1 };
  }
  const forTitle = drawn - EVENT_GAP_PX - CHIP_PADDING_PX - ICON_LINE_PX;
  return { kind: 'stacked', titleLines: Math.max(1, Math.floor(forTitle / TITLE_LINE_PX)) };
}
