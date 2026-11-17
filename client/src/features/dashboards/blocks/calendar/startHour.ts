/** The hour the calendar's week view opens scrolled to (a block's `viz.startHour`). */
export const DEFAULT_START_HOUR = 7;

/** An integer 0-23 from the block's viz options, else the default (midnight is a real choice). */
export function readStartHour(viz: Record<string, unknown>): number {
  const hour = viz['startHour'];
  return typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
    ? hour
    : DEFAULT_START_HOUR;
}

/** The hour as FullCalendar writes a slot's `data-time` (`'08:00:00'`). */
export function slotTime(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00:00`;
}

/**
 * The scrollTop that puts the slot's row right under the sticky day header, from measured rects.
 * Midnight opens at the very top, so the all-day row (between the header and 00:00) stays in view.
 */
export function startScrollTop(m: {
  hour: number;
  slotTop: number;
  regionTop: number;
  scrollTop: number;
  stickyHeight: number;
}): number {
  if (m.hour === 0) {
    return 0;
  }
  return Math.max(0, m.slotTop - m.regionTop + m.scrollTop - m.stickyHeight);
}
