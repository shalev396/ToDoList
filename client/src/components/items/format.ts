/**
 * Date and time text for item rows, through Intl so Hebrew and English read naturally:
 * "in 2 days · Fri 13 Nov" (the format from docs/dashboard/FRONTEND.md §9) or
 * "בעוד 5 ימים · יום ו׳, 13 בנוב׳".
 */

/** Locale for dates and times: day-first 24-hour English, or Israeli Hebrew. */
export function dateLocale(language: string): string {
  return language.startsWith('he') ? 'he-IL' : 'en-GB';
}

/** The browser's own IANA time zone. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Days since 1970-01-01 of the calendar date `date` falls on in `timeZone`. */
function dayNumber(date: Date, timeZone: string): number {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    dayFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Math.round(Date.UTC(read('year'), read('month') - 1, read('day')) / 86_400_000);
}

/** Whole calendar days from `now` to `date` in `timeZone`: 0 today, 1 tomorrow, -1 yesterday. */
export function calendarDaysFrom(now: Date, date: Date, timeZone: string): number {
  return dayNumber(date, timeZone) - dayNumber(now, timeZone);
}

function capitalize(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** "today", "tomorrow", "in 2 days", "3 days ago". `capitalized` starts it with a capital. */
export function relativeDay(days: number, locale: string, capitalized = false): string {
  const text = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');
  return capitalized ? capitalize(text, locale) : text;
}

/** "Fri 13 Nov" / "יום ו׳, 13 בנוב׳". */
export function shortDate(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  }).format(date);
}

/** "14:00". */
export function timeOfDay(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date);
}

/** "Wednesday 11 November" / "יום רביעי, 11 בנובמבר". */
export function longDate(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(date);
}

/**
 * Relative plus absolute due text: "in 2 days · Fri 13 Nov". Within a day of now, the absolute
 * part is the time instead: "tomorrow · 23:59".
 */
export function dueText(due: Date, now: Date, locale: string, timeZone: string): string {
  const days = calendarDaysFrom(now, due, timeZone);
  const absolute =
    Math.abs(days) <= 1 ? timeOfDay(due, locale, timeZone) : shortDate(due, locale, timeZone);
  return `${relativeDay(days, locale)} · ${absolute}`;
}

/** Short chip text: "Today", "Tomorrow", "Yesterday", or "Fri 13 Nov" further out. */
export function dueChipText(due: Date, now: Date, locale: string, timeZone: string): string {
  const days = calendarDaysFrom(now, due, timeZone);
  return Math.abs(days) <= 1 ? relativeDay(days, locale, true) : shortDate(due, locale, timeZone);
}

/** Past its due time and not done. A finished item is never overdue. */
export function isOverdue(due: Date, now: Date, done = false): boolean {
  return !done && due.getTime() < now.getTime();
}

/** The first letter of a name's first two words, for avatars: "Noa Levi" → "NL", "נועה לוי" → "נל". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toLocaleUpperCase())
    .join('');
}
