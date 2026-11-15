/**
 * Google Calendar connected with Google OAuth (`{refreshToken, scope}`; every call trades the
 * refresh token for an access token kept in memory for that call only), or read through a
 * service account (the demo's fixtures).
 *
 * - the calendar picker: calendarList, as `{id, summary, primary, accessRole}`;
 * - an event created from a to-do (insertEvent, a recurring one with one strictly parsed RRULE
 *   line); a pulled event's edit (updateEvent) or delete (deleteEvent), by its item of this
 *   integration on a calendar it reads, an event with other guests only when the caller says
 *   whether to notify them; a pushed event's delete by its CalendarLink (deleteLinkedEvent); a
 *   calendar of TodoList's own (createCalendar, which needs the `calendar.app.created` scope);
 *   and the push: the diff's ops
 *   applied through the Calendar API (writers/calendarOps.ts); all only inside the write session,
 *   so a read-only integration never writes; a dry run writes nothing and is always allowed;
 * - the pull after a push: Google-side edits and deletes of what was pushed;
 * - disconnect: the grant is revoked at Google, unless another live integration (in any
 *   workspace) uses the same Google account, since revoking ends the grant for all of them.
 */
import { z } from 'zod';

import type { Caller } from '../../base/Caller.js';
import { AppError } from '../../../errors/AppError.js';
import { EventHasGuestsError } from '../../../errors/EventHasGuestsError.js';
import { NotFoundError } from '../../../errors/NotFoundError.js';
import { ProviderItemMissingError } from '../../../errors/ProviderItemMissingError.js';
import { ScopeMissingError } from '../../../errors/ScopeMissingError.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import { applyCommit } from '../../../gcal/commit.js';
import { ORIGIN, PAST_WINDOW_DAYS } from '../../../gcal/diff.js';
import { loadPlan, readGcalConfig, type PlanNarrowing } from '../../../gcal/plan.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ItemData } from '../../../models/definitions/Item.js';
import {
  getCalendarLinkRepository,
  getIntegrationRepository,
  getItemRepository,
  getSyncRunRepository,
  getSyncStateRepository,
} from '../../../models/index.js';
import { logger } from '../../../services/logger.js';
import { checkedId } from '../../../services/providerCreate/ids.js';
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
import { EventEdit } from '../EventEdit.js';
import { Integration } from '../Integration.js';
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
export const PUSH_BUDGET_MS = 20_000;

const MAX_CALENDAR_PAGES = 10;
const MAX_PULL_PAGES = 10;
const ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'writer', 'reader', 'freeBusyReader']);

/** One calendar's pulled changes, in the shape the commit reads (gcal/commit.ts CalendarResult). */
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

const RECONNECT = 'Google refused the connection: reconnect Google Calendar';

/** A calendar's name as TodoList creates it: one line of text. */
const CalendarName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !Array.from(name).some((char) => (char.codePointAt(0) ?? 0) < 32), {
    message: 'Must be one line of text',
  });

/**
 * Whether a pulled event has guests beyond the calendar's owner: its `guestsCount`, or (an item
 * pulled before that was kept) two or more attendees.
 */
function hasGuests(item: ItemData): boolean {
  const { guestsCount, attendeesCount } = item.props;
  if (typeof guestsCount === 'number') return guestsCount > 0;
  return typeof attendeesCount === 'number' && attendeesCount >= 2;
}

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
function calendarFailure(error: unknown): Error {
  if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
    return new AppError(409, RECONNECT);
  }
  if (!(error instanceof CalendarApiError)) {
    return error instanceof Error ? error : new Error('A Google Calendar write failed');
  }
  const { status } = error;
  if (status === null || status >= 500) {
    return new AppError(502, 'Google Calendar did not answer. Try again in a moment.');
  }
  if (status === 401) return new AppError(409, RECONNECT);
  if (status === 403) return new AppError(409, 'Google refused this change for this account');
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

export class GoogleCalendarIntegration
  extends Integration<GoogleCalendarConfig, GoogleCalendarSecret, CalendarWriter>
  implements
    CalendarProvider,
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
   * it already read keeps its mode, a new one is read only; the push target stays only if chosen.
   */
  async choose(caller: Caller, ids: readonly string[]): Promise<Integration> {
    const calendars = new Set((await this.pickerResources(caller)).map((entry) => entry.id));
    if (ids.some((id) => !calendars.has(id))) {
      throw new AppError(400, 'config.calendars: not a calendar of this connection');
    }
    const { targetCalendarId, calendars: current, ...rest } = this.config;
    const modes = new Map(current.map((calendar) => [calendar.id, calendar.mode]));
    return this.update(caller, {
      config: {
        ...rest,
        calendars: ids.map((id) => ({ id, mode: modes.get(id) ?? 'read' })),
        ...(targetCalendarId !== undefined && ids.includes(targetCalendarId)
          ? { targetCalendarId }
          : {}),
      },
    });
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
      const written = await this.withWriteSession(caller, async ({ writer }) => {
        try {
          return await writer.insert(calendarId, body);
        } catch (error) {
          if (statusOf(error) !== 409) throw error;
          return { id: event.id, etag: undefined, updated: undefined };
        }
      });
      const eid = Buffer.from(`${written.id} ${calendarId}`).toString('base64url');
      return {
        kind: 'created',
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
    const updated = await this.#calendarWrite(caller, (writer) =>
      writer.update(event.calendarId, event.eventId, edit.changes, sendUpdates),
    );
    await this.recordWrite(caller, {
      operation: 'event.update',
      itemId: event.stored.id,
      fields: [...edit.fields],
    });
    await this.#refreshItem(event, updated.record, timeZone);
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
    await this.#calendarWrite(caller, (writer) =>
      writer.remove(event.calendarId, event.eventId, sendUpdates),
    );
    await this.recordWrite(caller, { operation: 'event.delete', itemId: event.stored.id });
    await (
      await getItemRepository()
    ).softDeleteBySource(this.workspaceId, this.#account, [event.stored.source.externalId]);
  }

  /**
   * An event TodoList pushed, deleted by its CalendarLink: this integration's live link for the
   * item, in this workspace, on the push target (404 otherwise). A pushed event has no guests.
   * Audited as `integration.write` (`event.delete`) right after Google takes it; then the link is
   * tombstoned (deleted from TodoList's side), so no push makes it again.
   */
  async deleteLinkedEvent(caller: Caller, link: LinkedItemRef): Promise<void> {
    this.assertOwner(caller);
    const links = await getCalendarLinkRepository();
    const found = await links.findByItem(this.workspaceId, this.id, link.itemId);
    const target = this.config.targetCalendarId;
    if (found?.tombstonedAt !== null || found.calendarId !== target) throw new NotFoundError();
    const calendarId = checkedId('calendarId', found.calendarId, 'link');
    const eventId = checkedId('eventId', found.googleEventId, 'link');
    this.assertWritable(caller);
    await this.#calendarWrite(caller, (writer) => writer.remove(calendarId, eventId));
    await this.recordWrite(caller, { operation: 'event.delete', itemId: link.itemId });
    await links.tombstone(this.workspaceId, found.id, 'dashboard');
  }

  /**
   * Its owner creates a calendar of TodoList's own, named `name` (one line, 1–255 characters), in
   * the workspace's zone (Google's `calendars.insert`). The grant must carry
   * `calendar.app.created`: one from before TodoList asked for it is 409 `scope_missing` (its
   * owner connects again), checked before anything is opened or sent. The new calendar is not
   * read until its owner picks it. Audited as `integration.write` (`calendar.create`).
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
    const created = await this.#calendarWrite(caller, (writer) =>
      writer.insertCalendar(summary, caller.settings.timezone),
    );
    await this.recordWrite(caller, { operation: 'calendar.create' });
    return {
      id: created.id,
      summary: created.summary ?? summary,
      primary: false,
      accessRole: 'owner',
    };
  }

  /** Its owner: what a push would create, update and remove now. Nothing is written. */
  async dryRun(
    caller: Caller,
    narrowing?: PlanNarrowing,
    now: Date = new Date(),
  ): Promise<CalendarDryRun> {
    this.assertOwner(caller);
    const plan = await loadPlan(this.toJSON(), now, narrowing);
    return { dryRun: true, counts: plan.counts, entries: plan.entries, skipped: plan.skipped };
  }

  /**
   * A push, start to commit: a `SyncRuns` row (trigger `calendar_push`), the ops through the
   * Calendar API inside the write session, the pull that follows, then the commit (gcal/commit.ts:
   * links, audit, the run's counts). A read-only integration is refused first (assertWritable),
   * before any run is recorded; the mode is the one this integration was loaded with, so a switch
   * made while the push runs is seen by the next one. Ops left when PUSH_BUDGET_MS runs out wait
   * for the next run. Returns the run's id. 409 to reconnect, 502 when Google is silent (or the
   * credential can't be opened).
   */
  async push(caller: Caller, { ops, now }: CalendarPushRequest): Promise<string> {
    this.assertWritable(caller);
    const { workspaceId } = this;
    const runs = await getSyncRunRepository();
    const run = await runs.create(workspaceId, {
      integrationId: this.id,
      trigger: 'calendar_push',
      status: 'running',
      startedAt: now,
    });
    let opResults: OpResult[];
    try {
      const deadline = Date.now() + PUSH_BUDGET_MS;
      opResults = await this.withWriteSession(caller, ({ writer }) =>
        applyOps(writer, ops, deadline),
      );
    } catch (error) {
      const authFailed = error instanceof ProviderHttpError && error.code === 'auth_failed';
      await runs.updateIfStatus(workspaceId, run.id, ['running'], {
        status: 'failed',
        finishedAt: new Date(),
        error: authFailed
          ? { code: 'auth_failed', message: 'Reconnect required' }
          : { code: 'calendar_unreachable', message: 'Google Calendar did not answer' },
      });
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
    // The pull that follows the writes (their etags are the links' by then, so our echoes are
    // skipped): Google-side edits and deletes of what we pushed. A failed pull never fails the
    // push; the token is kept and the next run lists again.
    const calendars = await this.#pullAfterPush(now);
    await applyCommit(this.toJSON(), { runId: run.id, opResults, calendars }, new Date());
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

  /** The Calendar API writer, acting with the strategy's headers (a fresh access token) for this one session. */
  protected async createWriter(secret: GoogleCalendarSecret): Promise<CalendarWriter> {
    const auth = this.oauth.bind({ secret, client: this.oauth.client(), now: new Date() });
    return calendarWriter(await auth.headers('write'));
  }

  protected probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown> {
    return adapter.test(context);
  }

  /** This integration's items' source account (the natural key's first half). */
  get #account(): { provider: 'google_calendar'; accountId: string; integrationId: string } {
    return { provider: 'google_calendar', accountId: this.accountId, integrationId: this.id };
  }

  /** `fn` with the writer, inside the write session; a failure as the caller answers it. */
  async #calendarWrite<T>(caller: Caller, fn: (writer: CalendarWriter) => Promise<T>): Promise<T> {
    try {
      return await this.withWriteSession(caller, ({ writer }) => fn(writer));
    } catch (error) {
      throw calendarFailure(error);
    }
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

  /** The pull for the push target, with its own grant; nothing when it fails. */
  async #pullAfterPush(now: Date): Promise<PulledCalendar[]> {
    const target = readGcalConfig(this.toJSON()).targetCalendarId;
    if (target === null) return [];
    try {
      const state = await (
        await getSyncStateRepository()
      ).get(this.workspaceId, this.id, `gcal:${target}`);
      const timeMin = new Date(
        now.getTime() - PAST_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const calendars = [{ id: target, syncToken: state?.syncToken ?? null }];
      return await this.#withGrant(async (auth) => {
        const reader = calendarReader(auth);
        const results: PulledCalendar[] = [];
        for (const cal of calendars) {
          results.push(await pullOwnEvents(reader, cal.id, cal.syncToken, timeMin));
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
