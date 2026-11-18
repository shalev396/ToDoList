/**
 * Wall-clock helpers for an IANA time zone, shared by the server and the client (`@api-types`).
 *
 * Pure: `Intl` only, no DOM, no Node APIs. The occurrence expansion, the clock, the calendar and
 * the travel planner all read times on the workspace's wall clock through these, so "Sunday
 * 13:00" is the same instant on both sides, across daylight-saving changes too.
 */

export interface ZonedParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 to 23. */
  hour: number;
  minute: number;
  second: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock date and time of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some engines print midnight as 24 even with h23.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Minutes `timeZone` is ahead of UTC at `date` (Asia/Jerusalem in November: 120). */
export function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = date.getTime() - date.getUTCMilliseconds();
  return Math.round((wallAsUtc - wholeSeconds) / MS_PER_MINUTE);
}

/**
 * The instant the wall clock in `timeZone` reads `hour:minute` on the given date, resolved the way
 * Temporal's `disambiguation: 'compatible'` does: a wall time that happens twice (clocks fall back)
 * is its first occurrence, and a wall time the clocks skip (spring forward) moves forward by the
 * length of the jump, so 02:30 becomes 03:30.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset a day before and a day after: the same on an ordinary day, and the offsets
  // either side of the change on a DST day.
  const offsetBefore = timeZoneOffsetMinutes(new Date(wall - MS_PER_DAY), timeZone);
  const offsetAfter = timeZoneOffsetMinutes(new Date(wall + MS_PER_DAY), timeZone);
  const candidates = [offsetBefore, offsetAfter]
    .map((offset) => wall - offset * MS_PER_MINUTE)
    .sort((a, b) => a - b);
  const readsAsWall = (instant: number): boolean => {
    const p = zonedParts(new Date(instant), timeZone);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    );
  };
  // Both candidates read as the wall time when it happens twice: the earlier one is the first.
  const exact = candidates.find(readsAsWall);
  if (exact !== undefined) {
    return new Date(exact);
  }
  // Neither does when the clocks skip it: read it with the offset from before the jump, which
  // lands as far past the jump as the wall time was past its start.
  return new Date(wall - offsetBefore * MS_PER_MINUTE);
}

/** The first instant of the calendar day that contains `date` in `timeZone`. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const { year, month, day } = zonedParts(date, timeZone);
  return zonedTime(year, month, day, 0, 0, timeZone);
}

/** The first instant of the next calendar day (the end of `date`'s day, exclusive). */
export function endOfZonedDay(date: Date, timeZone: string): Date {
  // 36 hours after the start is safely inside the next day, even on a 25-hour DST day.
  const start = startOfZonedDay(date, timeZone);
  return startOfZonedDay(new Date(start.getTime() + 36 * MS_PER_HOUR), timeZone);
}

/** Midnight of the local day `days` after the one that contains `date` (negative: before). */
export function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTime(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
    timeZone,
  );
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `2026-11-12T10:00:00`: the wall clock of `date` in `timeZone`, with no offset. */
export function wallString(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** `2026-11-12`: the calendar date of `date` in `timeZone`. */
export function wallDate(date: Date, timeZone: string): string {
  return wallString(date, timeZone).slice(0, 10);
}

const WALL_STRING = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant `wall` (`2026-11-12T10:00:00`, seconds optional) names on the wall clock of
 * `timeZone`: the inverse of `wallString`. DST edges resolve as in `zonedTime`. Text that is not
 * such a wall time gives an invalid date (`getTime()` is NaN), as `new Date('...')` does.
 */
export function fromWallString(wall: string, timeZone: string): Date {
  const match = WALL_STRING.exec(wall);
  if (match === null) {
    return new Date(NaN);
  }
  const [, y, mo, d, h, mi, s] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s ?? '0'].map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return new Date(NaN);
  }
  // Reject what Date.UTC would roll over (month 13, 30 February, 24:00, minute 60).
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day ||
    asUtc.getUTCHours() !== hour ||
    asUtc.getUTCMinutes() !== minute ||
    asUtc.getUTCSeconds() !== second
  ) {
    return new Date(NaN);
  }
  return new Date(zonedTime(year, month, day, hour, minute, timeZone).getTime() + second * 1000);
}
