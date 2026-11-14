import { calendarDaysFrom } from '../../../../components/items/format.ts';

export const DEADLINE_BUCKETS = ['overdue', 'today', 'week', 'later'] as const;
export type DeadlineBucket = (typeof DEADLINE_BUCKETS)[number];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Day of the week (0 = Sunday) of `date` on the calendar of `timeZone`. */
function weekdayIn(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(date);
  return WEEKDAYS.indexOf(name);
}

/**
 * Which group a deadline belongs to, by calendar day in the workspace's time zone (never by
 * 24-hour spans, so a DST day of 23 or 25 hours still lands right):
 * overdue = an earlier day, today, this week = the rest of the week up to its last day, else later.
 */
export function deadlineBucket(
  due: Date,
  now: Date,
  timeZone: string,
  weekStart: 'sun' | 'mon' = 'sun',
): DeadlineBucket {
  const days = calendarDaysFrom(now, due, timeZone);
  if (days < 0) {
    return 'overdue';
  }
  if (days === 0) {
    return 'today';
  }
  const first = weekStart === 'mon' ? 1 : 0;
  const sinceStart = (weekdayIn(now, timeZone) - first + 7) % 7;
  return days <= 6 - sinceStart ? 'week' : 'later';
}

export interface DeadlineGroup<R> {
  bucket: DeadlineBucket;
  rows: R[];
}

/** Rows grouped by bucket in the fixed order, soonest first inside; empty groups are left out. */
export function groupDeadlines<R>(
  rows: readonly R[],
  dueOf: (row: R) => Date,
  now: Date,
  timeZone: string,
  weekStart: 'sun' | 'mon' = 'sun',
): DeadlineGroup<R>[] {
  const sorted = [...rows].sort((a, b) => dueOf(a).getTime() - dueOf(b).getTime());
  return DEADLINE_BUCKETS.map((bucket) => ({
    bucket,
    rows: sorted.filter((row) => deadlineBucket(dueOf(row), now, timeZone, weekStart) === bucket),
  })).filter((group) => group.rows.length > 0);
}
