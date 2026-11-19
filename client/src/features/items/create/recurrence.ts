/**
 * The Repeat control of a new to-do (plan Addendum A3), as pure functions: what the member picked,
 * whether it can be sent, and the one `RRULE:` line it becomes. The line uses only what the
 * server's RecurrenceRule takes (FREQ, INTERVAL, BYDAY, BYMONTHDAY, WKST, COUNT, UNTIL, in that
 * order; a YEARLY rule takes neither BYDAY nor BYMONTHDAY), so a valid choice is never refused there.
 */
import type { PrimaryCalendarView } from '@api-types/primaryCalendar.ts';
import type { WeekStart } from '@api-types/recurrence/occurrences.ts';
import { instantInZone } from '../zonedDate.ts';

/** RFC 5545 weekdays, Monday first (the order BYDAY is written in). */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** The control's first choice, like Google Calendar's. */
export const REPEAT_PRESETS = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'] as const;
export type RepeatPreset = (typeof REPEAT_PRESETS)[number];

/** When the series stops. */
export type RepeatEnd =
  | { kind: 'never' }
  | { kind: 'on'; date: string }
  | { kind: 'after'; count: number };
export type RepeatEndKind = RepeatEnd['kind'];

export interface Repeat {
  preset: RepeatPreset;
  /** Weekly (and a custom weekly rule): the days. Empty: the due date's own day. */
  days: readonly Weekday[];
  /** Custom: every `interval` … (1–999). */
  interval: number;
  /** Custom: … days, weeks, months or years. */
  frequency: Frequency;
  end: RepeatEnd;
}

/** The largest INTERVAL and COUNT the server takes. */
export const REPEAT_MAX = 999;

export const NO_REPEAT: Repeat = {
  preset: 'none',
  days: [],
  interval: 1,
  frequency: 'WEEKLY',
  end: { kind: 'never' },
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real `YYYY-MM-DD`. */
function isRealDate(value: string): boolean {
  const match = DATE.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** The weekday of a `YYYY-MM-DD` date; null when it isn't one. */
export function weekdayOf(date: string): Weekday | null {
  if (!isRealDate(date)) {
    return null;
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  // getUTCDay: 0 is Sunday; WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7] ?? null;
}

export function isRepeating(repeat: Repeat): boolean {
  return repeat.preset !== 'none';
}

/** The rule's frequency for the preset (custom: the member's own). */
export function frequencyOf(repeat: Repeat): Frequency | null {
  switch (repeat.preset) {
    case 'none':
      return null;
    case 'daily':
      return 'DAILY';
    case 'weekly':
      return 'WEEKLY';
    case 'monthly':
      return 'MONTHLY';
    case 'yearly':
      return 'YEARLY';
    case 'custom':
      return repeat.frequency;
  }
}

/**
 * The days a weekly rule repeats on, Monday first: the ones picked, and always the due date's own.
 * Google (RFC 5545) makes the first event, on the due date, an occurrence whatever BYDAY says, so
 * "Weekly on Thursday" from a Tuesday would also hold that Tuesday; naming its day keeps the rule
 * and what the member sees the same.
 */
export function weeklyDays(repeat: Repeat, dueDate: string): Weekday[] {
  const own = weekdayOf(dueDate);
  return WEEKDAYS.filter((day) => repeat.days.includes(day) || day === own);
}

/** Why a repeat can't be sent yet; null when it can (or it doesn't repeat). */
export type RepeatProblem = 'needsDue' | 'interval' | 'count' | 'untilDate' | 'untilBeforeDue';

const isWhole = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= REPEAT_MAX;

export function repeatProblem(repeat: Repeat, dueDate: string): RepeatProblem | null {
  if (!isRepeating(repeat)) {
    return null;
  }
  if (!isRealDate(dueDate)) {
    return 'needsDue';
  }
  if (repeat.preset === 'custom' && !isWhole(repeat.interval)) {
    return 'interval';
  }
  if (repeat.end.kind === 'after' && !isWhole(repeat.end.count)) {
    return 'count';
  }
  if (repeat.end.kind === 'on') {
    if (!isRealDate(repeat.end.date)) {
      return 'untilDate';
    }
    // Same-format dates compare as text.
    if (repeat.end.date < dueDate) {
      return 'untilBeforeDue';
    }
  }
  return null;
}

/**
 * UNTIL for the last day: a date for an all-day series, else the end of that day in the
 * workspace's zone as a UTC time (RFC 5545 wants UNTIL to match the start's form).
 */
export function untilOf(date: string, allDay: boolean, timeZone: string): string {
  if (allDay) {
    return date.replaceAll('-', '');
  }
  const lastMinute = new Date(instantInZone(date, '23:59', timeZone));
  const endOfDay = new Date(lastMinute.getTime() + 59_000);
  return `${endOfDay.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
}

/**
 * The `recurrence` to send: one `RRULE:` line, or null when it doesn't repeat or can't be sent
 * yet (repeatProblem says why). Every N weeks (N > 1) names the workspace's week start (WKST):
 * it decides which weeks are counted, so "every 2 weeks on Sunday and Tuesday" keeps each Tuesday
 * with the Sunday before it when weeks start on Sunday (RFC 5545's default is Monday).
 */
export function buildRecurrence(
  repeat: Repeat,
  context: { dueDate: string; allDay: boolean; timeZone: string; weekStart: WeekStart },
): string[] | null {
  const freq = frequencyOf(repeat);
  if (freq === null || repeatProblem(repeat, context.dueDate) !== null) {
    return null;
  }
  const parts = [`FREQ=${freq}`];
  if (repeat.preset === 'custom' && repeat.interval > 1) {
    parts.push(`INTERVAL=${String(repeat.interval)}`);
  }
  if (freq === 'WEEKLY') {
    parts.push(`BYDAY=${weeklyDays(repeat, context.dueDate).join(',')}`);
    if (repeat.preset === 'custom' && repeat.interval > 1) {
      parts.push(`WKST=${context.weekStart === 'mon' ? 'MO' : 'SU'}`);
    }
  }
  if (repeat.end.kind === 'after') {
    parts.push(`COUNT=${String(repeat.end.count)}`);
  } else if (repeat.end.kind === 'on') {
    parts.push(`UNTIL=${untilOf(repeat.end.date, context.allDay, context.timeZone)}`);
  }
  return [`RRULE:${parts.join(';')}`];
}

/** Why the workspace calendar can't take a repeating to-do from this member; null when it can. */
export type RepeatBlock = 'loading' | 'unset' | 'suspended' | 'notMine' | null;

export function repeatBlockOf(view: PrimaryCalendarView | undefined): RepeatBlock {
  if (view === undefined) {
    return 'loading';
  }
  if (view.state === 'unset') {
    return 'unset';
  }
  if (view.state === 'suspended') {
    return 'suspended';
  }
  // The server creates it as the calendar connection's owner (403 for anyone else).
  return view.mine ? null : 'notMine';
}
