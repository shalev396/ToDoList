/**
 * What the Google Calendar provider reads and checks (GoogleCalendarIntegration's helpers, moved
 * verbatim out of the class's module): a calendar of the account as the picker lists it, the
 * events TodoList pushed as a pull after a push reads them back, a calendar's name as TodoList
 * creates it, and the limits on what one connection reads. Pure, apart from the reads a caller
 * hands in.
 */
import { z } from 'zod';

import { ORIGIN } from '../../../gcal/diff.js';
import type { ItemData } from '../../../models/definitions/Item.js';
import { eventHasGuests } from '../../item/guests.js';
import type { GoogleCalendarEntry } from '../capabilities.js';
import type { TimeBudget } from '../calendar/TimeBudget.js';
import type { CalendarReader } from '../writers/calendarApi.js';
import { statusOf } from './googleCalendarFailures.js';

export const MAX_CALENDAR_PAGES = 10;
const MAX_PULL_PAGES = 10;
const ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'writer', 'reader', 'freeBusyReader']);

/** One calendar's pulled changes, in the shape the commit reads (PushCommit's CalendarResult). */
export interface PulledCalendar {
  id: string;
  events: Record<string, unknown>[];
  nextSyncToken: string | null;
  fullSync: boolean;
  reset: boolean;
  partial: boolean;
}

/** The most calendars one connection reads (the definition's `.max(50)`). */
export const MAX_READ_CALENDARS = 50;
export const TOO_MANY_READS =
  'calendars: this connection reads 50 calendars, the most; untick one to read the workspace calendar';

/** Whether a stored entry of `config.calendars` is `calendarId` (an object, or a legacy plain id). */
export function readsCalendar(entry: unknown, calendarId: string): boolean {
  return entry === calendarId || (entry as { id?: unknown } | null)?.id === calendarId;
}

/** A calendar's name as TodoList creates it: one line of text. */
export const CalendarName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !Array.from(name).some((char) => (char.codePointAt(0) ?? 0) < 32), {
    message: 'Must be one line of text',
  });

/** Whether a pulled event has guests beyond the calendar's owner (classes/item/guests.ts). */
export function hasGuests(item: ItemData): boolean {
  return eventHasGuests(item.props);
}

/** Events.list from the start of time: every event of a calendar (deleted ones marked so). */
export const ALL_EVENTS_FROM = '1970-01-01T00:00:00.000Z';
/** Pages read to decide whether a calendar TodoList created holds anything else. */
export const MAX_FOREIGN_PAGES = 5;

/** One pulled event of this integration: its item, and where it is at Google. */
export interface OwnEvent {
  stored: ItemData;
  calendarId: string;
  eventId: string;
}

export function calendarEntry(raw: unknown): GoogleCalendarEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, summary, summaryOverride, primary, accessRole } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !/^\S{1,255}$/.test(id)) return null;
  const name =
    typeof summaryOverride === 'string' && summaryOverride.trim() !== ''
      ? summaryOverride
      : typeof summary === 'string' && summary.trim() !== ''
        ? summary
        : id;
  return {
    id,
    summary: name.slice(0, 200),
    primary: primary === true,
    accessRole:
      typeof accessRole === 'string' && ACCESS_ROLES.has(accessRole) ? accessRole : 'reader',
  };
}

/**
 * Lists one calendar's changes: incremental with the stored `syncToken` (a 410 is reported as
 * `reset`), otherwise in full from `timeMin`. Only events carrying our origin are kept, each with
 * `priv` (the private extended properties) the commit reads.
 */
export async function pullOwnEvents(
  reader: CalendarReader,
  calendarId: string,
  syncToken: string | null,
  timeMin: string,
  budget: TimeBudget,
): Promise<PulledCalendar> {
  const out: PulledCalendar = {
    id: calendarId,
    events: [],
    nextSyncToken: null,
    fullSync: syncToken === null,
    reset: false,
    partial: false,
  };
  const query = syncToken === null ? { timeMin } : { syncToken };
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    if (page > 0 && !budget.canStart()) break;
    let result;
    try {
      result = await reader.list(calendarId, query, pageToken);
    } catch (error) {
      if (syncToken !== null && statusOf(error) === 410) return { ...out, reset: true };
      throw error;
    }
    for (const raw of result.items) {
      const ext = raw['extendedProperties'] as { private?: Record<string, unknown> } | undefined;
      const priv = ext?.private ?? null;
      if (priv?.['origin'] === ORIGIN) out.events.push({ ...raw, priv });
    }
    if (result.nextPageToken === null) {
      out.nextSyncToken = result.nextSyncToken;
      return out;
    }
    pageToken = result.nextPageToken;
  }
  return { ...out, partial: true };
}
