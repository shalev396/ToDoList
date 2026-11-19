/**
 * How a recurring to-do repeats in Google Calendar (plan Addendum A3): one RFC 5545 `RRULE` line,
 * as a value object (immutable, compared by value) made only by a strict parser.
 *
 * It takes exactly the parts the Repeat control can produce, each at most once, upper case:
 * - FREQ: DAILY, WEEKLY, MONTHLY or YEARLY (required);
 * - INTERVAL: 1 … 999;
 * - BYDAY: days (MO … SU), each with an ordinal (-5 … -1, 1 … 5) only when MONTHLY;
 * - BYMONTHDAY: -31 … -1, 1 … 31 (never with WEEKLY);
 * - WKST: SU or MO, WEEKLY only: the day a week starts on, which decides the weeks an INTERVAL
 *   counts (every 2 weeks on Sunday and Tuesday holds the Tuesday after each Sunday only when weeks
 *   start on Sunday; RFC 5545's default is Monday);
 * - a YEARLY rule takes neither BYDAY nor BYMONTHDAY: without BYMONTH (not taken) they would mean
 *   every month, or a weekday of the year; a yearly to-do repeats on its start date.
 * - COUNT: 1 … 999, or UNTIL: a date (YYYYMMDD) or a UTC time (YYYYMMDDTHHMMSSZ), never both.
 *
 * Anything else is refused with a 400 that never quotes the value: another part (BYSETPOS,
 * BYMONTH…), a second line, EXDATE or RDATE, a duplicate, a malformed or out-of-range value.
 */
import { ValidationError } from '../../errors/ValidationError.js';

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** The parts it takes, in the order it writes them. */
const PARTS = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'WKST', 'COUNT', 'UNTIL'] as const;
type Part = (typeof PARTS)[number];

const LINE_MAX = 300;
const PREFIX = 'RRULE:';
const PART = /^([A-Z]+)=([A-Z0-9,+-]+)$/;
const WHOLE = /^[1-9]\d{0,2}$/;
const DAY = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/;
const MONTH_DAY = /^-?(?:[1-9]|[12]\d|3[01])$/;
const UNTIL = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/;
/** The week starts it takes: the two a workspace's week can start on. */
const WEEK_STARTS = ['SU', 'MO'] as const;
export type RuleWeekStart = (typeof WEEK_STARTS)[number];

const refuse = (why: string): ValidationError => new ValidationError(`recurrence: ${why}`);

const isPart = (key: string): key is Part => (PARTS as readonly string[]).includes(key);

/** The values of a list part, each matching `pattern`, none twice. */
function listOf(value: string, pattern: RegExp, part: Part): string[] {
  const values = value.split(',');
  if (values.some((entry) => !pattern.test(entry)) || new Set(values).size !== values.length) {
    throw refuse(`${part} is not a list it takes`);
  }
  return values;
}

/** UNTIL, checked as a real date (and time); whether it is a date only. */
function untilOf(value: string): { text: string; dateOnly: boolean } {
  const match = UNTIL.exec(value);
  if (match === null) throw refuse('UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ');
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  const [hour, minute, second] = [match[4], match[5], match[6]].map((part) =>
    part === undefined ? 0 : Number(part),
  ) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw refuse('UNTIL is not a real date');
  }
  return { text: value, dateOnly: match[4] === undefined };
}

export class RecurrenceRule {
  readonly freq: Frequency;
  readonly interval: number | null;
  readonly byDay: readonly string[];
  readonly byMonthDay: readonly number[];
  readonly count: number | null;
  /** As written (YYYYMMDD or YYYYMMDDTHHMMSSZ); null: none. */
  readonly until: string | null;
  /** Whether UNTIL is a date only (null: no UNTIL). */
  readonly untilIsDate: boolean | null;
  /** WKST (null: none, RFC 5545's Monday). */
  readonly weekStart: RuleWeekStart | null;

  private constructor(parts: ReadonlyMap<Part, string>) {
    const freq = parts.get('FREQ');
    if (freq === undefined) throw refuse('FREQ is required');
    if (!(FREQUENCIES as readonly string[]).includes(freq)) {
      throw refuse('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
    }
    this.freq = freq as Frequency;
    this.interval = RecurrenceRule.#whole(parts, 'INTERVAL');
    this.count = RecurrenceRule.#whole(parts, 'COUNT');
    const days = parts.get('BYDAY');
    this.byDay = Object.freeze(days === undefined ? [] : listOf(days, DAY, 'BYDAY'));
    if (this.freq === 'YEARLY' && this.byDay.length > 0) {
      throw refuse('FREQ=YEARLY repeats on its start date: BYDAY is not taken with it');
    }
    if (this.byDay.some((day) => day.length > 2) && this.freq !== 'MONTHLY') {
      throw refuse('a BYDAY ordinal needs FREQ=MONTHLY');
    }
    const monthDays = parts.get('BYMONTHDAY');
    this.byMonthDay = Object.freeze(
      monthDays === undefined ? [] : listOf(monthDays, MONTH_DAY, 'BYMONTHDAY').map(Number),
    );
    if (this.byMonthDay.length > 0 && (this.freq === 'WEEKLY' || this.freq === 'YEARLY')) {
      throw refuse('BYMONTHDAY is taken with FREQ=DAILY or MONTHLY only');
    }
    const weekStart = parts.get('WKST');
    if (weekStart !== undefined && !(WEEK_STARTS as readonly string[]).includes(weekStart)) {
      throw refuse('WKST must be SU or MO');
    }
    if (weekStart !== undefined && this.freq !== 'WEEKLY') {
      throw refuse('WKST is taken with FREQ=WEEKLY only');
    }
    this.weekStart = (weekStart as RuleWeekStart | undefined) ?? null;
    const until = parts.get('UNTIL');
    if (until !== undefined && this.count !== null)
      throw refuse('COUNT and UNTIL exclude each other');
    const parsedUntil = until === undefined ? null : untilOf(until);
    this.until = parsedUntil?.text ?? null;
    this.untilIsDate = parsedUntil?.dateOnly ?? null;
    Object.freeze(this);
  }

  /** One `RRULE:` line, parsed strictly (400 for anything it doesn't take). */
  static parse(line: unknown): RecurrenceRule {
    if (typeof line !== 'string' || line.length > LINE_MAX || !line.startsWith(PREFIX)) {
      throw refuse(`each line must be one RRULE: line of at most ${String(LINE_MAX)} characters`);
    }
    const parts = new Map<Part, string>();
    for (const piece of line.slice(PREFIX.length).split(';')) {
      const match = PART.exec(piece);
      const key = match?.[1];
      const value = match?.[2];
      if (key === undefined || value === undefined) throw refuse('a part is not KEY=VALUE');
      if (!isPart(key)) throw refuse(`only ${PARTS.join(', ')} are taken`);
      if (parts.has(key)) throw refuse(`${key} is given twice`);
      parts.set(key, value);
    }
    return new RecurrenceRule(parts);
  }

  /** An event's `recurrence`: exactly one RRULE line (400 otherwise). */
  static fromLines(lines: unknown): RecurrenceRule {
    if (!Array.isArray(lines) || lines.length !== 1) {
      throw refuse('give exactly one RRULE line');
    }
    return RecurrenceRule.parse(lines[0]);
  }

  /**
   * Whether it fits an event of this kind: RFC 5545 wants UNTIL to match the start (a date for an
   * all-day event, a UTC time for a timed one).
   */
  fits(allDay: boolean): boolean {
    return this.untilIsDate === null || this.untilIsDate === allDay;
  }

  /** The line, in a fixed part order. */
  toString(): string {
    const parts: string[] = [`FREQ=${this.freq}`];
    if (this.interval !== null) parts.push(`INTERVAL=${String(this.interval)}`);
    if (this.byDay.length > 0) parts.push(`BYDAY=${this.byDay.join(',')}`);
    if (this.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${this.byMonthDay.join(',')}`);
    if (this.weekStart !== null) parts.push(`WKST=${this.weekStart}`);
    if (this.count !== null) parts.push(`COUNT=${String(this.count)}`);
    if (this.until !== null) parts.push(`UNTIL=${this.until}`);
    return `${PREFIX}${parts.join(';')}`;
  }

  toJSON(): string {
    return this.toString();
  }

  equals(other: RecurrenceRule): boolean {
    return this.toString() === other.toString();
  }

  static #whole(parts: ReadonlyMap<Part, string>, part: 'INTERVAL' | 'COUNT'): number | null {
    const value = parts.get(part);
    if (value === undefined) return null;
    if (!WHOLE.test(value)) throw refuse(`${part} must be a whole number from 1 to 999`);
    return Number(value);
  }
}
