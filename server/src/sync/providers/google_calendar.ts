/**
 * Google Calendar (DATA.md §8): the events of the calendars shared with a service account, one
 * way into Items (`kind: event`). One resource per configured calendar (`calendar:<id>`), with the
 * calendar as its container.
 *
 * - Incremental: events.list with the stored `syncToken` (deletions come as `status: cancelled`).
 *   410 Gone means the token expired: it is dropped and the calendar is listed in full.
 * - A deleted event (a cancelled single event or whole series, often sent as its id only) is a
 *   delete-only record: the engine deletes the stored copy, which keeps its title and times.
 * - Full (no token yet, or a full sync is due): every event ending after now − 30 d. It returns
 *   `fullSync` with the window startAt ∈ [now − 30 d, now + 90 d): only a missing event inside it
 *   is deleted, older ones keep their history.
 * - Bounded: a listing of more than MAX_EVENT_PAGES pages, or one naming a page token twice, fails
 *   its resource (nothing swept, no state saved; googleListing.ts).
 * - Recurring events stay series (`singleEvents=false`): the master carries `props.recurrence`, an
 *   exception its `recurringEventId` and `originalStartAt`, for expansion in the client. A
 *   cancelled occurrence stays live as `status: cancelled` (the client hides that occurrence).
 * - Auth: the integration's strategy (`ctx.auth`, classes/integration/auth) hands each resource
 *   its headers:
 *   - `service_account`: a service-account JWT traded for an access token (the strategy's signer), scope
 *     calendar.readonly, once per resource;
 *   - `oauth`: the user's refresh token (sealed `{refreshToken, scope}`, opened by the vault for
 *     the run) traded for an access token once per run, kept in memory for that run only.
 *   Only GETs to the Calendar API leave, plus that one token exchange.
 * - Events the push wrote (`extendedProperties.private.origin = todolist`) are projections of
 *   items already on the dashboard: never imported again, as in the push's commit.
 * - Endpoints are Google's (googleEndpoints), or a test's stand-in.
 *
 * mapCalendarEvent() is pure (no HTTP, no clock).
 */
import { ORIGIN } from '../../gcal/diff.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { SyncStateData } from '../../models/definitions/SyncState.js';
import type { Provider } from '../../types/domain.js';
import { createReadOnlyClient, ProviderHttpError } from '../http.js';
import { googleEndpoints } from './googleEndpoints.js';
import { registerAdapter } from '../registry.js';
import { zonedTime } from '../transports/fixtureDates.js';
import type {
  AdapterContext,
  AdapterFailure,
  AdapterPage,
  ConnectionTestResult,
  DeletedRecord,
  MappedContainer,
  MappedItem,
  ProviderAdapter,
  ResourceResult,
} from '../types.js';
import { pageTokens } from './googleListing.js';

export const GOOGLE_CALENDAR: Provider = 'google_calendar';

/** A start, end or original start: `date` (all-day) or `dateTime` (RFC 3339 with an offset). */
export interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEventAttendee {
  email?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: string;
}

/** The fields of a Google Calendar Events resource the mapper reads. */
export interface GoogleCalendarEvent {
  kind?: string;
  etag?: string;
  id?: string;
  status?: string;
  htmlLink?: string;
  updated?: string;
  summary?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
  recurrence?: string[];
  attendees?: GoogleEventAttendee[];
  transparency?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  extendedProperties?: { private?: Record<string, unknown> };
}

/** What mapping needs besides the event. */
export interface CalendarEventContext {
  /** The calendar the event was listed from: its container, and the scope of its id. */
  calendarId: string;
  /** The integration's account (`source.accountId`). */
  accountId: string;
  /** The zone all-day dates are placed in: the workspace's. */
  timeZone: string;
}

/** An event the mapper cannot place on a calendar: reported as a failure with this code. */
export class UnmappableEventError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`google_calendar event not mapped: ${code}`);
    this.name = 'UnmappableEventError';
    this.code = code;
  }
}

/** RFC 3339 with an offset: a floating time would be read in the server's zone. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A string with something in it, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface EventTime {
  at: Date;
  allDay: boolean;
}

/**
 * A start or end. Absent (no object, or neither field) → null. Present but unusable → throws
 * `bad_event_time`. An all-day `date` is local midnight in `timeZone`.
 */
function eventTime(value: unknown, timeZone: string): EventTime | null {
  if (typeof value !== 'object' || value === null) return null;
  const { date, dateTime } = value as GoogleEventTime;
  if (dateTime !== undefined) {
    const at = instant(dateTime);
    if (at === null) throw new UnmappableEventError('bad_event_time');
    return { at, allDay: false };
  }
  if (date === undefined) return null;
  const match = typeof date === 'string' ? DATE_ONLY.exec(date) : null;
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    match === null ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new UnmappableEventError('bad_event_time');
  }
  return { at: zonedTime({ year, month, day, hour: 0, minute: 0 }, timeZone), allDay: true };
}

/** The objects of a list in the provider's JSON; anything else in it is skipped. */
function objectsOf<T extends object>(value: unknown): T[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(
        (entry): entry is T => typeof entry === 'object' && entry !== null,
      )
    : [];
}

function meetLinkOf(raw: GoogleCalendarEvent): string | null {
  const hangout = text(raw.hangoutLink);
  if (hangout !== null) return hangout;
  const entryPoints = objectsOf<{ entryPointType?: unknown; uri?: unknown }>(
    raw.conferenceData?.entryPoints,
  );
  for (const entry of entryPoints) {
    const uri = entry.entryPointType === 'video' ? text(entry.uri) : null;
    if (uri !== null) return uri;
  }
  return null;
}

/**
 * Google's own event link form (`eid` = base64 of "<eventId> <calendarId>"). Used only for a
 * cancelled occurrence of a series that arrives without `htmlLink` (Google guarantees little more
 * than its id): the engine needs a link on every live record, and the client only uses this one to
 * hide that occurrence. A deleted event needs none: it is a delete-only record.
 */
function cancelledOccurrenceLink(eventId: string, calendarId: string): string {
  const eid = Buffer.from(`${eventId} ${calendarId}`, 'utf8').toString('base64url');
  return `https://www.google.com/calendar/event?eid=${eid}`;
}

/** The item id: event ids are unique per calendar only, and one event can sit on two calendars. */
export function calendarEventExternalId(calendarId: string, eventId: string): string {
  return `${calendarId}:${eventId}`;
}

/**
 * One event → one item, or a delete-only record.
 * - `cancelled` without a `recurringEventId` (a single event, or a whole series) was deleted: a
 *   delete-only record `{externalId, deleted: true}`, whatever else Google sent (often only the
 *   id). The engine deletes the stored copy, which keeps its title and times.
 * - `cancelled` with a `recurringEventId`: one occurrence of a series was cancelled. Google says to
 *   keep it for the series' lifetime, so the item stays live (`cancelled`, `closedAt` = its
 *   `updated`), with the series id and original start the client needs to hide that occurrence.
 * - An invitation the calendar's owner declined is closed (`cancelled`, `closedAt` = `updated`).
 * Throws UnmappableEventError when a time is present but unusable, or a live event has no start.
 */
export function mapCalendarEvent(
  raw: GoogleCalendarEvent,
  ctx: CalendarEventContext,
): MappedItem | DeletedRecord {
  const eventId = text(raw.id);
  const externalId = eventId === null ? '' : calendarEventExternalId(ctx.calendarId, eventId);
  const recurringEventId = text(raw.recurringEventId);
  const cancelled = raw.status === 'cancelled';
  if (cancelled && recurringEventId === null) return { externalId, deleted: true };
  // From here on, a cancelled event is one cancelled occurrence of a series, kept live.

  const start = eventTime(raw.start, ctx.timeZone);
  const end = eventTime(raw.end, ctx.timeZone);
  const originalStart = eventTime(raw.originalStartTime, ctx.timeZone);
  if (start === null && !cancelled) throw new UnmappableEventError('bad_event_time');

  const attendees = objectsOf<GoogleEventAttendee>(raw.attendees);
  const declined =
    !cancelled &&
    attendees.some((attendee) => attendee.self === true && attendee.responseStatus === 'declined');
  const updated = instant(raw.updated);
  const recurrence = Array.isArray(raw.recurrence)
    ? (raw.recurrence as unknown[])
        .filter((line): line is string => typeof line === 'string')
        .sort()
    : null;

  return {
    kind: 'event',
    title: text(raw.summary) ?? eventId ?? '',
    status: cancelled || declined ? 'cancelled' : 'open',
    statusRaw: declined ? 'declined' : text(raw.status),
    startAt: start?.at ?? originalStart?.at ?? null,
    endAt: end?.at ?? null,
    allDay: start?.allDay ?? false,
    closedAt: declined || cancelled ? updated : null,
    containerExternalId: ctx.calendarId,
    props: {
      calendarId: ctx.calendarId,
      eventId,
      location: text(raw.location),
      meetLink: meetLinkOf(raw),
      recurringEventId,
      recurrence,
      originalStartAt: originalStart?.at.toISOString() ?? null,
      attendeesCount: attendees.filter((attendee) => attendee.resource !== true).length,
      // Guests beyond the calendar's owner: moving or deleting such an event changes it for them.
      guestsCount: attendees.filter(
        (attendee) => attendee.resource !== true && attendee.self !== true,
      ).length,
      transparency: text(raw.transparency) ?? 'opaque',
    },
    source: {
      provider: GOOGLE_CALENDAR,
      accountId: ctx.accountId,
      externalId,
      key: null,
      url:
        text(raw.htmlLink) ??
        (cancelled && eventId !== null ? cancelledOccurrenceLink(eventId, ctx.calendarId) : ''),
      updatedAtSource: updated,
      etag: text(raw.etag),
      hash: null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

const RESOURCE_PREFIX = 'calendar:';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A full listing covers the events ending after now minus this. */
export const FULL_SYNC_LOOKBACK_DAYS = 30;
/** A full listing sweeps missing events starting up to now plus this. */
export const SWEEP_HORIZON_DAYS = 90;
/** At most 10 requests a second: well inside Google's per-user quotas. */
const MIN_INTERVAL_MS = 100;
const PAGE_SIZE = '250';
/** Pages one calendar listing may take (50,000 events): more fails the resource. */
export const MAX_EVENT_PAGES = 200;

/** The fields of an events.list page that are read. */
interface GoogleEventsPage {
  summary?: unknown;
  timeZone?: unknown;
  items?: unknown;
  nextPageToken?: unknown;
  nextSyncToken?: unknown;
}

/** `config.calendars` (`{id}` objects or plain ids): the ids, in order, each once. */
function calendarIds(integration: IntegrationData): string[] {
  const configured: unknown = integration.config['calendars'];
  if (!Array.isArray(configured)) return [];
  const ids: string[] = [];
  for (const entry of configured as unknown[]) {
    const id: unknown =
      typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : entry;
    if (typeof id === 'string' && id.trim() !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function calendarUrl(calendarId: string): string {
  return `${googleEndpoints().calendar}/calendars/${encodeURIComponent(calendarId)}`;
}

/** "Open in Google Calendar" for a calendar: the API has no link for one. */
function calendarLink(calendarId: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarId)}`;
}

function calendarContainer(
  ctx: AdapterContext,
  calendarId: string,
  page: GoogleEventsPage,
): MappedContainer {
  return {
    type: 'calendar',
    name: text(page.summary) ?? calendarId,
    props: { calendarId, timeZone: text(page.timeZone) },
    source: {
      provider: GOOGLE_CALENDAR,
      accountId: ctx.integration.accountId,
      externalId: calendarId,
      key: null,
      url: calendarLink(calendarId),
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
  };
}

/** A page must be an object with an `items` list (or none): anything else is a bad response. */
function eventsPageOf(data: unknown, status: number): GoogleEventsPage {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ProviderHttpError(GOOGLE_CALENDAR, status, 'bad_response');
  }
  const page: GoogleEventsPage = data;
  if (page.items !== undefined && !Array.isArray(page.items)) {
    throw new ProviderHttpError(GOOGLE_CALENDAR, status, 'bad_response');
  }
  return page;
}

/** An event the push wrote (gcal/diff.ts): its item is on the dashboard already. */
function isOwnProjection(raw: object): boolean {
  const priv: unknown = (raw as GoogleCalendarEvent).extendedProperties?.private;
  return (
    typeof priv === 'object' &&
    priv !== null &&
    (priv as Record<string, unknown>)['origin'] === ORIGIN
  );
}

/**
 * One page's events: mapped, deleted (by id only), or reported as failures (never thrown). The
 * push's own events are left out.
 */
function mapEvents(
  raws: readonly unknown[],
  mapping: CalendarEventContext,
): { items: MappedItem[]; deletedItems: DeletedRecord[]; failures: AdapterFailure[] } {
  const items: MappedItem[] = [];
  const deletedItems: DeletedRecord[] = [];
  const failures: AdapterFailure[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'object' || raw === null) {
      failures.push({ externalId: '', code: 'bad_event' });
      continue;
    }
    if (isOwnProjection(raw)) continue;
    try {
      const mapped = mapCalendarEvent(raw, mapping);
      if ('deleted' in mapped) deletedItems.push(mapped);
      else items.push(mapped);
    } catch (error) {
      if (!(error instanceof UnmappableEventError)) throw error;
      const eventId = text((raw as GoogleCalendarEvent).id);
      failures.push({
        externalId: eventId === null ? '' : calendarEventExternalId(mapping.calendarId, eventId),
        code: error.code,
      });
    }
  }
  return { items, deletedItems, failures };
}

/**
 * Pages through events.list for one calendar, incrementally (`syncToken`) or in full (`timeMin`),
 * with the calendar itself on the first page. Returns the next sync token (last page only).
 */
async function* listEvents(
  ctx: AdapterContext,
  resource: string,
  calendarId: string,
  query: { syncToken: string } | { timeMin: string },
  headers: Record<string, string>,
): AsyncGenerator<AdapterPage, string | null> {
  const mapping: CalendarEventContext = {
    calendarId,
    accountId: ctx.integration.accountId,
    timeZone: ctx.timeZone,
  };
  const nextPage = pageTokens(GOOGLE_CALENDAR, ctx.integration.id, MAX_EVENT_PAGES);
  let pageToken: string | null = null;
  for (let first = true; ; first = false) {
    const url = new URL(`${calendarUrl(calendarId)}/events`);
    url.searchParams.set('singleEvents', 'false');
    url.searchParams.set('showDeleted', 'true');
    url.searchParams.set('maxResults', PAGE_SIZE);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
    const response = await ctx.client.getJson<unknown>(url.href, headers);
    const page = eventsPageOf(response.data, response.status);
    const { items, deletedItems, failures } = mapEvents((page.items ?? []) as unknown[], mapping);
    yield {
      resource,
      containers: first ? [calendarContainer(ctx, calendarId, page)] : [],
      items,
      deletedItems,
      failures,
    };
    pageToken = nextPage(text(page.nextPageToken));
    if (pageToken === null) return text(page.nextSyncToken);
  }
}

async function* fetchCalendar(
  ctx: AdapterContext,
  resource: string,
  calendarId: string,
  state: SyncStateData | null,
): AsyncGenerator<AdapterPage, ResourceResult> {
  const headers = await ctx.auth.headers();
  const syncToken = state?.syncToken ?? null;
  if (syncToken !== null && !ctx.fullSyncDue) {
    try {
      const next = yield* listEvents(ctx, resource, calendarId, { syncToken }, headers);
      return { nextState: { syncToken: next }, fullSync: false };
    } catch (error) {
      // 410 Gone: the sync token expired. Drop it and list the calendar in full.
      if (!(error instanceof ProviderHttpError && error.code === 'gone')) throw error;
    }
  }
  const from = new Date(ctx.now.getTime() - FULL_SYNC_LOOKBACK_DAYS * DAY_MS);
  const to = new Date(ctx.now.getTime() + SWEEP_HORIZON_DAYS * DAY_MS);
  const next = yield* listEvents(
    ctx,
    resource,
    calendarId,
    { timeMin: from.toISOString() },
    headers,
  );
  return { nextState: { syncToken: next }, fullSync: true, window: { field: 'startAt', from, to } };
}

/**
 * OAuth: the refresh, then every configured calendar must be in the account's calendar list (the
 * grant reads calendarList, not calendars.get), or the list itself when none is configured yet.
 * Labelled by the account's email, as connected.
 */
async function testOAuthConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
  const headers = await ctx.auth.headers();
  const list = `${googleEndpoints().calendar}/users/me/calendarList`;
  const ids = calendarIds(ctx.integration);
  if (ids.length === 0) await ctx.client.getJson<unknown>(`${list}?maxResults=1`, headers);
  for (const id of ids) {
    await ctx.client.getJson<unknown>(`${list}/${encodeURIComponent(id)}`, headers);
  }
  return { accountLabel: ctx.integration.label, accountId: ctx.integration.accountId };
}

/**
 * "Test connection": the token exchange, then every configured calendar must be readable, as a
 * sync needs. Labelled by the first calendar's name; the account id is the service account.
 */
async function testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
  if (ctx.auth.kind === 'oauth') return testOAuthConnection(ctx);
  const ids = calendarIds(ctx.integration);
  const [first] = ids;
  if (first === undefined) throw new ProviderHttpError(GOOGLE_CALENDAR, null, 'not_found');
  const headers = await ctx.auth.headers();
  let label: string | null = null;
  for (const id of ids) {
    const { data } = await ctx.client.getJson<unknown>(calendarUrl(id), headers);
    const summary =
      typeof data === 'object' && data !== null
        ? text((data as { summary?: unknown }).summary)
        : null;
    label ??= summary ?? id;
  }
  const clientEmail = text(ctx.auth.account?.() ?? null);
  return {
    accountLabel: label ?? first,
    ...(clientEmail === null ? {} : { accountId: clientEmail }),
  };
}

export const googleCalendarAdapter: ProviderAdapter = {
  provider: GOOGLE_CALENDAR,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: GOOGLE_CALENDAR,
      transport,
      minIntervalMs: MIN_INTERVAL_MS,
      tokenExchangeUrl: googleEndpoints().token,
      ...(clock === undefined ? {} : { clock }),
    }),
  resources: (integration) => calendarIds(integration).map((id) => `${RESOURCE_PREFIX}${id}`),
  fetch(ctx, resource, state) {
    if (!resource.startsWith(RESOURCE_PREFIX)) {
      throw new Error(`google_calendar: unknown resource ${resource}`);
    }
    return fetchCalendar(ctx, resource, resource.slice(RESOURCE_PREFIX.length), state);
  },
  test: testConnection,
};

registerAdapter(googleCalendarAdapter);
