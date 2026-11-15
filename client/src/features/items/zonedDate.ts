/** The calendar date (`YYYY-MM-DD`) an instant falls on in an IANA time zone. */
export function dateInZone(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** The wall-clock time (`HH:MM`, 24-hour) of an instant in an IANA time zone. */
export function timeInZone(iso: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '00';
  return `${part('hour')}:${part('minute')}`;
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: string): number =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Noon on a calendar date in the zone, as a UTC ISO string. Noon is never inside a DST gap, so a
 * date picked in the sheet lands on that date in the workspace's time zone.
 */
export function noonInZone(date: string, timeZone: string): string {
  return instantInZone(date, '12:00', timeZone);
}

/** `HH:MM` on a calendar date in the zone, as a UTC ISO string. */
export function instantInZone(date: string, time: string, timeZone: string): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 12, minute = 0] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(new Date(guess), timeZone);
  // The offset at the first answer can differ from the one at the guess near a DST change.
  const second = guess - offsetAt(new Date(first), timeZone);
  return new Date(second).toISOString();
}
