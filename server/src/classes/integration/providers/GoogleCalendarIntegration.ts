/**
 * Google Calendar connected with Google OAuth (`{refreshToken, scope}`; every call trades the
 * refresh token for an access token kept in memory for that call only), or read through a
 * service account (the demo's fixtures).
 *
 * - the calendar picker: calendarList, as `{id, summary, primary, accessRole}`;
 * - an event created from a to-do (insertEvent, a recurring one with one strictly parsed RRULE
 *   line); a pulled event's edit (updateEvent) or delete (deleteEvent), by its item of this
 *   integration on a calendar it reads, an event with other guests only when the caller says
 *   whether to notify them; a pushed event's delete by its CalendarLink (deleteLinkedEvent, also
 *   right after a to-do with a pushed event is deleted: CalendarLinks.onItemDeleted); a calendar of
 *   TodoList's own (createCalendar, which needs the `calendar.app.created` scope; it is read and
 *   recorded as TodoList's own, the only kind of calendar TodoList may ever delete); and the push
 *   to the workspace's primary calendar: the diff's ops applied through the Calendar API
 *   (writers/calendarOps.ts); all only inside the write session, so a read-only integration never
 *   writes; a dry run writes nothing and is always allowed;
 * - the primary calendar: whether a calendar of this account may be it (primaryCandidate);
 * - the pull after a push: Google-side edits and deletes of what was pushed;
 * - taking back what TodoList added, on its owner's request, within the write budget
 *   (calendar/CalendarCleanup.ts): its pushed events (removePushed), or before a disconnect also
 *   each calendar TodoList created that holds nothing else, then the links (removeAdded);
 * - disconnect: the grant is revoked at Google, unless another live integration (in any
 *   workspace) uses the same Google account, since revoking ends the grant for all of them.
 */
import { z } from 'zod';

import type { Caller } from '../../base/Caller.js';
import { AuditLog } from '../../AuditLog.js';
import { AppError } from '../../../errors/AppError.js';
import { CleanupIncompleteError } from '../../../errors/CleanupIncompleteError.js';
import { EventHasGuestsError } from '../../../errors/EventHasGuestsError.js';
import { NotFoundError } from '../../../errors/NotFoundError.js';
import { ProviderItemMissingError } from '../../../errors/ProviderItemMissingError.js';
import { ProviderNoAnswerError } from '../../../errors/ProviderNoAnswerError.js';
import { ScopeMissingError } from '../../../errors/ScopeMissingError.js';
import { WrittenNotStoredError } from '../../../errors/WrittenNotStoredError.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import {
  eventIdFor,
  ORIGIN,
  PAST_WINDOW_DAYS,
  parseOpId,
  type WireOp,
} from '../../../gcal/diff.js';
import type { CalendarLinkData } from '../../../models/definitions/CalendarLink.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ItemData } from '../../../models/definitions/Item.js';
import {
  getCalendarLinkRepository,
  getIntegrationRepository,
  getItemRepository,
  getWorkspaceRepository,
} from '../../../models/index.js';
import { logger } from '../../../services/logger.js';
import { checkedId } from '../providerIds.js';
import { ProviderHttpError, type ReadOnlyClient } from '../../../sync/http.js';
import {
  calendarEventExternalId,
  mapCalendarEvent,
} from '../../../sync/providers/google_calendar.js';
import { asString } from '../../../sync/providers/trackerCommon.js';
import { googleEndpoints } from '../../../sync/providers/googleEndpoints.js';
import { parseOr400 } from '../../../utils/validation.js';
import type { AdapterContext } from '../../../sync/types.js';
import type { GoogleCalendarConfig } from '../../../types/integrations.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
} from '../../../types/providerCreate.js';
import { cachedCreateOptions } from '../../../services/providerCreate/funnel.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type {
  AddedContentRemover,
  AddedRemoval,
  CalendarDryRun,
  CalendarProvider,
  CalendarPushRequest,
  EventPatch,
  GoogleCalendarEntry,
  GuestNotice,
  ItemRef,
  LinkedItemRef,
  ResourcePicker,
  Revocable,
  SupportsOAuth,
} from '../capabilities.js';
import type { TestableAdapter } from '../connectionTest.js';
import {
  CALENDAR_APP_CREATED_SCOPE,
  GOOGLE_CALENDAR,
  type GoogleCalendarSecret,
} from '../definitions/googleCalendar.js';
import { Calendar } from '../../calendar/Calendar.js';
import { CalendarLink } from '../../calendar/CalendarLink.js';
import { EventClaim, STUCK_CLAIM_MS, type DeleteReading } from '../../calendar/EventClaim.js';
import type { PlanNarrowing } from '../../calendar/PushPlan.js';
import { SyncRun } from '../../sync/SyncRun.js';
import { AppCreatedCalendars } from '../calendar/AppCreatedCalendars.js';
import {
  AddedContentRemoval,
  cleanupBudget,
  PushedEventsRemoval,
  type CalendarContents,
  type CleanupProgress,
  type CleanupSubject,
  type StepOutcome,
} from '../calendar/CalendarCleanup.js';
import { STEP_CEILING_MS, TimeBudget, WRITE_BUDGET_MS } from '../calendar/TimeBudget.js';
import type { PrimaryCalendar } from '../../workspace/PrimaryCalendar.js';
import { WorkspaceSettings } from '../../workspace/WorkspaceSettings.js';
import { EventEdit } from '../EventEdit.js';
import { Integration } from '../Integration.js';
import { eventHasGuests } from '../../item/guests.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import { RecurrenceRule } from '../RecurrenceRule.js';
import {
  CalendarApiError,
  calendarReader,
  calendarWriter,
  type CalendarReader,
  type CalendarWriter,
  type GuestUpdates,
  type PlainEventBody,
  type RecurringEventBody,
  type WrittenEvent,
} from '../writers/calendarApi.js';
import { applyOps, type OpResult } from '../writers/calendarOps.js';
import type { WriteResult } from '../writers/trackerWriter.js';

export type { GoogleCalendarSecret };

/** How long one push may write; the rest waits for the next run (API Gateway stops at 30 s). */
export const PUSH_BUDGET_MS = WRITE_BUDGET_MS;

const MAX_CALENDAR_PAGES = 10;
const MAX_PULL_PAGES = 10;
const ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'writer', 'reader', 'freeBusyReader']);

/** One calendar's pulled changes, in the shape the commit reads (PushCommit's CalendarResult). */
interface PulledCalendar {
  id: string;
  events: Record<string, unknown>[];
  nextSyncToken: string | null;
  fullSync: boolean;
  reset: boolean;
  partial: boolean;
}

const statusOf = (error: unknown): number | null =>
  error instanceof CalendarApiError ? error.status : null;

/** The most calendars one connection reads (the definition's `.max(50)`). */
const MAX_READ_CALENDARS = 50;
const TOO_MANY_READS =
  'calendars: this connection reads 50 calendars, the most; untick one to read the workspace calendar';

/** Whether a stored entry of `config.calendars` is `calendarId` (an object, or a legacy plain id). */
function readsCalendar(entry: unknown, calendarId: string): boolean {
  return entry === calendarId || (entry as { id?: unknown } | null)?.id === calendarId;
}

const RECONNECT = 'Google refused the connection: reconnect Google Calendar';
/** A clean-up step Google refused without saying why: kept, and retried by the next call. */
const RETRIED_LATER =
  'Google refused for now; what is left will be retried. Try again in a moment.';

/** A calendar's name as TodoList creates it: one line of text. */
const CalendarName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !Array.from(name).some((char) => (char.codePointAt(0) ?? 0) < 32), {
    message: 'Must be one line of text',
  });

/** Whether a pulled event has guests beyond the calendar's owner (classes/item/guests.ts). */
function hasGuests(item: ItemData): boolean {
  return eventHasGuests(item.props);
}

/** A Google answer that leaves the outcome unknown (no answer, a timeout, a 5xx): it may have landed. */
function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof CalendarApiError)) return false;
  return error.status === null || error.status >= 500;
}

/** Google's 403 reasons that mean "this account may not do this": a refusal for good. */
const PERMISSION_REASONS: ReadonlySet<string> = new Set([
  'forbidden',
  'insufficientPermissions',
  'requiredAccessLevel',
  'forbiddenForNonOrganizer',
]);

/** Google's 403 reasons that mean "too much, too fast": back off and retry later, like a 429. */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/** A 403 that is Google's rate or usage limit (to retry later), not a refusal. */
function rateLimited(error: CalendarApiError): boolean {
  return error.status === 403 && error.reason !== null && RATE_LIMIT_REASONS.has(error.reason);
}

/**
 * A Google answer that refuses a clean-up step for good, so the step is recorded and dropped, not
 * retried: a rejected request (400), or a 403 whose reason is a permission one. A 403 for a rate
 * limit, or with an unknown or missing reason, is not: it stops the call, and the next one retries.
 */
function refusedForGood(error: unknown): boolean {
  if (!(error instanceof CalendarApiError)) return false;
  if (error.status === 400) return true;
  return error.status === 403 && error.reason !== null && PERMISSION_REASONS.has(error.reason);
}

/**
 * What one read of an event says about a DELETE whose answer was lost: gone (404, or 410 as null)
 * or cancelled → made; live → not made; the read fails → unknown.
 */
async function readingOf(
  get: () => Promise<Record<string, unknown> | null>,
): Promise<DeleteReading> {
  try {
    const event = await get();
    return event === null || event['status'] === 'cancelled' ? 'made' : 'not_made';
  } catch (error) {
    return statusOf(error) === 404 ? 'made' : 'unknown';
  }
}

/** Events.list from the start of time: every event of a calendar (deleted ones marked so). */
const ALL_EVENTS_FROM = '1970-01-01T00:00:00.000Z';
/** Pages read to decide whether a calendar TodoList created holds anything else. */
const MAX_FOREIGN_PAGES = 5;

/** One pulled event of this integration: its item, and where it is at Google. */
interface OwnEvent {
  stored: ItemData;
  calendarId: string;
  eventId: string;
}

/**
 * A write that failed, as the caller answers it: Google's status (never its text), or a grant
 * Google refused to refresh (reconnect).
 */
function calendarFailure(error: unknown, write = false): Error {
  const refused = write ? { code: 'provider_refused' as const } : {};
  if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
    return new AppError(409, RECONNECT, refused);
  }
  if (!(error instanceof CalendarApiError)) {
    return error instanceof Error ? error : new Error('A Google Calendar write failed');
  }
  const { status } = error;
  if (status === null || status >= 500) {
    const silent = 'Google Calendar did not answer. Try again in a moment.';
    // A write: it may have been made there (provider_no_answer, which MCP names too).
    return write ? new ProviderNoAnswerError('google_calendar', silent) : new AppError(502, silent);
  }
  if (status === 401) return new AppError(409, RECONNECT, refused);
  if (rateLimited(error)) {
    return new AppError(429, 'Google Calendar is busy. Try again in a moment.');
  }
  if (status === 403 && !write && !refusedForGood(error)) {
    // No permission reason (an unknown or missing one): nothing was dropped, the next call retries.
    return new AppError(409, RETRIED_LATER);
  }
  if (status === 403) {
    return new AppError(409, 'Google refused this change for this account', refused);
  }
  if (status === 404 || status === 410) return new ProviderItemMissingError('google_calendar');
  if (status === 429) return new AppError(429, 'Google Calendar is busy. Try again in a moment.');
  return new AppError(422, 'Google Calendar rejected this change');
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

/**
 * Lists one calendar's changes: incremental with the stored `syncToken` (a 410 is reported as
 * `reset`), otherwise in full from `timeMin`. Only events carrying our origin are kept, each with
 * `priv` (the private extended properties) the commit reads.
 */
async function pullOwnEvents(
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

export class GoogleCalendarIntegration
  extends Integration<GoogleCalendarConfig, GoogleCalendarSecret, CalendarWriter>
  implements
    CalendarProvider,
    AddedContentRemover,
    ResourcePicker<'calendars'>,
    Revocable,
    SupportsOAuth<GoogleCalendarSecret>
{
  /** What Google Calendar is: its strategies, config, rules, adapter and picker. */
  static readonly definition = GOOGLE_CALENDAR;

  static {
    IntegrationRegistry.instance.register(
      GoogleCalendarIntegration,
      (data) => new GoogleCalendarIntegration(data),
    );
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<GoogleCalendarSecret> {
    return GoogleCalendarIntegration.definition.auth.oauth;
  }

  /** Its owner: the account's calendars (calendarList), primary first. */
  async listCalendars(caller: Caller): Promise<GoogleCalendarEntry[]> {
    this.assertOwner(caller);
    return this.#withGrant(async (auth, client) => {
      const entries: GoogleCalendarEntry[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
        const url = new URL(`${googleEndpoints().calendar}/users/me/calendarList`);
        url.searchParams.set('maxResults', '250');
        if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
        const { data } = await client.getJson<{ items?: unknown; nextPageToken?: unknown }>(
          url.href,
          auth,
        );
        const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
        for (const item of items) {
          const entry = calendarEntry(item);
          if (entry !== null && !entries.some((known) => known.id === entry.id)) {
            entries.push(entry);
          }
        }
        const next = data.nextPageToken;
        if (typeof next !== 'string' || next === '' || next === pageToken) break;
        pageToken = next;
      }
      return entries.sort((a, b) => Number(b.primary) - Number(a.primary));
    });
  }

  /** A Google grant reaches the account's calendars to pick from (the demo's service account: none). */
  get pickerKind(): 'calendars' | null {
    return this.authKind === 'oauth' ? 'calendars' : null;
  }

  /** Its owner: the account's calendars (listCalendars). */
  async pickerResources(caller: Caller): Promise<GoogleCalendarEntry[]> {
    this.assertPicks(caller, this.pickerKind);
    return this.listCalendars(caller);
  }

  /**
   * Its owner reads exactly these calendars (each one of the account's: 400 otherwise). A calendar
   * it already read keeps its mode, a new one is read only. Where TodoList pushes is the
   * workspace's primary calendar, never this choice.
   */
  async choose(caller: Caller, ids: readonly string[]): Promise<Integration> {
    const calendars = new Set((await this.pickerResources(caller)).map((entry) => entry.id));
    if (ids.some((id) => !calendars.has(id))) {
      throw new AppError(400, 'config.calendars: not a calendar of this connection');
    }
    const { calendars: current, ...rest } = this.config;
    const modes = new Map(current.map((calendar) => [calendar.id, calendar.mode]));
    return this.update(caller, {
      config: {
        ...rest,
        calendars: ids.map((id) => ({ id, mode: modes.get(id) ?? 'read' })),
      },
    });
  }

  /**
   * Whether `calendarId` may be the workspace's primary calendar here: this integration is the
   * caller's (404) and connected with Google (400), it is read & write (409
   * `integration_read_only`), and the account can write that calendar (`owner` or `writer`; 400
   * otherwise: Google's calendarList, a read).
   */
  async primaryCandidate(caller: Caller, calendarId: string): Promise<GoogleCalendarEntry> {
    this.assertOwner(caller);
    if (!this.canCreate) {
      throw new AppError(400, 'integrationId: not a Google Calendar connected with Google');
    }
    this.assertWritable(caller);
    const entry = (await this.listCalendars(caller)).find((calendar) => calendar.id === calendarId);
    if (entry === undefined || (entry.accessRole !== 'owner' && entry.accessRole !== 'writer')) {
      throw new AppError(400, 'calendarId: not a calendar this Google account can write');
    }
    return entry;
  }

  /**
   * The create funnel's one step: the calendars an event can be created in (`owner` and
   * `writer`). Only for a caller who could create here now (a read & write integration).
   */
  async createOptions(
    caller: Caller,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    this.assertWritable(caller);
    if (query.step !== 'calendar') throw new AppError(400, 'step: not a step of this provider');
    return cachedCreateOptions(`${caller.userId}|${this.id}|${JSON.stringify(query)}`, async () => {
      const calendars = await this.listCalendars(caller);
      return {
        options: calendars
          .filter((entry) => entry.accessRole === 'owner' || entry.accessRole === 'writer')
          .map((entry) => ({
            id: entry.id,
            name: entry.summary,
            ...(entry.primary ? { hint: 'primary' } : {}),
          })),
      };
    });
  }

  /**
   * H5: one event created from a to-do, in the calendar the user picked, through the write
   * session. The event id is fixed by the caller (derived from the request id), so a repeat
   * answers 409 and is the same event. Only an answer from Google is about the event; a grant or
   * refresh that fails before anything is sent is not, so it propagates.
   *
   * With `recurrence` (plan Addendum A3) the event repeats: exactly one RRULE line, parsed by
   * RecurrenceRule (only the parts the Repeat control makes) and checked against the event (an
   * all-day event's UNTIL is a date, a timed one's a UTC time); anything else is a 400 before the
   * write session opens.
   */
  async insertEvent(
    caller: Caller,
    calendarId: string,
    event: PlainEventBody,
    recurrence?: readonly string[],
  ): Promise<WriteResult> {
    const body = GoogleCalendarIntegration.#withRecurrence(event, recurrence);
    try {
      const state = { existed: false };
      const written = await this.withWriteSession(caller, async ({ writer }) => {
        try {
          return await writer.insert(calendarId, body);
        } catch (error) {
          if (statusOf(error) !== 409) throw error;
          state.existed = true;
          return { id: event.id, etag: undefined, updated: undefined };
        }
      });
      const eid = Buffer.from(`${written.id} ${calendarId}`).toString('base64url');
      return {
        kind: 'created',
        ...(state.existed ? { existed: true } : {}),
        record: {
          id: written.id,
          key: null,
          url: `https://calendar.google.com/calendar/event?eid=${eid}`,
        },
      };
    } catch (error) {
      if (!(error instanceof CalendarApiError)) throw error;
      const { status } = error;
      if (status === null || status >= 500) return { kind: 'unknown' };
      if (status === 401) return { kind: 'refused', reason: 'auth' };
      if (status === 403) return { kind: 'refused', reason: 'forbidden' };
      if (status === 429) return { kind: 'refused', reason: 'rate_limited' };
      return { kind: 'refused', reason: 'rejected' };
    }
  }

  /**
   * Its owner changes one pulled event, by its item: this integration's event item, on one of the
   * calendars it reads (404 otherwise: another integration's, another workspace's, a raw id, an
   * unselected calendar). Its title, its time (given whole) or its description (EventEdit: 400
   * naming the field). An event with other guests needs `notifyGuests` (409 `event_has_guests`
   * otherwise), sent as Google's `sendUpdates`. Audited as `integration.write` (`event.update`,
   * the field names) right after Google takes it; then the item takes what Google answered (its
   * hash cleared for the next sync).
   */
  async updateEvent(
    caller: Caller,
    item: ItemRef,
    patch: EventPatch,
    notice: GuestNotice = {},
  ): Promise<WrittenEvent> {
    this.assertOwner(caller);
    const timeZone = caller.settings.timezone;
    const edit = EventEdit.parse(patch, timeZone);
    const event = await this.#ownEvent(item.id);
    this.assertWritable(caller);
    const sendUpdates = GoogleCalendarIntegration.#guestUpdates(event.stored, notice);
    const meta = { operation: 'event.update', itemId: event.stored.id, fields: [...edit.fields] };
    const updated = await this.#calendarWrite(caller, meta, (writer) =>
      writer.update(event.calendarId, event.eventId, edit.changes, sendUpdates),
    );
    // Google took it: an audit that fails now is logged, never a bare 500 that says it didn't.
    try {
      await this.recordWrite(caller, meta);
    } catch (error) {
      logger.error('A Google Calendar write could not be audited', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    try {
      await this.#refreshItem(event, updated.record, timeZone);
    } catch (error) {
      // Google took it: not "couldn't be saved".
      logger.warn('A Google Calendar write could not be stored', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new WrittenNotStoredError('google_calendar', edit.fields);
    }
    return { id: updated.id, etag: updated.etag, updated: updated.updated };
  }

  /**
   * Its owner deletes one pulled event, by its item (the same checks as updateEvent; one already
   * gone is done); the item goes too. Audited as `integration.write` (`event.delete`) right after
   * Google takes it.
   */
  async deleteEvent(caller: Caller, item: ItemRef, notice: GuestNotice = {}): Promise<void> {
    this.assertOwner(caller);
    const event = await this.#ownEvent(item.id);
    this.assertWritable(caller);
    const sendUpdates = GoogleCalendarIntegration.#guestUpdates(event.stored, notice);
    const meta = { operation: 'event.delete', itemId: event.stored.id };
    await this.#calendarWrite(caller, meta, (writer) =>
      writer.remove(event.calendarId, event.eventId, sendUpdates),
    );
    await this.recordWrite(caller, meta);
    await (
      await getItemRepository()
    ).softDeleteBySource(this.workspaceId, this.#account, [event.stored.source.externalId]);
  }

  /**
   * An event TodoList pushed, deleted by its CalendarLink: this integration's live link for the
   * item, in this workspace, pushed to Google (`to_google`), whose event id is the one TodoList
   * gives that item (eventIdFor): 404 otherwise, so nothing but an event TodoList made for this
   * item can be deleted this way, on whichever calendar it was pushed to. A pushed event has no
   * guests. The link is claimed (tombstoned) before the DELETE is sent, so no push makes it again
   * (#deleteLink, EventClaim). Audited as `integration.write` (`event.delete`) right after Google
   * takes it (with `outcome: 'unknown'` when Google did not answer and a read could not say).
   */
  async deleteLinkedEvent(caller: Caller, link: LinkedItemRef): Promise<void> {
    this.assertOwner(caller);
    const itemId = (link as { itemId?: unknown }).itemId;
    if (typeof itemId !== 'string' || itemId === '') throw new NotFoundError();
    const links = await getCalendarLinkRepository();
    const found = await links.findByItem(this.workspaceId, this.id, itemId);
    if (found === null || !CalendarLink.isOwnLive(found)) {
      throw new NotFoundError();
    }
    await this.#deleteLink(caller, found);
  }

  /**
   * Its owner creates a calendar of TodoList's own, named `name` (one line, 1–255 characters), in
   * the workspace's zone (Google's `calendars.insert`). The grant must carry
   * `calendar.app.created`: one from before TodoList asked for it is 409 `scope_missing` (its
   * owner connects again), checked before anything is opened or sent. Right after Google creates
   * it, it is read by this integration and recorded as TodoList's own (`appCreatedCalendars`: the
   * only calendars TodoList may ever delete). Audited as `integration.write` (`calendar.create`).
   */
  async createCalendar(caller: Caller, name: string): Promise<GoogleCalendarEntry> {
    this.assertWritable(caller);
    const summary = parseOr400(CalendarName, name);
    if (await this.lacksScopes([CALENDAR_APP_CREATED_SCOPE])) {
      throw new ScopeMissingError(
        this.id,
        CALENDAR_APP_CREATED_SCOPE,
        'Google Calendar needs a new permission to create calendars: connect it again to grant it',
      );
    }
    const meta = { operation: 'calendar.create' };
    const created = await this.#calendarWrite(caller, meta, (writer) =>
      writer.insertCalendar(summary, caller.settings.timezone),
    );
    await this.#recordCreated(created.id);
    await this.recordWrite(caller, meta);
    return {
      id: created.id,
      summary: created.summary ?? summary,
      primary: false,
      accessRole: 'owner',
    };
  }

  /**
   * "Also remove everything TodoList added" (before its owner disconnects it), within the request's
   * budget (AddedContentRemoval), in one write session: only while it is read & write (409
   * `integration_read_only`, before anything is read or sent).
   * 1. every live event TodoList pushed with it, except on the current workspace calendar unless
   *    that calendar is this integration's own (a disconnect of the primary integration cleans it);
   * 2. each calendar TodoList created on it (AppCreatedCalendars, nothing else ever) that holds
   *    nothing but this integration's own pushes (contentsOf) and is not the current workspace
   *    calendar of another integration: the user's events or another's push keep it;
   * 3. its links, every one.
   * A step Google refuses for good is recorded and no longer tracked (`failed`). Out of time:
   * CleanupIncompleteError with the progress (what was done stays done, so the next call goes
   * on). Each Google write is audited as `integration.write`; each call as `integration.cleanup`.
   */
  async removeAdded(caller: Caller, budget: TimeBudget = cleanupBudget()): Promise<AddedRemoval> {
    this.assertWritable(caller);
    return this.#cleanUp(caller, 'added', budget);
  }

  /**
   * "Remove" the events TodoList pushed with it (an earlier workspace calendar's, or the old one's
   * on Change and Stop), within the request's budget (PushedEventsRemoval): its owner, read &
   * write only. The current workspace calendar's events are never touched (`skipped`), whichever
   * integration it is on. Out of time: CleanupIncompleteError with the progress.
   */
  async removePushed(
    caller: Caller,
    budget: TimeBudget = cleanupBudget(),
  ): Promise<{ events: number; remaining: 0; skipped: number; failed: number }> {
    this.assertWritable(caller);
    const removed = await this.#cleanUp(caller, 'pushed', budget);
    return {
      events: removed.events,
      remaining: 0,
      skipped: removed.skipped,
      failed: removed.failed,
    };
  }

  /**
   * Its owner: how many events TodoList pushed with it are still live outside the current
   * workspace calendar (a read of the links): what "Remove" would take.
   */
  async pushedEventCount(caller: Caller): Promise<number> {
    this.assertOwner(caller);
    // A claim left unanswered is reconciled first (reads only): a live event counts again.
    await this.#reconcileClaims(TimeBudget.start(WRITE_BUDGET_MS));
    const current = await this.#currentPrimaryCalendarId();
    return (await this.#ownLiveLinks()).filter((link) => link.calendarId !== current).length;
  }

  /** Its owner: what a push would create, update and remove now. Nothing is written. */
  async dryRun(
    caller: Caller,
    narrowing?: PlanNarrowing,
    now: Date = new Date(),
  ): Promise<CalendarDryRun> {
    this.assertOwner(caller);
    const plan = await (await Calendar.primaryFor(this.toJSON())).plan(now, narrowing);
    return plan.toDryRun();
  }

  /**
   * A push, start to commit: a SyncRun (trigger `calendar_push`), the ops through the Calendar API
   * inside the write session, the pull that follows, then the commit (Calendar#commit: links,
   * audit, the run's counts). A read-only integration is refused first (assertWritable),
   * before any run is recorded; the mode is the one this integration was loaded with, so a switch
   * made while the push runs is seen by the next one. The request's budget (`budget`, which its
   * plan already spent part of; PUSH_BUDGET_MS when absent) starts an op only while a call can
   * still end in it: what is left waits for the next run. The pull reads back `calendarId`, the
   * workspace's primary calendar the plan pushed to, within the same budget. Before the run, the
   * integration's stuck claims are reconciled; each delete op is claimed before it is sent
   * (EventClaim). Returns the run's id. 409 to reconnect, 502 when Google is silent (or the
   * credential can't be opened).
   */
  async push(caller: Caller, request: CalendarPushRequest): Promise<string> {
    const { ops, now, calendarId } = request;
    const budget = request.budget ?? TimeBudget.start(PUSH_BUDGET_MS);
    this.assertWritable(caller);
    const { workspaceId } = this;
    // A claim of an earlier call left unanswered (a process that died, a lost answer) is reconciled
    // first, by reads in one read session within the budget, and before this run is created, so a
    // claim it settles never stands for this run.
    await this.#reconcileClaims(budget);
    const run = await SyncRun.begin(this, 'calendar_push', now);
    // Claim before delete: each delete (or move) op's own link is tombstoned before its DELETE is
    // sent; one that is no longer this integration's (adopted, moved) is not sent at all.
    const claims = new Map<string, EventClaim>();
    let sent: { results: OpResult[]; readings: Map<string, DeleteReading> } | null = null;
    try {
      await this.#claimDeletes(ops, claims);
      const toSend = ops.filter((op) => op.type !== 'delete' || claims.has(op.opId));
      try {
        sent = await this.withWriteSession(caller, async ({ writer }) => {
          const results = await applyOps(
            writer,
            toSend,
            budget.deadline,
            Date.now,
            STEP_CEILING_MS,
          );
          return { results, readings: await this.#readLost(writer, results, claims, budget) };
        });
      } catch (error) {
        const authFailed = error instanceof ProviderHttpError && error.code === 'auth_failed';
        // Only while it is still open (a conditional write).
        await run.cancel(
          authFailed
            ? { code: 'auth_failed', message: 'Reconnect required' }
            : { code: 'calendar_unreachable', message: 'Google Calendar did not answer' },
          new Date(),
        );
        if (authFailed) {
          // As a sync would: the integration waits for its owner to reconnect.
          await (
            await getIntegrationRepository()
          ).recordSyncResult(workspaceId, this.id, {
            status: 'error',
            lastError: { code: 'auth_failed', message: 'Reconnect required' },
          });
          throw new AppError(409, 'Google refused the connection: reconnect Google Calendar');
        }
        logger.warn('A Google Calendar push failed', {
          integrationId: this.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        throw new AppError(502, 'Google Calendar did not answer. Try again in a moment.');
      }
    } finally {
      // Nothing was sent (a throw before the ops ran): every claim goes back. Once the ops ran,
      // every claim has a result and is settled, kept or released below, never released blind.
      if (sent === null) {
        for (const claim of claims.values()) await this.#releaseQuietly(claim);
      }
    }
    const opResults = await this.#settleDeletes(sent.results, claims, sent.readings);
    // The pull that follows the writes (their etags are the links' by then, so our echoes are
    // skipped): Google-side edits and deletes of what we pushed. A failed pull never fails the
    // push; the token is kept and the next run lists again.
    const calendars = await this.#pullAfterPush(calendarId, now, budget);
    await Calendar.of(this.toJSON(), calendarId).commit(
      { runId: run.id, opResults, calendars },
      new Date(),
    );
    return run.id;
  }

  /** Its owner hands the grant back to Google (revokeGrant). */
  async revoke(caller: Caller): Promise<void> {
    this.assertOwner(caller);
    await this.revokeGrant();
  }

  /**
   * Disconnect: hands the grant back to Google (best effort: never throws). Left in place when
   * another live integration uses the same Google account, whose grant revoking would end too.
   */
  protected override revokeGrant(): Promise<void> {
    return this.handBackGrant('A Google Calendar grant could not be revoked');
  }

  /**
   * The Calendar API writer, acting with the strategy's headers (a fresh access token) for this
   * one session; the only calendars it may delete are those TodoList created on this integration.
   */
  protected async createWriter(secret: GoogleCalendarSecret): Promise<CalendarWriter> {
    const auth = this.oauth.bind({ secret, client: this.oauth.client(), now: new Date() });
    return calendarWriter(await auth.headers('write'), {
      deletableCalendars: this.#createdCalendars.ids,
    });
  }

  /**
   * A settings change never sets which calendars are TodoList's own: the stored list is kept,
   * whatever was sent (only createCalendar adds to it).
   */
  protected override async checkSelection(
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#keepPrimaryRead(this.#createdCalendars.keptIn(config));
  }

  /**
   * The workspace's primary calendar is always read: when this integration is the primary's and
   * the owner's new list omits it, it stays in the list as a read calendar (not refused).
   */
  async #keepPrimaryRead(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workspace = await (await getWorkspaceRepository()).findById(this.workspaceId);
    const primary =
      workspace === null ? null : WorkspaceSettings.from(workspace.settings).primaryCalendar;
    if (primary?.integrationId !== this.id) return config;
    const calendars: unknown[] = Array.isArray(config['calendars']) ? config['calendars'] : [];
    if (calendars.some((calendar) => readsCalendar(calendar, primary.calendarId))) return config;
    if (calendars.length >= MAX_READ_CALENDARS) throw new ValidationError(TOO_MANY_READS);
    return { ...config, calendars: [...calendars, { id: primary.calendarId, mode: 'read' }] };
  }

  /** The calendars TodoList created on this integration, as stored. */
  get #createdCalendars(): AppCreatedCalendars {
    return AppCreatedCalendars.of(this.config);
  }

  protected probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown> {
    return adapter.test(context);
  }

  /** This integration's items' source account (the natural key's first half). */
  get #account(): { provider: 'google_calendar'; accountId: string; integrationId: string } {
    return { provider: 'google_calendar', accountId: this.accountId, integrationId: this.id };
  }

  /**
   * `fn` with the writer, inside the write session; a failure as the caller answers it. One whose
   * outcome is unknown (no answer, a timeout, a 5xx: it may have landed) is audited first, as
   * `integration.write` with `meta` and `outcome: 'unknown'`.
   */
  async #calendarWrite<T>(
    caller: Caller,
    meta: Record<string, unknown>,
    fn: (writer: CalendarWriter) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.withWriteSession(caller, ({ writer }) => fn(writer));
    } catch (error) {
      if (outcomeUnknown(error)) await this.recordWrite(caller, { ...meta, outcome: 'unknown' });
      throw calendarFailure(error, true);
    }
  }

  /** Its own live links to events TodoList pushed (CalendarLink.isOwnLive). */
  async #ownLiveLinks(): Promise<CalendarLinkData[]> {
    const links = await (await getCalendarLinkRepository()).listLive(this.workspaceId, this.id);
    return links.filter((link) => CalendarLink.isOwnLive(link));
  }

  /**
   * One of this integration's own live links: claimed (tombstoned) first, then its event deleted
   * and audited (EventClaim), its claim settled. 404 when the claim fails: the event is no longer
   * this integration's (another integration adopted it, or it moved). A delete Google refuses takes
   * its claim back; one that got no answer is resolved by a read of the event (made: done; not
   * made: taken back; unknown: kept) and answered as before (502, audited `outcome: 'unknown'`).
   */
  async #deleteLink(caller: Caller, link: CalendarLinkData): Promise<void> {
    const calendarId = checkedId('calendarId', link.calendarId, 'link');
    const eventId = checkedId('eventId', link.googleEventId, 'link');
    this.assertWritable(caller);
    const claim = await EventClaim.take(link);
    if (claim === null) throw new NotFoundError();
    const meta = { operation: 'event.delete', itemId: link.itemId };
    let lost: { error: unknown; reading: DeleteReading } | null;
    try {
      // On no answer, the event is read once in the same session (its own token).
      lost = await this.withWriteSession(caller, async ({ writer }) => {
        try {
          await writer.remove(calendarId, eventId);
          return null;
        } catch (error) {
          if (!outcomeUnknown(error)) throw error;
          return { error, reading: await readingOf(() => writer.get(calendarId, eventId)) };
        }
      });
    } catch (error) {
      // Not made (refused, a 4xx), or nothing sent: the claim goes back.
      await this.#releaseQuietly(claim);
      throw calendarFailure(error, true);
    }
    if (lost !== null && lost.reading !== 'made') {
      // Kept for the sweep: it may still land.
      await this.recordWrite(caller, { ...meta, outcome: 'unknown' });
      throw calendarFailure(lost.error, true);
    }
    // Made: audited first, then settled (a settle that fails leaves it for the sweep).
    await this.recordWrite(caller, meta);
    await claim.settle();
  }

  /**
   * The push's delete ops (a delete, or a move's first half), each claimed on its own live link
   * (EventClaim) before anything is sent: by op id. An op whose link is no longer this
   * integration's own and live on that calendar and event is left out.
   */
  async #claimDeletes(ops: readonly WireOp[], claims: Map<string, EventClaim>): Promise<void> {
    const links = await getCalendarLinkRepository();
    for (const op of ops) {
      const parsed = op.type === 'delete' ? parseOpId(op.opId) : null;
      if (parsed === null) continue;
      const link = await links.findByItem(this.workspaceId, this.id, parsed.itemId);
      if (
        link === null ||
        !CalendarLink.isOwnLive(link) ||
        link.calendarId !== op.calendarId ||
        link.googleEventId !== op.eventId
      ) {
        continue;
      }
      const claim = await EventClaim.take(link);
      if (claim !== null) claims.set(op.opId, claim);
    }
  }

  /**
   * Inside the write session, right after the ops: each claimed delete Google gave no answer to
   * (`no_answer`) is read once with the session's own token, while a call still fits the budget
   * (no time: unknown). By op id.
   */
  async #readLost(
    writer: CalendarWriter,
    results: readonly OpResult[],
    claims: ReadonlyMap<string, EventClaim>,
    budget: TimeBudget,
  ): Promise<Map<string, DeleteReading>> {
    const readings = new Map<string, DeleteReading>();
    for (const result of results) {
      const claim = claims.get(result.opId);
      if (claim === undefined || result.code !== 'no_answer') continue;
      readings.set(
        result.opId,
        budget.canStart()
          ? await readingOf(() => writer.get(claim.calendarId, claim.googleEventId))
          : 'unknown',
      );
    }
    return readings;
  }

  /**
   * The push's claimed deletes, after the ops: a DELETE Google answered settles its claim; one
   * that got no answer is settled when its read showed it made (and its op then counts as done),
   * and kept otherwise (a live reading may come before a slow DELETE lands: the sweep releases it
   * once STUCK_CLAIM_MS old); any other (deferred, refused, a conflict) takes its claim back.
   */
  async #settleDeletes(
    results: readonly OpResult[],
    claims: ReadonlyMap<string, EventClaim>,
    readings: ReadonlyMap<string, DeleteReading>,
  ): Promise<OpResult[]> {
    const settled: OpResult[] = [];
    for (const result of results) {
      const claim = claims.get(result.opId);
      if (claim === undefined) {
        settled.push(result);
      } else if (result.ok) {
        await claim.settle();
        settled.push(result);
      } else if (result.code === 'no_answer') {
        const reading = readings.get(result.opId) ?? 'unknown';
        const outcome = await claim.resolve(() => Promise.resolve(reading));
        settled.push(outcome === 'settled' ? { opId: result.opId, ok: true } : result);
      } else {
        await this.#releaseQuietly(claim);
        settled.push(result);
      }
    }
    return settled;
  }

  /**
   * This integration's claims left unanswered for STUCK_CLAIM_MS (a process that died between the
   * claim and the answer, a lost answer), the oldest first: each read once in one read session
   * (one grant exchange), while a call still fits `budget`; gone settles, live releases (its call
   * is long over), a failed read keeps. Reading is no provider write: any session of the
   * integration may do it. Never fails its caller.
   */
  async #reconcileClaims(budget: TimeBudget): Promise<void> {
    try {
      const stuck = await EventClaim.stuck(this);
      if (stuck.length === 0 || !budget.canStart()) return;
      await this.#withGrant(async (auth) => {
        const reader = calendarReader(auth);
        await EventClaim.reconcile(
          stuck,
          (link) =>
            readingOf(() =>
              reader.get(
                checkedId('calendarId', link.calendarId, 'link'),
                checkedId('eventId', link.googleEventId, 'link'),
              ),
            ),
          () => budget.canStart(),
        );
      });
    } catch (error) {
      logger.warn('Stuck calendar claims could not be reconciled', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /** The same sweep inside a write session, reading with its writer's own token. */
  async #reconcileWith(writer: CalendarWriter, budget: TimeBudget): Promise<void> {
    try {
      const stuck = await EventClaim.stuck(this);
      await EventClaim.reconcile(
        stuck,
        (link) => readingOf(() => writer.get(link.calendarId, link.googleEventId)),
        () => budget.canStart(),
      );
    } catch (error) {
      logger.warn('Stuck calendar claims could not be reconciled', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /** A claim taken back; a failure there is logged, never thrown over the call's own outcome. */
  async #releaseQuietly(claim: EventClaim | undefined): Promise<void> {
    try {
      await claim?.release();
    } catch (error) {
      logger.warn('A calendar claim could not be taken back', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /**
   * One clean-up run for `caller`, in one write session (one grant exchange), audited as
   * `integration.cleanup` (counts), complete or not. The current workspace calendar is protected,
   * except for this integration's own disconnect when that calendar is this integration's.
   */
  async #cleanUp(
    caller: Caller,
    kind: 'added' | 'pushed',
    budget: TimeBudget,
  ): Promise<CleanupProgress> {
    const primary = await this.#currentPrimary();
    const exempt = kind === 'added' && primary?.isOn(this.id) === true;
    const protectedId = exempt ? null : (primary?.calendarId ?? null);
    let ownItems: Promise<ReadonlySet<string>> | null = null;
    try {
      const done = await this.withWriteSession(caller, async ({ writer }) => {
        // A claim left unanswered is reconciled first: a live event is this clean-up's again.
        await this.#reconcileWith(writer, budget);
        const subject: CleanupSubject = {
          ownLiveLinks: () => this.#ownLiveLinks(),
          isProtected: (calendarId) => calendarId === protectedId,
          deleteLink: async (link): Promise<StepOutcome> => {
            // Re-read before each delete: the primary calendar may have been switched meanwhile,
            // and a push may have moved or dropped the link.
            const links = await getCalendarLinkRepository();
            const [now, fresh] = await Promise.all([
              this.#currentPrimary(),
              links.findByItem(this.workspaceId, this.id, link.itemId),
            ]);
            const guarded =
              kind === 'added' && now?.isOn(this.id) === true ? null : (now?.calendarId ?? null);
            if (
              fresh === null ||
              !CalendarLink.isOwnLive(fresh) ||
              fresh.calendarId !== link.calendarId ||
              fresh.calendarId === guarded
            ) {
              return 'skipped';
            }
            // Claim before delete (EventClaim): tombstoned first, only while it is still live on
            // that calendar (N2: a move meanwhile keeps it live); no claim, nothing is sent.
            const claim = await EventClaim.take(fresh);
            if (claim === null) return 'skipped';
            return this.#refusable(
              caller,
              { operation: 'event.delete', itemId: fresh.itemId },
              async () => {
                await writer.remove(
                  checkedId('calendarId', fresh.calendarId, 'link'),
                  checkedId('eventId', fresh.googleEventId, 'link'),
                );
              },
              claim,
              () =>
                budget.canStart()
                  ? readingOf(() => writer.get(fresh.calendarId, fresh.googleEventId))
                  : Promise.resolve('unknown'),
            );
          },
          createdCalendars: () => this.#createdCalendars.ids,
          contentsOf: (calendarId): Promise<CalendarContents> => {
            if (calendarId === protectedId) return Promise.resolve('others');
            ownItems ??= this.#linkedItemIds();
            return this.#contentsOf(calendarId, ownItems, budget);
          },
          deleteCalendar: (calendarId) =>
            this.#refusable(caller, { operation: 'calendar.delete' }, async () => {
              await writer.removeCalendar(calendarId);
            }),
          forgetCalendar: (calendarId) => this.#forgetCalendar(calendarId),
          removeLinks: async (): Promise<void> => {
            // Its claims that may still stand for another integration's push stay (answered or
            // claimed in the last STUCK_CLAIM_MS): that push must still see TodoList's delete.
            await (
              await getCalendarLinkRepository()
            ).removeForIntegration(
              this.workspaceId,
              this.id,
              new Date(Date.now() - STUCK_CLAIM_MS),
            );
          },
        };
        const cleanup =
          kind === 'added'
            ? new AddedContentRemoval(subject, budget)
            : new PushedEventsRemoval(subject, budget);
        return await cleanup.run();
      });
      await AuditLog.record(caller, Integration.Audit.cleanup, this, { ...done });
      return done;
    } catch (error) {
      if (error instanceof CleanupIncompleteError) {
        await AuditLog.record(caller, Integration.Audit.cleanup, this, { ...error.progress });
        throw error;
      }
      throw calendarFailure(error);
    }
  }

  /**
   * One clean-up step at Google, audited as `integration.write` with `meta` when it was done or
   * refused for good (refusedForGood: a rejected request, a permission 403), recorded then as
   * `outcome: 'refused'` so the next call moves on; either way its claim (an event's delete was
   * claimed before it ran) is then settled, after the audit. No answer (a timeout, a 5xx): the
   * event is read once (`read`, within the budget): made, the step is done; otherwise the claim is
   * kept for the sweep, recorded as `outcome: 'unknown'`, and the call stops. Anything else (a
   * 401, a 429, a 403 without a permission reason) takes the claim back and stops the call: the
   * next call retries.
   */
  async #refusable(
    caller: Caller,
    meta: Record<string, unknown>,
    step: () => Promise<void>,
    claim?: EventClaim,
    read?: () => Promise<DeleteReading>,
  ): Promise<StepOutcome> {
    try {
      await step();
    } catch (error) {
      if (refusedForGood(error)) {
        await this.recordWrite(caller, { ...meta, outcome: 'refused' });
        await claim?.settle();
        return 'refused';
      }
      if (outcomeUnknown(error)) {
        if (claim !== undefined && read !== undefined) {
          if ((await claim.resolve(read)) === 'settled') {
            await this.recordWrite(caller, meta);
            return 'done';
          }
        }
        await this.recordWrite(caller, { ...meta, outcome: 'unknown' });
        throw error;
      }
      await this.#releaseQuietly(claim);
      throw error;
    }
    await this.recordWrite(caller, meta);
    await claim?.settle();
    return 'done';
  }

  /** The workspace's primary calendar as stored now (null: none). */
  async #currentPrimary(): Promise<PrimaryCalendar | null> {
    const workspace = await (await getWorkspaceRepository()).findById(this.workspaceId);
    return workspace === null ? null : WorkspaceSettings.from(workspace.settings).primaryCalendar;
  }

  /** The current workspace calendar's id (null: none). */
  async #currentPrimaryCalendarId(): Promise<string | null> {
    return (await this.#currentPrimary())?.calendarId ?? null;
  }

  /** The items this integration has a link for, live or tombstoned: what it pushed. */
  async #linkedItemIds(): Promise<ReadonlySet<string>> {
    const links = await getCalendarLinkRepository();
    const [live, stones] = await Promise.all([
      links.listLive(this.workspaceId, this.id),
      links.listTombstonedSince(this.workspaceId, this.id, new Date(0)),
    ]);
    return new Set([...live, ...stones].map((link) => link.itemId));
  }

  /**
   * What a calendar TodoList created holds (a read: events.list): `only_ours` when every event
   * that is not deleted is this integration's own push: marked `origin: todolist` for THIS
   * workspace, with the event id TodoList gives its item, and an item this integration has a link
   * for (live or tombstoned). Anything else (the user's own event, another workspace's or another
   * integration's push, more than the pages read) is `others`: the calendar is kept. `gone` when
   * Google no longer has it.
   */
  async #contentsOf(
    calendarId: string,
    ownItems: Promise<ReadonlySet<string>>,
    budget: TimeBudget,
  ): Promise<CalendarContents> {
    const linked = await ownItems;
    const isOwn = (raw: Record<string, unknown>): boolean => {
      const ext = raw['extendedProperties'] as { private?: Record<string, unknown> } | undefined;
      const priv = ext?.private;
      const itemId = priv?.['todolistItemId'];
      return (
        priv?.['origin'] === ORIGIN &&
        priv['todolistWs'] === this.workspaceId &&
        typeof itemId === 'string' &&
        raw['id'] === eventIdFor(itemId) &&
        linked.has(itemId)
      );
    };
    try {
      return await this.#withGrant(async (auth) => {
        const reader = calendarReader(auth);
        let pageToken: string | null = null;
        for (let page = 0; page < MAX_FOREIGN_PAGES; page += 1) {
          // Another page only while a call can still end in the budget; else the next call reads.
          if (page > 0 && !budget.canStart()) return 'later';
          const result = await reader.list(calendarId, { timeMin: ALL_EVENTS_FROM }, pageToken);
          if (result.items.some((raw) => raw['status'] !== 'cancelled' && !isOwn(raw))) {
            return 'others';
          }
          if (result.nextPageToken === null) return 'only_ours';
          pageToken = result.nextPageToken;
        }
        return 'others';
      });
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) return 'gone';
      throw calendarFailure(error);
    }
  }

  /**
   * A calendar Google just created for TodoList: read by this integration from now on, and
   * recorded as TodoList's own (AppCreatedCalendars#with, written straight to the stored settings:
   * never a settings change its owner could make).
   */
  async #recordCreated(calendarId: string): Promise<void> {
    const calendars = this.config.calendars.map((calendar) => ({ ...calendar }));
    if (!calendars.some((calendar) => calendar.id === calendarId)) {
      calendars.push({ id: calendarId, mode: 'read' });
    }
    await this.#storeCalendars(calendars, this.#createdCalendars.with(calendarId));
  }

  /** A calendar TodoList created was deleted (or is gone): no longer read, no longer recorded. */
  async #forgetCalendar(calendarId: string): Promise<void> {
    const stored = await (await getIntegrationRepository()).findById(this.workspaceId, this.id);
    const config = (stored?.config ?? this.config) as Readonly<Record<string, unknown>>;
    const calendars = (Array.isArray(config['calendars']) ? (config['calendars'] as unknown[]) : [])
      .filter((calendar) => (calendar as { id?: unknown } | null)?.id !== calendarId)
      .map((calendar) => ({ ...(calendar as { id: string; mode: 'two_way' | 'read' }) }));
    await this.#storeCalendars(
      calendars,
      AppCreatedCalendars.of(config).without(calendarId),
      config,
    );
  }

  /**
   * Its owner makes sure it reads `calendarId`, the workspace's primary calendar: that calendar is
   * always one the integration reads (any mode; `two_way` counts), so its next sync keeps that
   * calendar's events instead of sweeping them as an unread calendar's, and the owner is told so
   * when picking it. Added in read mode when missing (no Google call); audited as
   * `integration.update` (`reason: primary_calendar_read`). Called when the owner sets the
   * primary calendar and when a recurring to-do is created in it (which only restores the
   * invariant). Whether it was added.
   */
  async ensureReads(caller: Caller, calendarId: string): Promise<boolean> {
    this.assertOwner(caller);
    const calendars = this.config.calendars;
    if (calendars.some((calendar) => readsCalendar(calendar, calendarId))) return false;
    if (calendars.length >= MAX_READ_CALENDARS) throw new ValidationError(TOO_MANY_READS);
    await this.#storeCalendars(
      [...calendars, { id: calendarId, mode: 'read' }],
      AppCreatedCalendars.of(this.config),
    );
    await AuditLog.record(caller, Integration.Audit.update, this, {
      changed: ['config'],
      reason: 'primary_calendar_read',
    });
    return true;
  }

  /** One event as Google has it now, through the read session (null: gone). */
  async readEvent(
    caller: Caller,
    calendarId: string,
    eventId: string,
  ): Promise<Record<string, unknown> | null> {
    this.assertOwner(caller);
    return this.#withGrant((auth) => calendarReader(auth).get(calendarId, eventId));
  }

  /** The read calendars and the record of TodoList's own, written to the stored settings. */
  async #storeCalendars(
    calendars: GoogleCalendarConfig['calendars'],
    created: AppCreatedCalendars,
    base: Readonly<Record<string, unknown>> = this.config,
  ): Promise<void> {
    const config = created.keptIn({ ...base, calendars });
    await (await getIntegrationRepository()).update(this.workspaceId, this.id, { config });
  }

  /**
   * This integration's live event item `id`, on a calendar it reads, with where it is at Google
   * (from the item's own calendar and event ids, which must agree with its natural key): 404 for
   * anything else. The ids pass their patterns too (400), a second line of defence.
   */
  async #ownEvent(id: string): Promise<OwnEvent> {
    const stored = await (await getItemRepository()).findById(this.workspaceId, id);
    if (
      stored?.integrationId !== this.id ||
      stored.kind !== 'event' ||
      stored.source.provider !== 'google_calendar'
    ) {
      throw new NotFoundError();
    }
    const calendarId = asString(stored.props['calendarId']);
    const eventId = asString(stored.props['eventId']);
    if (
      calendarId === null ||
      eventId === null ||
      calendarEventExternalId(calendarId, eventId) !== stored.source.externalId ||
      !this.config.calendars.some((calendar) => calendar.id === calendarId)
    ) {
      throw new NotFoundError();
    }
    return {
      stored,
      calendarId: checkedId('calendarId', calendarId, 'item'),
      eventId: checkedId('eventId', eventId, 'item'),
    };
  }

  /**
   * Google's `sendUpdates` for a change to this event: as the caller said; for an event with
   * other guests the caller must say (EventHasGuestsError otherwise); none otherwise.
   */
  static #guestUpdates(stored: ItemData, notice: GuestNotice): GuestUpdates | undefined {
    if (notice.notifyGuests !== undefined) return notice.notifyGuests ? 'all' : 'none';
    if (hasGuests(stored)) throw new EventHasGuestsError();
    return undefined;
  }

  /**
   * The event's item takes the event as Google answered it; its source hash is cleared, so the
   * next sync rewrites it whatever it holds.
   */
  async #refreshItem(
    event: OwnEvent,
    record: Record<string, unknown>,
    timeZone: string,
  ): Promise<void> {
    let mapped: ReturnType<typeof mapCalendarEvent> | null;
    try {
      mapped = mapCalendarEvent(record, {
        calendarId: event.calendarId,
        accountId: this.accountId,
        timeZone,
      });
    } catch {
      mapped = null;
    }
    const fields =
      mapped === null || 'deleted' in mapped
        ? {}
        : {
            title: mapped.title,
            status: mapped.status,
            statusRaw: mapped.statusRaw ?? null,
            startAt: mapped.startAt ?? null,
            endAt: mapped.endAt ?? null,
            allDay: mapped.allDay ?? false,
            closedAt: mapped.closedAt ?? null,
          };
    await (
      await getItemRepository()
    ).updateMirrored(this.workspaceId, this.id, event.stored.id, fields, { resync: true });
  }

  /** The event with its one recurrence line (400 for anything RecurrenceRule doesn't take). */
  static #withRecurrence(
    event: PlainEventBody,
    recurrence: readonly string[] | undefined,
  ): RecurringEventBody {
    if (recurrence === undefined) return event;
    const rule = RecurrenceRule.fromLines(recurrence);
    if (!rule.fits(event.start.date !== undefined)) {
      throw new ValidationError(
        'recurrence: UNTIL must be a date for an all-day event, a UTC time for a timed one',
      );
    }
    return { ...event, recurrence: [rule.toString()] };
  }

  /**
   * Runs `fn` with the grant's auth headers (its strategy trades the refresh token for a fresh
   * access token) and the app's client, inside a read session.
   */
  async #withGrant<T>(
    fn: (auth: Readonly<Record<string, string>>, client: ReadOnlyClient) => Promise<T>,
  ): Promise<T> {
    return this.withReadSession(async ({ secret }) => {
      const client = this.oauth.client();
      return fn(await this.oauth.bind({ secret, client, now: new Date() }).headers(), client);
    });
  }

  /**
   * The pull for the primary calendar the push went to, with its own grant, within the request's
   * budget (a page only while a call can still end in it; a cut listing is partial, so its token
   * is not saved); nothing when it fails or no time is left.
   */
  async #pullAfterPush(target: string, now: Date, budget: TimeBudget): Promise<PulledCalendar[]> {
    if (!budget.canStart()) return [];
    try {
      const cursor = await Calendar.of(this.toJSON(), target).cursor();
      const timeMin = new Date(
        now.getTime() - PAST_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const calendars = [{ id: target, syncToken: cursor.syncToken }];
      return await this.#withGrant(async (auth) => {
        const reader = calendarReader(auth);
        const results: PulledCalendar[] = [];
        for (const cal of calendars) {
          results.push(await pullOwnEvents(reader, cal.id, cal.syncToken, timeMin, budget));
        }
        return results;
      });
    } catch (error) {
      logger.warn('A Google Calendar pull failed', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }
}
