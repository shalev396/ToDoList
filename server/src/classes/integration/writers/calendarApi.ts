/**
 * The Google Calendar push's writes through the Calendar API, reached only inside
 * GoogleCalendarIntegration's write session (never for a read-only integration):
 * events.insert, events.patch (with `If-Match`) and events.delete, nothing else, on
 * `<calendar base>/calendars/<id>/events…` only. The base is Google's (googleEndpoints), or a
 * test's stand-in. No redirect is followed, a call gives up after 15 s, and a
 * failure is a CalendarApiError with the HTTP status only: never a token, a body or a URL.
 */
import { loopbackAllowedForTests } from '../../../config/testSwitches.js';
import { assertPublicHttpsUrl } from '../../../services/netGuard.js';
import { googleEndpoints } from '../../../sync/providers/googleEndpoints.js';
import type { EventBody } from '../../../gcal/diff.js';

const TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 1_000_000;

export class CalendarApiError extends Error {
  /** The HTTP status, or null when there was no answer (network, timeout, redirect). */
  readonly status: number | null;

  constructor(status: number | null) {
    super(`Google Calendar answered ${status === null ? 'nothing' : String(status)}`);
    this.name = 'CalendarApiError';
    this.status = status;
  }
}

/** What a write answers with that the commit keeps. */
export interface WrittenEvent {
  id: string;
  etag: string | undefined;
  updated: string | undefined;
}

/** An event a user created a to-do as (H5): no projection marker, so the pull maps it as any event. */
export type PlainEventBody = Omit<EventBody, 'extendedProperties' | 'source'>;

export interface CalendarWriter {
  insert(calendarId: string, event: EventBody | PlainEventBody): Promise<WrittenEvent>;
  patch(
    calendarId: string,
    eventId: string,
    body: Partial<EventBody> & { status?: string },
    etag?: string,
  ): Promise<WrittenEvent>;
  /** 404 and 410 (already gone) are done. */
  remove(calendarId: string, eventId: string): Promise<void>;
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
    throw new CalendarApiError(response.status);
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
  };
}

/** A writer acting with the grant's auth headers (its strategy's, for one push only). */
export function calendarWriter(auth: Readonly<Record<string, string>>): CalendarWriter {
  const call = (
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> => request(auth, method, url, body, headers);

  return {
    async insert(calendarId, event): Promise<WrittenEvent> {
      return writtenEvent(await call('POST', eventsUrl(calendarId), event));
    },
    async patch(calendarId, eventId, body, etag): Promise<WrittenEvent> {
      const ifMatch: Record<string, string> = etag === undefined ? {} : { 'if-match': etag };
      return writtenEvent(await call('PATCH', eventsUrl(calendarId, eventId), body, ifMatch));
    },
    async remove(calendarId, eventId): Promise<void> {
      try {
        await call('DELETE', eventsUrl(calendarId, eventId));
      } catch (error) {
        if (error instanceof CalendarApiError && (error.status === 404 || error.status === 410)) {
          return;
        }
        throw error;
      }
    },
  };
}
