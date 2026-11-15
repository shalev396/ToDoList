/**
 * The Google Calendar writes through the Calendar API (the push, an event from a to-do, an event's
 * edit or delete, a calendar of TodoList's own), reached only inside GoogleCalendarIntegration's
 * write session (never for a read-only integration). The writer's allow-list is exact, by method
 * and path under the calendar base, with no query:
 *   POST   /calendars                         calendars.insert
 *   POST   /calendars/{id}/events             events.insert
 *   PATCH  /calendars/{id}/events/{eventId}   events.patch (the push's with `If-Match`)
 *   DELETE /calendars/{id}/events/{eventId}   events.delete
 *   DELETE /calendars/{id}                    calendars.delete, ONLY for an id the writer was
 *                                             made with (`deletableCalendars`: the calendars
 *                                             TodoList created on this integration), exactly
 * The event patch and delete may carry exactly one query, `sendUpdates=all` or
 * `sendUpdates=none` (whether Google tells the event's guests). The URL must be exactly as sent:
 * one that the URL parser would normalize (a `.` or `..` segment, encoded or not, an empty
 * segment) is refused, and so is a segment that decodes to something holding `/`, `\` or a
 * control character, so an allowed event call can never land on a calendar's own endpoint.
 * Anything else (another calendar's delete, a clear, an ACL, a GET) is refused before it is
 * sent. The base is
 * Google's (googleEndpoints), or a test's stand-in. No redirect is followed, a call gives up after
 * 8 s (STEP_CEILING_MS), and a failure is a CalendarApiError with the HTTP status and Google's
 * error reason (a one-word token): never a token, a body's text or a URL.
 */
import { loopbackAllowedForTests } from '../../../config/testSwitches.js';
import { assertPublicHttpsUrl } from '../../../services/netGuard.js';
import { googleEndpoints } from '../../../sync/providers/googleEndpoints.js';
import type { EventBody } from '../../../gcal/diff.js';
import { STEP_CEILING_MS } from '../calendar/TimeBudget.js';

/** One call's longest wait: a request's TimeBudget starts a call only with this much left. */
const TIMEOUT_MS = STEP_CEILING_MS;
const MAX_BODY_CHARS = 1_000_000;

export class CalendarApiError extends Error {
  /** The HTTP status, or null when there was no answer (network, timeout, redirect). */
  readonly status: number | null;
  /**
   * Google's error reason (`error.errors[0].reason`: `forbidden`, `rateLimitExceeded`…), a short
   * token checked against REASON, never the error's text; null when none came.
   */
  readonly reason: string | null;

  constructor(status: number | null, reason: string | null = null) {
    super(`Google Calendar answered ${status === null ? 'nothing' : String(status)}`);
    this.name = 'CalendarApiError';
    this.status = status;
    this.reason = reason;
  }
}

/** A Google error reason: one short word, nothing else ever kept from an error body. */
const REASON = /^[A-Za-z]{1,40}$/;

/** Google's `error.errors[0].reason` of an error body, when it is a plain token. */
function reasonOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: { errors?: { reason?: unknown }[] } } | null;
    const reason = body?.error?.errors?.[0]?.reason;
    return typeof reason === 'string' && REASON.test(reason) ? reason : null;
  } catch {
    return null;
  }
}

/** A write the allow-list does not name. A bug in our code, never a user input. */
export class CalendarWriteRefusedError extends Error {
  constructor() {
    super('Refused: not a Calendar API write this client may send');
    this.name = 'CalendarWriteRefusedError';
  }
}

/** What a write answers with that the commit keeps. */
export interface WrittenEvent {
  id: string;
  etag: string | undefined;
  updated: string | undefined;
}

/** An event's edit as Google answered it: what the commit keeps, and the event as it now is. */
export interface UpdatedEvent extends WrittenEvent {
  record: Record<string, unknown>;
}

/** A calendar TodoList created. */
export interface CreatedCalendar {
  id: string;
  summary: string | null;
}

/** An event a user created a to-do as (H5): no projection marker, so the pull maps it as any event. */
export type PlainEventBody = Omit<EventBody, 'extendedProperties' | 'source'>;

/** A to-do's event that repeats (plan Addendum A3): its one RRULE line, checked by RecurrenceRule. */
export type RecurringEventBody = PlainEventBody & { recurrence?: readonly string[] };

/** A changed event time, as a patch sends it: the other form cleared (Google merges a patch). */
export type EventTimeChange =
  | { date: string; dateTime: null; timeZone: null }
  | { dateTime: string; timeZone: string; date: null };

/** An event's edit, as a patch (EventEdit builds it). */
export interface EventChanges {
  summary?: string;
  description?: string;
  start?: EventTimeChange;
  end?: EventTimeChange;
}

/** Whether Google tells an event's guests about a change: `all` or `none` (`sendUpdates`). */
export type GuestUpdates = 'all' | 'none';

export interface CalendarWriter {
  insert(calendarId: string, event: EventBody | RecurringEventBody): Promise<WrittenEvent>;
  patch(
    calendarId: string,
    eventId: string,
    body: Partial<EventBody> & { status?: string },
    etag?: string,
  ): Promise<WrittenEvent>;
  /** An event's edit (CalendarProvider#updateEvent): the event as Google now has it. */
  update(
    calendarId: string,
    eventId: string,
    changes: EventChanges,
    sendUpdates?: GuestUpdates,
  ): Promise<UpdatedEvent>;
  /** 404 and 410 (already gone) are done. */
  remove(calendarId: string, eventId: string, sendUpdates?: GuestUpdates): Promise<void>;
  /** A secondary calendar, owned by the account (calendars.insert). */
  insertCalendar(summary: string, timeZone: string): Promise<CreatedCalendar>;
  /**
   * Deletes a calendar TodoList created (calendars.delete): only one of the writer's
   * `deletableCalendars`, refused before anything is sent otherwise. 404 and 410 (already gone)
   * are done.
   */
  removeCalendar(calendarId: string): Promise<void>;
}

/** What a writer may do beyond its fixed list: the calendars it may delete, by exact id. */
export interface CalendarWriterOptions {
  /** The calendars TodoList created on this integration (its config's `appCreatedCalendars`). */
  deletableCalendars?: readonly string[];
}

/** `/calendars/<id>/events` and `/calendars/<id>/events/<eventId>`, ids percent-encoded. */
const EVENTS = /^\/calendars\/[^/?#]{1,1024}\/events$/;
const EVENT = /^\/calendars\/[^/?#]{1,1024}\/events\/[^/?#]{1,1100}$/;
const CALENDAR = /^\/calendars\/([^/?#]{1,1024})$/;
const GUEST_UPDATES = new Set(['', '?sendUpdates=all', '?sendUpdates=none']);

/** Whether the text holds a slash, a backslash, or a control character (C0 or DEL). */
function hasUnsafeChar(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return char === '/' || char === '\\' || code < 0x20 || code === 0x7f;
  });
}

/**
 * A path segment that is empty, or `.` or `..` once decoded, or decodes to something holding a
 * slash, a backslash or a control character (or that doesn't decode).
 */
function isUnsafeSegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '' || decoded === '.' || decoded === '..' || hasUnsafeChar(decoded);
  } catch {
    return true;
  }
}

/**
 * Whether a write is exactly one this client may send (the header's list): its method, its path
 * under the calendar base, and no query but an event patch's or delete's `sendUpdates`. The URL
 * must be exactly what the parser makes of it, with no dot or empty segment.
 */
export function isAllowedCalendarWrite(
  method: string,
  url: string,
  deletableCalendars: readonly string[] = [],
): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(googleEndpoints().calendar);
  } catch {
    return false;
  }
  if (parsed.href !== url || parsed.hash !== '' || parsed.origin !== base.origin) return false;
  if (!parsed.pathname.startsWith(`${base.pathname}/`)) return false;
  const path = parsed.pathname.slice(base.pathname.length);
  if (path.split('/').slice(1).some(isUnsafeSegment)) return false;
  switch (method) {
    case 'POST':
      return parsed.search === '' && (path === '/calendars' || EVENTS.test(path));
    case 'PATCH':
      return GUEST_UPDATES.has(parsed.search) && EVENT.test(path);
    case 'DELETE': {
      if (GUEST_UPDATES.has(parsed.search) && EVENT.test(path)) return true;
      const calendar = CALENDAR.exec(path)?.[1];
      return (
        parsed.search === '' &&
        calendar !== undefined &&
        deletableCalendars.some((id) => encodeURIComponent(id) === calendar)
      );
    }
    default:
      return false;
  }
}

/** An event's URL, with `sendUpdates` when given. */
function eventUrl(calendarId: string, eventId: string, sendUpdates?: GuestUpdates): string {
  const url = eventsUrl(calendarId, eventId);
  return sendUpdates === undefined ? url : `${url}?sendUpdates=${sendUpdates}`;
}

function eventsUrl(calendarId: string, eventId?: string): string {
  const base = `${googleEndpoints().calendar}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
}

function writtenEvent(data: unknown): WrittenEvent {
  const { id, etag, updated } = (data ?? {}) as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') throw new CalendarApiError(null);
  return {
    id,
    etag: typeof etag === 'string' ? etag : undefined,
    updated: typeof updated === 'string' ? updated : undefined,
  };
}

async function request(
  auth: Readonly<Record<string, string>>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  // The base is a constant (or a test's stand-in): this only re-checks the scheme and host.
  assertPublicHttpsUrl(url, { allowLocal: loopbackAllowedForTests() });
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...auth,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CalendarApiError(null);
  }
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new CalendarApiError(response.status, reasonOf(text.slice(0, MAX_BODY_CHARS)));
  }
  if (text === '' || text.length > MAX_BODY_CHARS) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CalendarApiError(response.status);
  }
}

/** One page of events.list: the raw events, and the next page or sync token. */
export interface EventsPage {
  items: Record<string, unknown>[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface CalendarReader {
  /**
   * events.list with `showDeleted=true` and `singleEvents=false`, incrementally (`syncToken`) or
   * from `timeMin` (the two never combine). A dead token is a CalendarApiError(410).
   */
  list(
    calendarId: string,
    query: { syncToken: string } | { timeMin: string },
    pageToken: string | null,
  ): Promise<EventsPage>;
  /** events.get: one event as Google has it, or null when it is gone (404 or 410). */
  get(calendarId: string, eventId: string): Promise<Record<string, unknown> | null>;
}

/** A reader acting with the grant's auth headers (its strategy's): GET events.list only. */
export function calendarReader(auth: Readonly<Record<string, string>>): CalendarReader {
  return {
    async list(calendarId, query, pageToken): Promise<EventsPage> {
      const url = new URL(eventsUrl(calendarId));
      url.searchParams.set('singleEvents', 'false');
      url.searchParams.set('showDeleted', 'true');
      url.searchParams.set('maxResults', '250');
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
      const data = (await request(auth, 'GET', url.href)) as Record<string, unknown> | null;
      const items = Array.isArray(data?.['items']) ? (data['items'] as unknown[]) : [];
      const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
      return {
        items: items.filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        ),
        nextPageToken: str(data?.['nextPageToken']),
        nextSyncToken: str(data?.['nextSyncToken']),
      };
    },
    async get(calendarId, eventId): Promise<Record<string, unknown> | null> {
      try {
        const data = await request(auth, 'GET', eventsUrl(calendarId, eventId));
        return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
      } catch (error) {
        if (error instanceof CalendarApiError && (error.status === 404 || error.status === 410)) {
          return null;
        }
        throw error;
      }
    },
  };
}

/**
 * A writer acting with the grant's auth headers (its strategy's, for one write session only).
 * `deletableCalendars` are the only calendars it may delete, by exact id.
 */
export function calendarWriter(
  auth: Readonly<Record<string, string>>,
  options: CalendarWriterOptions = {},
): CalendarWriter {
  const deletable = Object.freeze([...(options.deletableCalendars ?? [])]);
  const call = (
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> => {
    if (!isAllowedCalendarWrite(method, url, deletable)) {
      return Promise.reject(new CalendarWriteRefusedError());
    }
    return request(auth, method, url, body, headers);
  };

  return {
    async insert(calendarId, event): Promise<WrittenEvent> {
      return writtenEvent(await call('POST', eventsUrl(calendarId), event));
    },
    async patch(calendarId, eventId, body, etag): Promise<WrittenEvent> {
      const ifMatch: Record<string, string> = etag === undefined ? {} : { 'if-match': etag };
      return writtenEvent(await call('PATCH', eventsUrl(calendarId, eventId), body, ifMatch));
    },
    async update(calendarId, eventId, changes, sendUpdates): Promise<UpdatedEvent> {
      const data = await call('PATCH', eventUrl(calendarId, eventId, sendUpdates), changes);
      const record =
        typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
      return { ...writtenEvent(data), record };
    },
    async insertCalendar(summary, timeZone): Promise<CreatedCalendar> {
      const data = await call('POST', `${googleEndpoints().calendar}/calendars`, {
        summary,
        timeZone,
      });
      const { id, summary: named } = (data ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || !/^\S{1,255}$/.test(id)) throw new CalendarApiError(null);
      return { id, summary: typeof named === 'string' ? named : null };
    },
    async remove(calendarId, eventId, sendUpdates): Promise<void> {
      await gone(call('DELETE', eventUrl(calendarId, eventId, sendUpdates)));
    },
    async removeCalendar(calendarId): Promise<void> {
      await gone(
        call('DELETE', `${googleEndpoints().calendar}/calendars/${encodeURIComponent(calendarId)}`),
      );
    },
  };
}

/** A delete: one already gone (404, 410) is done. */
async function gone(deleted: Promise<unknown>): Promise<void> {
  try {
    await deleted;
  } catch (error) {
    if (error instanceof CalendarApiError && (error.status === 404 || error.status === 410)) {
      return;
    }
    throw error;
  }
}
