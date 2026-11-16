/**
 * Date presets (BUILDER.md §3) resolved in the workspace's time zone, for display rules on the
 * client (`within today`). The same algorithm as server/src/builder/dates.ts, which a unit test
 * compares it with for every preset: bounds are half-open `[from, to)`, days start at local
 * midnight (DST days are 23 or 25 hours long), with `Intl` alone.
 */
import type { DatePreset, RelativeUnit } from '@api-types/builder.ts';

export type WeekStart = 'sun' | 'mon';

export interface DateBounds {
  from: Date;
  to: Date;
}

/** A calendar date in some time zone; `month` is 1–12. */
interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface MonthDay {
  month: number;
  day: number;
}

/** As the server's SEMESTERS: fall Oct 15 – Feb 15, spring Mar 1 – Jul 15, both days included. */
const SEMESTERS: readonly { first: MonthDay; last: MonthDay }[] = [
  { first: { month: 10, day: 15 }, last: { month: 2, day: 15 } },
  { first: { month: 3, day: 1 }, last: { month: 7, day: 15 } },
];

const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The wall-clock reading at a (whole-second) instant, as the UTC milliseconds of the same fields. */
function wallClock(instantMs: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
}

/** Local time minus UTC at an instant, in milliseconds. */
function offsetAt(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  return wallClock(whole, timeZone) - whole;
}

function localDateOf(instantMs: number, timeZone: string): LocalDate {
  const wall = new Date(wallClock(Math.floor(instantMs / 1000) * 1000, timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dateKey(date: LocalDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

/** The first instant of a local calendar day, also across a repeated or skipped midnight. */
function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const midnight = Date.UTC(date.year, date.month - 1, date.day);
  const offsets = new Set([
    offsetAt(midnight - DAY_MS, timeZone),
    offsetAt(midnight, timeZone),
    offsetAt(midnight + DAY_MS, timeZone),
  ]);
  let start: number | null = null;
  for (const offset of offsets) {
    const candidate = midnight - offset;
    const onThatDay = dateKey(localDateOf(candidate, timeZone)) === dateKey(date);
    if (onThatDay && (start === null || candidate < start)) {
      start = candidate;
    }
  }
  return new Date(start ?? midnight - offsetAt(midnight, timeZone));
}

function localDays(first: LocalDate, count: number, timeZone: string): DateBounds {
  return {
    from: startOfLocalDay(first, timeZone),
    to: startOfLocalDay(addDays(first, count), timeZone),
  };
}

function weekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The semester containing `today`, or the next one when `today` falls between semesters. */
function semester(today: LocalDate, timeZone: string): DateBounds {
  const terms = [today.year - 1, today.year, today.year + 1]
    .flatMap((year) =>
      SEMESTERS.map(({ first, last }) => ({
        first: { year, ...first },
        last: { year: last.month < first.month ? year + 1 : year, ...last },
      })),
    )
    .sort((a, b) => dateKey(a.first) - dateKey(b.first));
  const term = terms.find(({ last }) => dateKey(last) >= dateKey(today));
  if (term === undefined) {
    throw new Error('No semester after today');
  }
  return {
    from: startOfLocalDay(term.first, timeZone),
    to: startOfLocalDay(addDays(term.last, 1), timeZone),
  };
}

/** `[from, to)` of a preset at `now`, in `timeZone`, with weeks starting on `weekStart`. */
export function resolveDatePreset(
  preset: DatePreset,
  now: Date,
  timeZone: string,
  weekStart: WeekStart,
): DateBounds {
  const nowMs = now.getTime();
  const today = localDateOf(nowMs, timeZone);
  switch (preset) {
    case 'today':
      return localDays(today, 1, timeZone);
    case 'tomorrow':
      return localDays(addDays(today, 1), 1, timeZone);
    case 'this_week': {
      const sinceStart = (weekday(today) - (weekStart === 'sun' ? 0 : 1) + 7) % 7;
      return localDays(addDays(today, -sinceStart), 7, timeZone);
    }
    case 'next_7d':
      return { from: new Date(nowMs), to: new Date(nowMs + 7 * DAY_MS) };
    case 'next_14d':
      return { from: new Date(nowMs), to: new Date(nowMs + 14 * DAY_MS) };
    case 'overdue':
      return { from: new Date(0), to: new Date(nowMs) };
    case 'upcoming_7d':
      return { from: new Date(0), to: new Date(nowMs + 7 * DAY_MS) };
    case 'upcoming_14d':
      return { from: new Date(0), to: new Date(nowMs + 14 * DAY_MS) };
    case 'this_month': {
      const first = { year: today.year, month: today.month, day: 1 };
      const next =
        today.month === 12
          ? { year: today.year + 1, month: 1, day: 1 }
          : { year: today.year, month: today.month + 1, day: 1 };
      return { from: startOfLocalDay(first, timeZone), to: startOfLocalDay(next, timeZone) };
    }
    case 'this_semester':
      return semester(today, timeZone);
  }
}

/** Local midnight today: the `@today` value. */
export function startOfToday(now: Date, timeZone: string): Date {
  return resolveDatePreset('today', now, timeZone, 'sun').from;
}

// ─── Relative dates (H4): the same windows the server compiles (server/src/builder/dates.ts) ───

function addMonths(date: LocalDate, months: number): LocalDate {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(date.day, length) };
}

function shift(date: LocalDate, n: number, unit: RelativeUnit): LocalDate {
  if (unit === 'months') {
    return addMonths(date, n);
  }
  return addDays(date, unit === 'weeks' ? n * 7 : n);
}

/** The local day (workspace zone) containing `instant`: `[midnight, next midnight)`. */
export function localDayBounds(instant: Date, timeZone: string): DateBounds {
  return localDays(localDateOf(instant.getTime(), timeZone), 1, timeZone);
}

/**
 * The window of a relative operator, in whole local days: `inLast` n from the start of the day n
 * units ago to the end of today; `inNext` n from the start of today to the end of the day n units
 * ahead; `moreThanAgo` n everything before the start of the day n units ago.
 */
export function resolveRelative(
  operator: 'inLast' | 'notInLast' | 'inNext' | 'notInNext' | 'moreThanAgo',
  n: number,
  unit: RelativeUnit,
  now: Date,
  timeZone: string,
): DateBounds {
  const today = localDateOf(now.getTime(), timeZone);
  const startOf = (date: LocalDate): Date => startOfLocalDay(date, timeZone);
  switch (operator) {
    case 'inLast':
    case 'notInLast':
      return { from: startOf(shift(today, -n, unit)), to: startOf(addDays(today, 1)) };
    case 'inNext':
    case 'notInNext':
      return { from: startOf(today), to: startOf(addDays(shift(today, n, unit), 1)) };
    case 'moreThanAgo':
      return { from: new Date(0), to: startOf(shift(today, -n, unit)) };
  }
}
