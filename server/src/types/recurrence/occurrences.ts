/**
 * Which items happen when, in the workspace's time zone: the one occurrence expansion the server
 * (queries, MCP, the travel planner) and the client (calendar, clock, timeline, agenda, workload,
 * through `@api-types`) share, so both sides agree on every occurrence. Pure: no DOM, no Node
 * APIs, no database.
 *
 * - A series (an RRULE line in `props.recurrence`) is expanded here on the wall clock of the
 *   workspace's zone, so "every Tuesday at 10:00" stays 10:00 across a DST change. That holds for a
 *   Google master and for a local series (a time block) alike.
 * - Google: EXDATE lines in `props.recurrence` remove their slots from the series (a holiday the
 *   organiser took out): a UTC value (`…Z`), a wall time in its TZID (or, floating, in the
 *   workspace's zone), or a date (`VALUE=DATE`: the slot on that day).
 * - Google: a cancelled occurrence arrives as a live item with `status: 'cancelled'` and
 *   `props.recurringEventId` + `props.originalStartAt`, and usually nothing else (Google sends its
 *   id, series and original start only, so its stored title is its raw id): its slot is excluded
 *   from its series (an exdate) and it is listed there instead, `inactive: 'cancelled'`, wearing
 *   its master's title, topic, subject and link (`withSeriesFields`) and, with no end of its own,
 *   its master's length. With no known master (none among the rows, or two copies of it) or a
 *   master the member declined, it is never listed. A moved occurrence is a normal item with the
 *   same two props: its original slot is excluded and the item shows at its new time.
 * - Inactive (the owner's ruling of 2026-11-22): an occurrence the provider cancelled
 *   (`status: 'cancelled'`) or the member disabled in TodoList (`overlay.disabled` on the item, or
 *   on a Google exception's master; its slot in `overlay.disabledOccurrences`) is still listed,
 *   marked `inactive`, so every time view draws it faded and struck through; it takes no time
 *   (never busy, never Now or Next, never a travel anchor). An event the member declined (Google,
 *   `statusRaw: 'declined'`) is never listed.
 * - Local: `props.exceptions` (`{ originalStart, startAt?, endAt?, skipped? }`), keyed by the
 *   occurrence's original start, remove skipped slots and replace moved ones. A moved occurrence
 *   whose new time overlaps the range is listed even when its original slot is outside it.
 * - A due-only item sits at its due time, marked.
 */
import * as rruleModule from 'rrule';
import type { QueryRowSource } from '../builder.js';
import { addLocalDays, wallString, zonedParts, zonedTime } from './zoned.js';

export { wallDate, wallString } from './zoned.js';

type Instant = Date | string | null;

/** What a time view reads of a row's overlay: whether the member disabled it (DATA.md §3.6). */
export interface TimeRowOverlay {
  /** The whole item (a series: every occurrence). */
  disabled?: boolean | null;
  /** One occurrence of a series each, by its original start (ISO 8601). */
  disabledOccurrences?: readonly string[] | null;
}

/** The part of a /query item row the time views read (JSON dates arrive as strings). */
export interface TimeRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  /** The provider's own status: `declined` on a Google event the member declined. */
  statusRaw?: string | null;
  startAt: Instant;
  endAt: Instant;
  dueAt: Instant;
  allDay: boolean;
  source: QueryRowSource;
  props: Record<string, unknown>;
  overlay?: TimeRowOverlay | undefined;
}

/**
 * Why an occurrence takes no time although it is listed: the provider cancelled it, or the member
 * disabled it in TodoList (both drawn faded and struck through; its time reads as free).
 */
export type Inactive = 'cancelled' | 'disabled';

/** One stored change to one occurrence of a local series, keyed by its original start (ISO). */
export interface LocalException {
  originalStart: string;
  startAt?: string;
  endAt?: string;
  skipped?: boolean;
}

export interface Occurrence {
  /**
   * Unique per occurrence (a series has one row and many occurrences):
   * `${seriesRowId ?? row.id}@${originalStart ms}` for an occurrence of a series, `row.id` otherwise.
   */
  key: string;
  row: TimeRow;
  start: Date;
  /** Null when the item has no end (a point in time). */
  end: Date | null;
  allDay: boolean;
  /** Placed at its due time because it has no start: drawn with a marker. */
  dueOnly: boolean;
  /**
   * The slot this occurrence fills in its series (its start before any move). For a Google moved
   * exception row it comes from `props.originalStartAt`. Null for an item that is not part of a
   * series.
   */
  originalStart: Date | null;
  /**
   * The series row's id. For a Google exception row, its master's id when the master is among the
   * rows (null otherwise). Null for an item that is not part of a series.
   */
  seriesRowId: string | null;
  /** Cancelled at the provider or disabled in TodoList: listed, but its time is free. Else null. */
  inactive: Inactive | null;
}

export interface Range {
  from: Date;
  to: Date;
}

export type WeekStart = 'sun' | 'mon';

export const MAX_OCCURRENCES_PER_SERIES = 400;

/** A series with more slots than this has no worked-out end: it is read as one that never ends. */
export const MAX_SLOTS_TO_END = 5000;

/** A rule that ends: by a date (UNTIL) or after a number of occurrences (COUNT). */
const ENDS = /\b(?:UNTIL|COUNT)=/i;

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

function recurrenceRules(props: Readonly<Record<string, unknown>>): string[] {
  const raw = props['recurrence'];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (line): line is string => typeof line === 'string' && /^RRULE:/i.test(line.trim()),
  );
}

/** True when the row repeats: an RRULE line in `props.recurrence` (a Google master or a local series). */
export function isSeriesRow(row: Pick<TimeRow, 'props'>): boolean {
  return recurrenceRules(row.props).length > 0;
}

/** The slots a series' EXDATE lines take out: instants (ms), and whole days (`YYYY-MM-DD`). */
interface ExcludedSlots {
  instants: ReadonlySet<number>;
  days: ReadonlySet<string>;
}

const EXDATE_VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i;

/** A zone name rrule's wall clock can read; null for one Intl doesn't know. */
function knownZone(name: string | undefined): string | null {
  if (name === undefined || name === '') {
    return null;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

/**
 * The slots `EXDATE` lines in `props.recurrence` take out of a series (RFC 5545; Google writes
 * them): `EXDATE:20261125T080000Z` (UTC), `EXDATE;TZID=Asia/Jerusalem:20261125T100000` (a wall
 * time in that zone; without a TZID, or with one Intl doesn't know, in `timeZone`),
 * `EXDATE;VALUE=DATE:20261125` (the day), each with any number of comma-separated values. A value
 * that can't be read is ignored.
 */
function excludedSlotsOf(
  props: Readonly<Record<string, unknown>>,
  timeZone: string,
): ExcludedSlots {
  const instants = new Set<number>();
  const days = new Set<string>();
  const raw = props['recurrence'];
  if (!Array.isArray(raw)) {
    return { instants, days };
  }
  for (const line of raw as unknown[]) {
    if (typeof line !== 'string' || !/^EXDATE[;:]/i.test(line.trim())) {
      continue;
    }
    const text = line.trim();
    const colon = text.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const params = text.slice('EXDATE'.length, colon).split(';');
    const tzid = params.find((param) => /^TZID=/i.test(param))?.slice('TZID='.length);
    const zone = knownZone(tzid) ?? timeZone;
    for (const value of text.slice(colon + 1).split(',')) {
      const match = EXDATE_VALUE.exec(value.trim());
      if (match === null) {
        continue;
      }
      const [, y, mo, d, h, mi, sec, utc] = match;
      if (h === undefined || mi === undefined) {
        days.add(`${String(y)}-${String(mo)}-${String(d)}`);
        continue;
      }
      const instant =
        utc === undefined
          ? zonedTime(Number(y), Number(mo), Number(d), Number(h), Number(mi), zone)
          : new Date(
              Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)),
            );
      if (!Number.isNaN(instant.getTime())) {
        instants.add(instant.getTime());
      }
    }
  }
  return { instants, days };
}

const isInstantText = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(new Date(value).getTime());

/**
 * A local series' exceptions from its props. An entry without a readable `originalStart` is
 * dropped; a field of the wrong type is left out of its entry.
 */
export function localExceptionsOf(props: Readonly<Record<string, unknown>>): LocalException[] {
  const raw = props['exceptions'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LocalException[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const fields = entry as Record<string, unknown>;
    const originalStart = fields['originalStart'];
    if (!isInstantText(originalStart)) {
      continue;
    }
    const exception: LocalException = { originalStart };
    const startAt = fields['startAt'];
    const endAt = fields['endAt'];
    if (isInstantText(startAt)) {
      exception.startAt = startAt;
    }
    if (isInstantText(endAt)) {
      exception.endAt = endAt;
    }
    if (fields['skipped'] === true) {
      exception.skipped = true;
    }
    out.push(exception);
  }
  return out;
}

function seriesKey(
  props: Record<string, unknown>,
  idProp: 'eventId' | 'recurringEventId',
): string | null {
  const calendar = props['calendarId'];
  const id = props[idProp];
  return typeof calendar === 'string' && typeof id === 'string' ? `${calendar}|${id}` : null;
}

/** How far a DST change can move a wall time: wider than any jump a zone makes. */
export const DST_SLACK_MS = 3 * 60 * 60_000;

const UTC_UNTIL = /\bUNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/i;

/**
 * The rule with a UTC `UNTIL` (`UNTIL=20261108T110000Z`, an instant per RFC 5545) restated as the
 * wall time that instant reads in `timeZone`. The expansion runs on floating wall times, so a UTC
 * value left as it is would be read as a wall time and cut the series off up to the zone's offset
 * early or late. A date-only or floating `UNTIL` is already a wall value and is left alone.
 */
function withFloatingUntil(rule: string, timeZone: string): string {
  return rule.replace(
    UTC_UNTIL,
    (_match: string, y: string, mo: string, d: string, h: string, mi: string, s: string) => {
      const instant = new Date(
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
      );
      return `UNTIL=${wallString(instant, timeZone).replace(/[-:]/g, '')}`;
    },
  );
}

/** A series' slots on the wall clock of one zone, from its first occurrence. */
class SeriesSlots {
  private readonly parsed: ReturnType<typeof rrulestr> | null;
  private readonly first: Date;
  private readonly timeZone: string;
  private readonly ends: boolean;

  constructor(rule: string, first: Date, timeZone: string) {
    this.first = first;
    this.timeZone = timeZone;
    this.ends = ENDS.test(rule);
    let parsed: ReturnType<typeof rrulestr> | null = null;
    try {
      parsed = rrulestr(withFloatingUntil(rule, timeZone), {
        dtstart: floating(first, timeZone),
      });
    } catch {
      parsed = null;
    }
    this.parsed = parsed;
  }

  /**
   * The starts of the slots from `after` to `before` (both inclusive), at most
   * MAX_OCCURRENCES_PER_SERIES. A rule that can't be read has one slot: the first occurrence.
   */
  between(after: Date, before: Date): Date[] {
    const fallback = (): Date[] =>
      this.first >= after && this.first <= before ? [this.first] : [];
    if (this.parsed === null) {
      return fallback();
    }
    try {
      return this.parsed
        .between(floating(after, this.timeZone), floating(before, this.timeZone), true)
        .slice(0, MAX_OCCURRENCES_PER_SERIES)
        .map((wall) => fromFloating(wall, this.timeZone));
    } catch {
      return fallback();
    }
  }

  /**
   * Every slot of a series that ends (UNTIL or COUNT), in order; null when it never ends, can't be
   * read, or has more than MAX_SLOTS_TO_END slots.
   */
  all(): Date[] | null {
    if (this.parsed === null || !this.ends) {
      return null;
    }
    try {
      const walls = this.parsed.all((_wall, index) => index <= MAX_SLOTS_TO_END);
      return walls.length > MAX_SLOTS_TO_END
        ? null
        : walls.map((wall) => fromFloating(wall, this.timeZone));
    } catch {
      return null;
    }
  }

  /**
   * True when `slot` is one of the series' slots. It searches a few hours either side: a slot
   * whose wall time the clocks skip (02:30 on the spring-forward day) is stored as 03:30, which
   * reads back as a different wall time than the rule's.
   */
  has(slot: Date): boolean {
    return this.between(
      new Date(slot.getTime() - DST_SLACK_MS),
      new Date(slot.getTime() + DST_SLACK_MS),
    ).some((candidate) => candidate.getTime() === slot.getTime());
  }
}

/**
 * True when `slot` is the original start of one of the series' occurrences: its rule from its
 * first start, on the wall clock of `timeZone`, searched DST_SLACK_MS either side (a slot whose
 * wall time the clocks skip is stored as the instant after the jump). Exceptions don't matter: a
 * moved or skipped occurrence keeps its slot. False for a row that doesn't repeat or has no start.
 */
export function seriesHasSlot(
  series: Pick<TimeRow, 'startAt' | 'props'>,
  slot: Date,
  timeZone: string,
): boolean {
  const rule = recurrenceRules(series.props)[0];
  const start = toDate(series.startAt);
  if (rule === undefined || start === null || Number.isNaN(slot.getTime())) {
    return false;
  }
  return new SeriesSlots(rule, start, timeZone).has(slot);
}

/**
 * When a series is over, for the queries' series branch (stored as `props.recurrenceEnd`): the end
 * of its last occurrence, ISO 8601, with its slots placed on the wall clock of `timeZone` (the
 * workspace's) as the expansion places them. A local occurrence moved later counts too. Null when
 * it never ends (no UNTIL or COUNT), its rule can't be read, it has more than MAX_SLOTS_TO_END
 * slots, or it is not a series: a query then reads it whatever the range.
 *
 * Set when a Google master is synced (sync/providers/google_calendar.ts) and when a time block is
 * saved, so a series that ended is not read for every later range.
 */
export function recurrenceEndOf(
  series: Pick<TimeRow, 'startAt' | 'endAt' | 'props'>,
  timeZone: string,
): string | null {
  const rule = recurrenceRules(series.props)[0];
  const start = toDate(series.startAt);
  if (rule === undefined || start === null) {
    return null;
  }
  const slots = new SeriesSlots(rule, start, timeZone).all();
  if (slots === null) {
    return null;
  }
  const end = toDate(series.endAt);
  const length = end !== null && end > start ? end.getTime() - start.getTime() : 0;
  let last = start.getTime() + length;
  for (const slot of slots) {
    last = Math.max(last, slot.getTime() + length);
  }
  for (const exception of localExceptionsOf(series.props)) {
    const moved = toDate(exception.startAt ?? null);
    const movedEnd =
      toDate(exception.endAt ?? null) ??
      (moved === null ? null : new Date(moved.getTime() + length));
    if (exception.skipped !== true && movedEnd !== null) {
      last = Math.max(last, movedEnd.getTime());
    }
  }
  return new Date(last).toISOString();
}

/** A Google event the member declined: never listed (as before the inactive state). */
export function isDeclined(row: Pick<TimeRow, 'status' | 'statusRaw' | 'source'>): boolean {
  return (
    row.status === 'cancelled' &&
    row.source.provider === 'google_calendar' &&
    row.statusRaw === 'declined'
  );
}

/** The original starts (ms) of the occurrences a row's overlay disables one by one. */
function disabledSlotsOf(overlay: TimeRowOverlay | undefined): ReadonlySet<number> {
  const slots = new Set<number>();
  for (const text of overlay?.disabledOccurrences ?? []) {
    const date = toDate(typeof text === 'string' ? text : null);
    if (date !== null) {
      slots.add(date.getTime());
    }
  }
  return slots;
}

/** An occurrence that takes its time: neither cancelled nor disabled. */
export function isActive(occurrence: Pick<Occurrence, 'inactive'>): boolean {
  return occurrence.inactive === null;
}

/** What a Google master lends its exception rows: its id, length, row and disabled state. */
interface MasterInfo {
  id: string;
  /** The master row itself: a cancelled occurrence wears its title, topic and link. */
  row: TimeRow;
  /** ms; 0 when it has no end. */
  length: number;
  /** The member declined the series: none of its cancelled occurrences is listed either. */
  declined: boolean;
  /** A display rule hides the series: none of its cancelled occurrences is listed either. */
  hidden: boolean;
  disabled: boolean;
  disabledSlots: ReadonlySet<number>;
}

/**
 * Google masters by `calendarId|eventId`; null when more than one row is that master (one series
 * mirrored through two accounts), so no exception row picks the wrong copy.
 */
function mastersOf(
  rows: readonly TimeRow[],
  hidden: ReadonlySet<TimeRow> = new Set(),
): Map<string, MasterInfo | null> {
  const masters = new Map<string, MasterInfo | null>();
  for (const row of rows) {
    const own = seriesKey(row.props, 'eventId');
    if (own === null || !isSeriesRow(row)) {
      continue;
    }
    const known = masters.get(own);
    const start = toDate(row.startAt);
    const end = toDate(row.endAt);
    masters.set(
      own,
      known === undefined || known?.id === row.id
        ? {
            id: row.id,
            row,
            length:
              start !== null && end !== null && end > start ? end.getTime() - start.getTime() : 0,
            declined: isDeclined(row),
            hidden: hidden.has(row),
            disabled: row.overlay?.disabled === true,
            disabledSlots: disabledSlotsOf(row.overlay),
          }
        : null,
    );
  }
  return masters;
}

/** A cancelled exception row of a Google series (`recurringEventId`): its own data is Google's id. */
export function isCancelledException(row: Pick<TimeRow, 'status' | 'props'>): boolean {
  return row.status === 'cancelled' && seriesKey(row.props, 'recurringEventId') !== null;
}

/**
 * A cancelled occurrence's row, dressed as its series: the master's title, link and, where the row
 * type has them, its topic and the overlay's topic and subject (what its colour reads). Its own id,
 * status, times, props and disabled state stay, so it is still that occurrence.
 */
export function dressedAs<R extends TimeRow>(row: R, master: TimeRow): R {
  const own = row as unknown as Record<string, unknown>;
  const from = master as unknown as Record<string, unknown>;
  const ownOverlay = (own['overlay'] ?? undefined) as Record<string, unknown> | undefined;
  const fromOverlay = (from['overlay'] ?? undefined) as Record<string, unknown> | undefined;
  return {
    ...row,
    title: master.title,
    source: { ...row.source, url: master.source.url },
    ...('topicId' in from ? { topicId: from['topicId'] } : {}),
    ...(ownOverlay === undefined || fromOverlay === undefined
      ? {}
      : {
          overlay: {
            ...ownOverlay,
            topicOverride: fromOverlay['topicOverride'] ?? null,
            attrs: fromOverlay['attrs'] ?? {},
          },
        }),
  };
}

/**
 * The rows with every cancelled occurrence of a known Google series dressed as its master
 * (`dressedAs`): Google sends a cancelled occurrence's id, series and original start only, so its
 * own title is a raw id and its topic and colour are nobody's. A row with no known master is left
 * as it is (the expansion never lists it). The time views colour and title from these rows; the
 * expansion applies it too.
 */
export function withSeriesFields<R extends TimeRow>(rows: readonly R[]): R[] {
  const masters = mastersOf(rows);
  return rows.map((row) => {
    if (!isCancelledException(row)) {
      return row;
    }
    const key = seriesKey(row.props, 'recurringEventId');
    const master = key === null ? undefined : masters.get(key);
    return master === undefined || master === null ? row : dressedAs(row, master.row);
  });
}

/** How an expansion reads its rows beyond the ones it lists. */
export interface ExpandOptions {
  /**
   * Rows a display rule hides: never listed, but they still take their slots out of their series
   * (a hidden cancelled occurrence never turns back into an active, busy one), and a hidden
   * master's cancelled occurrences are not listed either.
   */
  hidden?: readonly TimeRow[];
}

/**
 * The occurrences that overlap `range`, ordered by start. A cancelled or disabled one is listed
 * with `inactive` set (its time is free); a declined event is never listed.
 */
export function expandOccurrences(
  rows: readonly TimeRow[],
  range: Range,
  timeZone: string,
  options: ExpandOptions = {},
): Occurrence[] {
  const hidden = new Set(options.hidden ?? []);
  const every = hidden.size === 0 ? rows : [...rows, ...hidden];
  // The slots a Google series no longer has: cancelled occurrences and the old slot of moved ones.
  const exdates = new Map<string, Set<number>>();
  const masters = mastersOf(every, hidden);
  for (const row of every) {
    // A declined occurrence takes its slot out too (it is never listed itself).
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
    if (isDeclined(row)) {
      continue;
    }
    const cancelled = row.status === 'cancelled';
    const rowDisabled = row.overlay?.disabled === true;
    const startAt = toDate(row.startAt);
    const endAt = toDate(row.endAt);
    const start = startAt ?? toDate(row.dueAt);
    if (start === null) {
      continue;
    }
    const dueOnly = startAt === null;
    const length = endAt !== null && endAt > start ? endAt.getTime() - start.getTime() : 0;
    const rule = recurrenceRules(row.props)[0];

    if (!dueOnly && rule !== undefined) {
      const own = seriesKey(row.props, 'eventId');
      const gone = own === null ? undefined : exdates.get(own);
      const excluded = excludedSlotsOf(row.props, timeZone);
      const disabledSlots = disabledSlotsOf(row.overlay);
      const isExcluded = (slot: Date): boolean =>
        excluded.instants.has(slot.getTime()) ||
        (excluded.days.size > 0 && excluded.days.has(wallString(slot, timeZone).slice(0, 10)));
      const exceptions = new Map<number, LocalException>();
      if (row.source.provider === 'local') {
        for (const exception of localExceptionsOf(row.props)) {
          exceptions.set(new Date(exception.originalStart).getTime(), exception);
        }
      }
      // The occurrence that fills one slot, at its exception's times or the slot's own; null when
      // the slot is skipped, taken by an exception row, or lands outside the range.
      const occurrenceOf = (slot: Date): Occurrence | null => {
        const exception = exceptions.get(slot.getTime());
        if (exception?.skipped === true || gone?.has(slot.getTime()) === true || isExcluded(slot)) {
          return null;
        }
        const occurrenceStart = toDate(exception?.startAt ?? null) ?? slot;
        const movedEnd = toDate(exception?.endAt ?? null);
        // A move that names no (valid) end keeps the series' length.
        const occurrenceEnd =
          movedEnd !== null && movedEnd > occurrenceStart
            ? movedEnd
            : length > 0
              ? new Date(occurrenceStart.getTime() + length)
              : null;
        if (!overlaps(occurrenceStart, occurrenceEnd)) {
          return null;
        }
        return {
          key: `${row.id}@${String(slot.getTime())}`,
          row,
          start: occurrenceStart,
          end: occurrenceEnd,
          allDay: row.allDay,
          dueOnly: false,
          originalStart: slot,
          seriesRowId: row.id,
          inactive: cancelled
            ? 'cancelled'
            : rowDisabled || disabledSlots.has(slot.getTime())
              ? 'disabled'
              : null,
        };
      };

      // Every slot in the range, widened by the event's length.
      const series = new SeriesSlots(rule, start, timeZone);
      const inRange = new Set<number>();
      for (const slot of series.between(new Date(range.from.getTime() - length), range.to)) {
        inRange.add(slot.getTime());
        const occurrence = occurrenceOf(slot);
        if (occurrence !== null) {
          out.push(occurrence);
        }
      }
      // A slot outside the range whose exception moves it into the range. An exception whose
      // original start is no slot of the series is ignored.
      for (const slotTime of exceptions.keys()) {
        if (inRange.has(slotTime)) {
          continue;
        }
        const slot = new Date(slotTime);
        const occurrence = occurrenceOf(slot);
        if (occurrence !== null && series.has(slot)) {
          out.push(occurrence);
        }
      }
      continue;
    }

    // A Google exception row (moved or cancelled): keyed by its master and original slot, like the
    // master's own, and disabled with it.
    const series = seriesKey(row.props, 'recurringEventId');
    const originalText = row.props['originalStartAt'];
    const originalStart =
      series === null ? null : toDate(typeof originalText === 'string' ? originalText : null);
    const master = series === null ? undefined : masters.get(series);
    // A cancelled occurrence is Google's id only: listed as its series (dressed as the master),
    // and never when its master is unknown, declined or hidden (it would read as a raw id, or
    // show a series the member said no to or hid).
    const cancelledException = cancelled && series !== null;
    if (
      cancelledException &&
      (master === undefined || master === null || master.declined || master.hidden)
    ) {
      continue;
    }
    const shown =
      cancelledException && master !== undefined && master !== null
        ? dressedAs(row, master.row)
        : row;
    // A cancelled occurrence often comes without an end: it lasts as long as its series' slots.
    const ownLength = length > 0 ? length : cancelled && !dueOnly ? (master?.length ?? 0) : 0;
    const end = ownLength > 0 ? new Date(start.getTime() + ownLength) : null;
    if (overlaps(start, end)) {
      const seriesRowId = master?.id ?? null;
      const seriesDisabled =
        master !== undefined &&
        master !== null &&
        (master.disabled ||
          (originalStart !== null && master.disabledSlots.has(originalStart.getTime())));
      out.push({
        key:
          originalStart === null
            ? row.id
            : `${seriesRowId ?? row.id}@${String(originalStart.getTime())}`,
        row: shown,
        start,
        end,
        allDay: row.allDay && !dueOnly,
        dueOnly,
        originalStart,
        seriesRowId: originalStart === null ? null : seriesRowId,
        inactive: cancelled ? 'cancelled' : rowDisabled || seriesDisabled ? 'disabled' : null,
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key));
}

function weekdayOf(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
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
