/**
 * The time blocks' shared logic (calendar and clock): which items happen when, in the
 * workspace's time zone. Pure (no DOM, no React): `npm run test:unit` runs it under node.
 *
 * - A recurring series (`props.recurrence`) is expanded here, with the wall-clock rule in the
 *   workspace's zone, so "every Tuesday at 10:00" stays 10:00 across a DST change.
 * - A cancelled occurrence arrives as a live item with `status: 'cancelled'` and
 *   `props.recurringEventId` + `props.originalStartAt`: that occurrence is excluded from its
 *   series (an exdate) and the item itself is never listed. A moved occurrence is a normal item
 *   with the same two props: its original slot is excluded and the item shows at its new time.
 * - A due-only item sits at its due time, marked.
 */
import * as rruleModule from 'rrule';
import type { QueryRowSource } from '@api-types/builder.ts';
import { zonedParts, zonedTime } from '../clock/ClockRing.math.ts';

type Instant = Date | string | null;

/** The part of a /query item row the time blocks read (JSON dates arrive as strings). */
export interface TimeRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  startAt: Instant;
  endAt: Instant;
  dueAt: Instant;
  allDay: boolean;
  source: QueryRowSource;
  props: Record<string, unknown>;
}

export interface Occurrence {
  /** Unique per occurrence (a series has one row and many occurrences). */
  key: string;
  row: TimeRow;
  start: Date;
  /** Null when the item has no end (a point in time). */
  end: Date | null;
  allDay: boolean;
  /** Placed at its due time because it has no start: drawn with a marker. */
  dueOnly: boolean;
}

export interface Range {
  from: Date;
  to: Date;
}

export type WeekStart = 'sun' | 'mon';

const MAX_OCCURRENCES_PER_SERIES = 400;

/**
 * rrule ships a CommonJS build (what node loads, with the exports under `default`) and an ES one
 * (what the bundler loads, with named exports): take the parser from whichever this is.
 */
const rrulestr: typeof rruleModule.rrulestr =
  (rruleModule as unknown as { default?: typeof rruleModule }).default?.rrulestr ??
  rruleModule.rrulestr;

export function toDate(value: Instant): Date | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function floating(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

function fromFloating(date: Date, timeZone: string): Date {
  return zonedTime(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    timeZone,
  );
}

function recurrenceRules(row: TimeRow): string[] {
  const raw = row.props['recurrence'];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (line): line is string => typeof line === 'string' && /^RRULE:/i.test(line.trim()),
  );
}

function seriesKey(
  props: Record<string, unknown>,
  idProp: 'eventId' | 'recurringEventId',
): string | null {
  const calendar = props['calendarId'];
  const id = props[idProp];
  return typeof calendar === 'string' && typeof id === 'string' ? `${calendar}|${id}` : null;
}

/** Every start of a series inside `range` (widened by `lead`, the event's length). */
function seriesStarts(
  row: TimeRow,
  first: Date,
  lead: number,
  range: Range,
  timeZone: string,
): Date[] {
  const rule = recurrenceRules(row)[0];
  if (rule === undefined) {
    return [];
  }
  try {
    const parsed = rrulestr(rule, { dtstart: floating(first, timeZone) });
    const from = floating(new Date(range.from.getTime() - lead), timeZone);
    const to = floating(range.to, timeZone);
    return parsed
      .between(from, to, true)
      .slice(0, MAX_OCCURRENCES_PER_SERIES)
      .map((wall) => fromFloating(wall, timeZone));
  } catch {
    // A rule we can't read: show the series' first event alone rather than nothing.
    return [first];
  }
}

/** The occurrences that overlap `range`, ordered by start. Cancelled items are never listed. */
export function expandOccurrences(
  rows: readonly TimeRow[],
  range: Range,
  timeZone: string,
): Occurrence[] {
  // The slots a series no longer has: cancelled occurrences and the old slot of moved ones.
  const exdates = new Map<string, Set<number>>();
  for (const row of rows) {
    const key = seriesKey(row.props, 'recurringEventId');
    const originalText = row.props['originalStartAt'];
    const original = toDate(typeof originalText === 'string' ? originalText : null);
    if (key !== null && original !== null) {
      const slots = exdates.get(key) ?? new Set<number>();
      slots.add(original.getTime());
      exdates.set(key, slots);
    }
  }

  const out: Occurrence[] = [];
  const overlaps = (start: Date, end: Date | null): boolean =>
    start.getTime() < range.to.getTime() &&
    (end === null ? start.getTime() >= range.from.getTime() : end.getTime() > range.from.getTime());

  for (const row of rows) {
    if (row.status === 'cancelled') {
      continue;
    }
    const startAt = toDate(row.startAt);
    const endAt = toDate(row.endAt);
    const start = startAt ?? toDate(row.dueAt);
    if (start === null) {
      continue;
    }
    const dueOnly = startAt === null;
    const length = endAt !== null && endAt > start ? endAt.getTime() - start.getTime() : 0;
    const own = seriesKey(row.props, 'eventId');
    const skipped = own === null ? undefined : exdates.get(own);

    if (!dueOnly && recurrenceRules(row).length > 0) {
      for (const occurrenceStart of seriesStarts(row, start, length, range, timeZone)) {
        if (skipped?.has(occurrenceStart.getTime()) === true) {
          continue;
        }
        const occurrenceEnd = length > 0 ? new Date(occurrenceStart.getTime() + length) : null;
        if (overlaps(occurrenceStart, occurrenceEnd)) {
          out.push({
            key: `${row.id}@${String(occurrenceStart.getTime())}`,
            row,
            start: occurrenceStart,
            end: occurrenceEnd,
            allDay: row.allDay,
            dueOnly: false,
          });
        }
      }
      continue;
    }
    const end = length > 0 ? endAt : null;
    if (overlaps(start, end)) {
      out.push({ key: row.id, row, start, end, allDay: row.allDay && !dueOnly, dueOnly });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key));
}

function weekdayOf(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Midnight of the local day `days` after the one that contains `date` (negative: before). */
function addLocalDays(date: Date, days: number, timeZone: string): Date {
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

function weekStartOf(date: Date, timeZone: string, weekStart: WeekStart): Date {
  const since = (weekdayOf(date, timeZone) - (weekStart === 'sun' ? 0 : 1) + 7) % 7;
  return addLocalDays(date, -since, timeZone);
}

/** `[from, to)` of the week that contains `date`: 7 local days, whatever their length. */
export function weekRange(date: Date, timeZone: string, weekStart: WeekStart): Range {
  const from = weekStartOf(date, timeZone, weekStart);
  return { from, to: addLocalDays(from, 7, timeZone) };
}

/** What a month grid shows: six whole weeks from the week of the 1st. */
export function monthGridRange(date: Date, timeZone: string, weekStart: WeekStart): Range {
  const p = zonedParts(date, timeZone);
  const first = zonedTime(p.year, p.month, 1, 0, 0, timeZone);
  const from = weekStartOf(first, timeZone, weekStart);
  return { from, to: addLocalDays(from, 42, timeZone) };
}

/** The range a view shows when `date` is in it. */
export function visibleRange(
  view: 'week' | 'month',
  date: Date,
  timeZone: string,
  weekStart: WeekStart,
): Range {
  return view === 'month'
    ? monthGridRange(date, timeZone, weekStart)
    : weekRange(date, timeZone, weekStart);
}
