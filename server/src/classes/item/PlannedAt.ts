/**
 * When a user plans to do an item ("do it on Saturday"): an immutable value object over the
 * overlay's `plannedAt` (plan Addendum A1, A2). A local date (`YYYY-MM-DD`), or a local date and
 * time (`YYYY-MM-DDTHH:mm`), in the workspace's time zone: a plan is a day on the user's own
 * calendar, so it is kept as the wall time they chose, never an instant that a time-zone change
 * would move.
 *
 * TodoList's own: never synced, never written to a provider. The workspace calendar's push places
 * the item's event there (gcal/diff.ts): a date alone is an all-day event, a date and time a timed
 * one.
 */
import { ValidationError } from '../../errors/ValidationError.js';
import { zonedTime } from '../../sync/transports/fixtureDates.js';

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
/** The years a plan may fall in. */
const FIRST_YEAR = 1970;
const LAST_YEAR = 2999;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number | null;
  minute: number | null;
}

function partsOf(value: string): Parts | null {
  const match = PATTERN.exec(value);
  if (match === null) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  const hour = match[4] === undefined ? null : Number(match[4]);
  const minute = match[5] === undefined ? null : Number(match[5]);
  if (year < FIRST_YEAR || year > LAST_YEAR || month < 1 || month > 12 || day < 1) return null;
  // The month's last day: day 0 of the next month.
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour !== null && (hour > 23 || minute === null || minute > 59)) return null;
  return { year, month, day, hour, minute };
}

export class PlannedAt {
  readonly #value: string;
  readonly #parts: Parts;

  private constructor(value: string, parts: Parts) {
    this.#value = value;
    this.#parts = parts;
    Object.freeze(this);
  }

  /** A value from a request: a real date (and time), else 400 (never quoting the value). */
  static parse(value: unknown): PlannedAt {
    const planned = PlannedAt.from(value);
    if (planned === null) {
      throw new ValidationError(
        'plannedAt: must be a date YYYY-MM-DD or a date and time YYYY-MM-DDTHH:mm',
      );
    }
    return planned;
  }

  /** As stored: null for none, or for anything that is not a valid plan. */
  static from(stored: unknown): PlannedAt | null {
    if (typeof stored !== 'string') return null;
    const parts = partsOf(stored);
    return parts === null ? null : new PlannedAt(stored, parts);
  }

  /**
   * Where a calendar event now starts, as a plan: its day (`date`, an all-day event), or its local
   * day and time in `timeZone` (`dateTime`). Null when it carries neither (or the year is outside
   * a plan's).
   */
  static fromEventStart(
    start: { date?: unknown; dateTime?: unknown } | undefined,
    timeZone: string,
  ): PlannedAt | null {
    if (typeof start?.date === 'string') return PlannedAt.from(start.date);
    if (typeof start?.dateTime !== 'string') return null;
    const at = new Date(start.dateTime);
    if (Number.isNaN(at.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
    return PlannedAt.from(
      `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`,
    );
  }

  /** The local date, `YYYY-MM-DD`. */
  get date(): string {
    return this.#value.slice(0, 10);
  }

  /** Whether a time of day was planned too. */
  get hasTime(): boolean {
    return this.#parts.hour !== null;
  }

  /** The instant it starts in `timeZone`: its time, or the day's midnight. */
  startIn(timeZone: string): Date {
    const { year, month, day, hour, minute } = this.#parts;
    return zonedTime({ year, month, day, hour: hour ?? 0, minute: minute ?? 0 }, timeZone);
  }

  equals(other: PlannedAt | null): boolean {
    return other !== null && other.#value === this.#value;
  }

  toString(): string {
    return this.#value;
  }

  toJSON(): string {
    return this.#value;
  }
}
