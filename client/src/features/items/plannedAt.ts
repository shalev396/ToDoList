/**
 * "Planned for": the item's own plan, `YYYY-MM-DD` (a day) or `YYYY-MM-DDTHH:mm` (a day and a
 * time), in the workspace's local time. A time without a day is not a plan.
 */
export interface PlannedParts {
  /** `YYYY-MM-DD`, or '' for none. */
  date: string;
  /** `HH:mm`, or '' for none. */
  time: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

/** The day and the time of a stored value; empty parts for none or anything unreadable. */
export function parsePlannedAt(value: string | null | undefined): PlannedParts {
  if (value === null || value === undefined) {
    return { date: '', time: '' };
  }
  const [date = '', time = ''] = value.split('T');
  if (!isRealDate(date)) {
    return { date: '', time: '' };
  }
  return { date, time: TIME.test(time) ? time : '' };
}

/** The value to store; null clears it (no day, or a day that is not real). */
export function formatPlannedAt({ date, time }: PlannedParts): string | null {
  if (!isRealDate(date)) {
    return null;
  }
  return TIME.test(time) ? `${date}T${time}` : date;
}
