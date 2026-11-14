/**
 * Google Calendar connected with Google OAuth: the one module that opens its credential
 * (`{refreshToken, scope}`) outside the sync engine, through CredentialVault.decryptForSync, for:
 * - the calendar picker: calendarList, as `{id, summary, primary, accessRole}`;
 * - the push: the diff's ops applied through the Calendar API (calendarApi.ts): a create that
 *   exists already is patched, an update carries
 *   `If-Match` (412 is a conflict), a delete of a gone event is done, ops past the deadline are
 *   deferred to the next run;
 * - disconnect: the grant is revoked at Google, unless another live integration (in any
 *   workspace) uses the same Google account, since revoking ends the grant for all of them.
 * Each call refreshes an access token and keeps it in memory for that call only.
 */
import type { IntegrationData } from '../models/definitions/Integration.js';
import { getIntegrationRepository } from '../models/index.js';
import { decryptForSync } from '../services/crypto/credentialVault.js';
import { googleTokenClient, refreshAccessToken } from '../services/googleOAuthClient.js';
import { logger } from '../services/logger.js';
import type { ReadOnlyClient } from '../sync/http.js';
import { googleEndpoints } from '../sync/providers/googleEndpoints.js';
import {
  CalendarApiError,
  calendarReader,
  calendarWriter,
  type CalendarReader,
  type CalendarWriter,
  type PlainEventBody,
  type WrittenEvent,
} from './calendarApi.js';
import { ORIGIN, type WireOp } from './diff.js';

/** One calendar of the account, for the picker. */
export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  /** `owner`, `writer`, `reader` or `freeBusyReader`: only the first two can take a push. */
  accessRole: string;
}

/** An op's outcome, in the shape the commit reads (gcal/commit.ts). */
export interface OpResult {
  opId: string;
  ok: boolean;
  code?: string;
  eventId?: string;
  etag?: string;
  updated?: string;
}

const MAX_CALENDAR_PAGES = 10;
const ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'writer', 'reader', 'freeBusyReader']);

/** Runs `fn` with a fresh access token for the integration's grant. */
async function withAccessToken<T>(
  integrationId: string,
  fn: (accessToken: string, client: ReadOnlyClient) => Promise<T>,
): Promise<T> {
  return decryptForSync(integrationId, async (secret) => {
    const client = googleTokenClient();
    const accessToken = await refreshAccessToken(client, secret['refreshToken'] ?? '');
    return fn(accessToken, client);
  });
}

function calendarEntry(raw: unknown): GoogleCalendarEntry | null {
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

/** The account's calendars (calendarList), primary first. */
export async function listOAuthCalendars(
  integration: Pick<IntegrationData, 'id'>,
): Promise<GoogleCalendarEntry[]> {
  return withAccessToken(integration.id, async (accessToken, client) => {
    const entries: GoogleCalendarEntry[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
      const url = new URL(`${googleEndpoints().calendar}/users/me/calendarList`);
      url.searchParams.set('maxResults', '250');
      if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
      const { data } = await client.getJson<{ items?: unknown; nextPageToken?: unknown }>(
        url.href,
        { authorization: `Bearer ${accessToken}` },
      );
      const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
      for (const item of items) {
        const entry = calendarEntry(item);
        if (entry !== null && !entries.some((known) => known.id === entry.id)) entries.push(entry);
      }
      const next = data.nextPageToken;
      if (typeof next !== 'string' || next === '' || next === pageToken) break;
      pageToken = next;
    }
    return entries.sort((a, b) => Number(b.primary) - Number(a.primary));
  });
}

const statusOf = (error: unknown): number | null =>
  error instanceof CalendarApiError ? error.status : null;

/** One op through the writer, as Code.gs's applyOps_ does it. */
async function applyOp(writer: CalendarWriter, op: WireOp): Promise<OpResult> {
  if (op.type === 'delete') {
    await writer.remove(op.calendarId, op.eventId);
    return { opId: op.opId, ok: true };
  }
  const event = op.event;
  if (event === undefined) return { opId: op.opId, ok: false, code: 'error' };
  let written;
  if (op.type === 'create') {
    try {
      written = await writer.insert(op.calendarId, event);
    } catch (error) {
      // The deterministic id exists already (a create that was cut off, or deleted in Google).
      if (statusOf(error) !== 409) throw error;
      written = await writer.patch(op.calendarId, event.id, { ...event, status: 'confirmed' });
    }
  } else {
    written = await writer.patch(op.calendarId, op.eventId, event, op.etag);
  }
  return {
    opId: op.opId,
    ok: true,
    eventId: written.id,
    ...(written.etag === undefined ? {} : { etag: written.etag }),
    ...(written.updated === undefined ? {} : { updated: written.updated }),
  };
}

/** Every op, in order, until `deadline` (epoch ms); what is left is deferred. Never throws. */
export async function applyOps(
  writer: CalendarWriter,
  ops: readonly WireOp[],
  deadline: number,
  now: () => number = Date.now,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    if (now() > deadline) {
      results.push({ opId: op.opId, ok: false, code: 'deferred' });
      continue;
    }
    try {
      results.push(await applyOp(writer, op));
    } catch (error) {
      const status = statusOf(error);
      results.push({
        opId: op.opId,
        ok: false,
        code: status === 412 ? 'conflict' : status === 429 ? 'rate_limited' : 'error',
      });
    }
  }
  return results;
}

/**
 * H5: one event created from a to-do, in the calendar the user picked. The event id is fixed by
 * the caller (derived from the request id), so a repeat answers 409 and is the same event.
 * Throws CalendarApiError: status null means no answer (the event may exist).
 */
export async function insertOAuthEvent(
  integration: Pick<IntegrationData, 'id'>,
  calendarId: string,
  event: PlainEventBody,
): Promise<WrittenEvent> {
  return withAccessToken(integration.id, async (accessToken) => {
    const writer = calendarWriter(accessToken);
    try {
      return await writer.insert(calendarId, event);
    } catch (error) {
      if (statusOf(error) !== 409) throw error;
      return { id: event.id, etag: undefined, updated: undefined };
    }
  });
}

/** The push's writes for one integration, with its own grant. */
export async function pushOpsWithOAuth(
  integration: Pick<IntegrationData, 'id'>,
  ops: readonly WireOp[],
  deadline: number,
): Promise<OpResult[]> {
  return withAccessToken(integration.id, (accessToken) =>
    applyOps(calendarWriter(accessToken), ops, deadline),
  );
}

/** One calendar's pulled changes, in the shape the commit reads (gcal/commit.ts CalendarResult). */
export interface PulledCalendar {
  id: string;
  events: Record<string, unknown>[];
  nextSyncToken: string | null;
  fullSync: boolean;
  reset: boolean;
  partial: boolean;
}

const MAX_PULL_PAGES = 10;

/**
 * Lists one calendar's changes: incremental with the
 * stored `syncToken` (a 410 is reported as `reset`), otherwise in full from `timeMin`. Only events
 * carrying our origin are kept, each with `priv` (the private extended properties) the commit reads.
 */
export async function pullOwnEvents(
  reader: CalendarReader,
  calendarId: string,
  syncToken: string | null,
  timeMin: string,
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

/** The pull for one integration, with its own grant: `calendars` as `{id, syncToken}`. */
export async function pullOwnEventsWithOAuth(
  integration: Pick<IntegrationData, 'id'>,
  calendars: readonly { id: string; syncToken: string | null }[],
  timeMin: string,
): Promise<PulledCalendar[]> {
  return withAccessToken(integration.id, async (accessToken) => {
    const reader = calendarReader(accessToken);
    const results: PulledCalendar[] = [];
    for (const cal of calendars) {
      results.push(await pullOwnEvents(reader, cal.id, cal.syncToken, timeMin));
    }
    return results;
  });
}

export type RevokeOutcome = 'revoked' | 'shared' | 'failed';

/**
 * Disconnect: hands the grant back to Google (best effort: never throws). `shared` when another
 * live integration uses the same Google account, whose grant revoking would end too.
 */
export async function revokeGoogleGrant(integration: IntegrationData): Promise<RevokeOutcome> {
  try {
    const live = await (await getIntegrationRepository()).listActiveForDispatch();
    const shared = live.some(
      (other) =>
        other.id !== integration.id &&
        other.provider === integration.provider &&
        other.authMethod === 'oauth' &&
        other.accountId === integration.accountId,
    );
    if (shared) return 'shared';
    await decryptForSync(integration.id, async (secret) => {
      await googleTokenClient().revokeToken(secret['refreshToken'] ?? '');
    });
    return 'revoked';
  } catch (error) {
    logger.warn('A Google Calendar grant could not be revoked', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return 'failed';
  }
}
