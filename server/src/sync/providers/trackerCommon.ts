/**
 * Mapping helpers the three tracker adapters (Jira, ClickUp, Linear) share. Pure functions, no I/O.
 */
import { zonedTime } from '../transports/fixtureDates.js';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date-only due date ("2026-11-15") as the end of that day in the workspace's zone: 23:59 local
 * time (`allDay` items). Null when the text is not a real calendar date.
 */
export function dateOnlyDueAt(date: string, timeZone: string): Date | null {
  const match = DATE_ONLY.exec(date);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return zonedTime({ year, month, day, hour: 23, minute: 59 }, timeZone);
}

/** An epoch in milliseconds (a string, as ClickUp sends it, or a number). Null when unusable. */
export function epochMsToDate(value: unknown): Date | null {
  const ms = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Trimmed, non-empty, unique and sorted: array order is hashed, so it has to be stable. */
export function sortedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))].sort();
}

/** The calendar date ("2026-11-15") an instant falls on in a time zone. */
export function localDateString(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A plain JSON object (not an array, not null), else null. */
export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-blank string, else null. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A parseable date string as a Date, else null. */
export function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
