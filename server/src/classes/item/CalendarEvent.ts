/**
 * A Google Calendar event mirrored by its integration (Schedulable, Recurring): the calendar,
 * clock, agenda and timeline blocks read its time range, a series' master holds its rule, and the
 * workspace calendar's push leaves it alone.
 *
 * - Its provider half goes to CalendarProvider#updateEvent, by its item (never a raw calendar or
 *   event id): its title and its time, given whole (a new start keeps the duration unless an end
 *   is given; `allDay` stays as the event is unless given). An event with other guests needs
 *   `notifyGuests` (409 `event_has_guests` otherwise).
 * - `createRecurring` (plan Addendum A3) makes a recurring to-do: a recurring event in the
 *   workspace's primary calendar only, created by that calendar integration's owner while it is
 *   read & write, then stored at once as this item.
 */
import { randomUUID } from 'node:crypto';

import type { Caller } from '../base/Caller.js';
import type { EventPatch } from '../integration/capabilities.js';
import {
  Integration,
  isCalendarProvider,
  type CalendarProvider,
  type PlainEventBody,
  type WriteResult,
} from '../integration/index.js';
import { RecurrenceRule } from '../integration/RecurrenceRule.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { Topic } from '../workspace/Topic.js';
import { WorkspaceSettings } from '../workspace/WorkspaceSettings.js';
import { AppError } from '../../errors/AppError.js';
import { CreatedNotStoredError } from '../../errors/CreatedNotStoredError.js';
import { IntegrationNotOwnerError } from '../../errors/IntegrationNotOwnerError.js';
import { NotAnOccurrenceError } from '../../errors/NotAnOccurrenceError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { PrimaryCalendarUnsetError } from '../../errors/PrimaryCalendarUnsetError.js';
import { ProviderItemMissingError } from '../../errors/ProviderItemMissingError.js';
import { ProviderNoAnswerError } from '../../errors/ProviderNoAnswerError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { GoogleSeriesRef, ItemData } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import { calendarEventExternalId, mapCalendarEvent } from '../../sync/providers/google_calendar.js';
import type { MappedItem } from '../../sync/types.js';
import { isSeriesRow, seriesHasSlot, toDate } from '../../types/recurrence/occurrences.js';
import type { Recurring, Schedulable } from './contracts.js';
import { CreateQuota } from './CreateQuota.js';
import { DisabledState, SERIES_DISABLED_MESSAGE, type DisableChange } from './Disabled.js';
import { eventHasGuests } from './guests.js';
import { Item, type DisableWrite } from './Item.js';
import type { ProviderHalf } from './ItemEdit.js';
import { MirroredItem } from './MirroredItem.js';
import { auditProviderCreate } from './providerCreates.js';
import { TimeRange } from './TimeRange.js';
import { eventIdFor, todoEvent } from './todoEvent.js';

/** A recurring to-do, as callers give it (dates already Dates). */
export interface NewRecurringTodo {
  title: string;
  note?: string | undefined;
  /** When the first occurrence is: required. */
  dueAt?: Date | null | undefined;
  allDay?: boolean | undefined;
  /** One `RRULE:` line (RecurrenceRule: 400 for anything else). */
  recurrence: readonly string[];
  /** A topic of the workspace to file it under (its overlay: the sync keeps the event's own). */
  topicId?: string | null | undefined;
  /** Kept as an override (Google has no priority). */
  priority?: number | null | undefined;
  idempotencyKey?: string | undefined;
}

type MutableHalf = { -readonly [K in keyof ProviderHalf]: ProviderHalf[K] };

/** A refused or unanswered create, as the caller's error. */
function createFailure(result: Exclude<WriteResult, { kind: 'created' }>): AppError {
  const provider = 'google_calendar';
  if (result.kind === 'unknown') return new ProviderNoAnswerError(provider);
  switch (result.reason) {
    case 'auth':
      return new AppError(409, `${provider} refused the connection: reconnect it`, {
        code: 'provider_refused',
      });
    case 'forbidden':
      return new AppError(409, `${provider} refused this change: the connection may not make it`, {
        code: 'provider_refused',
      });
    case 'rate_limited':
      return new AppError(429, `${provider} is busy. Try again in a moment.`);
    default:
      return new AppError(422, `${provider} rejected this change`);
  }
}

export class CalendarEvent extends MirroredItem implements Schedulable, Recurring {
  static {
    Item.register('event', (data) => new CalendarEvent(data));
  }

  private constructor(data: ItemData) {
    super(data);
  }

  /** When it happens (null: no start). */
  get timeRange(): TimeRange | null {
    return TimeRange.from(this.data.startAt, this.data.endAt, this.data.allDay);
  }

  /** Its series' rule lines (a recurring event's master), or null. */
  get recurrence(): readonly string[] | null {
    const lines = this.data.props['recurrence'];
    return Array.isArray(lines)
      ? (lines as unknown[]).filter((line): line is string => typeof line === 'string')
      : null;
  }

  /** A series' master: an RRULE line in its recurrence. */
  get isRecurring(): boolean {
    return isSeriesRow({ props: this.data.props });
  }

  /** Its series' rule lines; empty for a single event or one occurrence of a series. */
  get recurrenceLines(): readonly string[] {
    return this.recurrence ?? [];
  }

  /**
   * The occurrence of a series this event is, when it is one of Google's exception rows (an
   * occurrence moved or changed on its own: `recurringEventId` and `originalStartAt`), keyed as
   * the shared expansion keys it (types/recurrence/occurrences.ts): by its master's id when the
   * caller sees exactly one master of that series (`master`), else by its own; and by its original
   * start. Null for any other event.
   */
  async seriesOccurrence(caller: Caller): Promise<{
    seriesId: string;
    master: boolean;
    originalStart: Date;
    disabled: 'series' | 'occurrence' | null;
    /**
     * A cancelled occurrence (Google sends its id, series and original start only) is shown as its
     * series: the master's title, topic and link. Null for any other row, or with no master.
     */
    asSeries: { title: string; topicId: string | null; url: string } | null;
  } | null> {
    const { props } = this.data;
    const calendarId = props['calendarId'];
    const seriesEventId = props['recurringEventId'];
    const original = props['originalStartAt'];
    const originalStart = toDate(typeof original === 'string' ? original : null);
    if (
      typeof calendarId !== 'string' ||
      typeof seriesEventId !== 'string' ||
      originalStart === null ||
      Number.isNaN(originalStart.getTime())
    ) {
      return null;
    }
    const policy = await ItemPolicy.for(caller);
    const masters = (
      await (
        await getItemRepository()
      ).aggregate(caller.workspaceId, [
        {
          $match: {
            ...policy.itemFilterUnabsorbed(caller.context),
            'source.provider': this.provider,
            'source.externalId': calendarEventExternalId(calendarId, seriesEventId),
          },
        },
        { $limit: 5 },
      ])
    )
      .map((doc) => Item.fromDoc(doc))
      .filter((item) => item instanceof CalendarEvent && item.isRecurring);
    const [master] = masters;
    if (masters.length !== 1 || master === undefined) {
      return { seriesId: this.id, master: false, originalStart, disabled: null, asSeries: null };
    }
    const state = master.overlay.disabledState;
    const view = master.toSummary();
    return {
      seriesId: master.id,
      master: true,
      originalStart,
      disabled: state.whole ? 'series' : state.listed(originalStart) ? 'occurrence' : null,
      asSeries:
        this.status === 'cancelled'
          ? { title: view.title, topicId: view.topicId, url: view.source.url }
          : null,
    };
  }

  /**
   * The Google series it belongs to, as this integration stores it: its own as a master, its
   * master's as an exception row (`recurringEventId`), with the slot an exception row fills. Null
   * for a single event.
   */
  get #series(): { ref: GoogleSeriesRef; originalStart: Date | null } | null {
    const { props, source } = this.data;
    const calendarId = props['calendarId'];
    const eventId = this.isRecurring ? props['eventId'] : props['recurringEventId'];
    if (typeof calendarId !== 'string' || typeof eventId !== 'string') return null;
    const original = props['originalStartAt'];
    return {
      ref: { integrationId: this.integrationId, accountId: source.accountId, calendarId, eventId },
      originalStart: this.isRecurring
        ? null
        : toDate(typeof original === 'string' ? original : null),
    };
  }

  /**
   * Disabling an event of a Google series (Disabled.ts). `series` marks the master and every
   * exception row of it (moved, cancelled) at once, from either. One occurrence (`occurrence`, or
   * an exception row with no scope) marks the exception row that fills its slot, else the slot in
   * the master's list; enabling it clears both, and is 400 while the master disables the whole
   * series. A single event changes as a whole. Only rows the caller may see are read or written
   * (an agent key narrowed to some topics touches no row outside them). The write answers the item
   * asked about; when one occurrence has its own row, that row took the mark.
   */
  protected override async planDisabled(
    caller: Caller,
    change: DisableChange,
    now: Date,
  ): Promise<DisableWrite> {
    const series = this.#series;
    if (series === null) return super.planDisabled(caller, change, now);
    const scope =
      change.scope ??
      (this.isRecurring && change.occurrenceStart === undefined ? 'series' : 'occurrence');
    const items = await getItemRepository();
    const access = (await ItemPolicy.for(caller)).itemFilterUnabsorbed(caller.context);
    if (scope === 'series') {
      return async () => {
        await items.setSeriesDisabled(this.workspaceId, series.ref, change.disabled, now, access);
        return this.reload();
      };
    }
    let master: CalendarEvent | null = this.isRecurring ? this : null;
    let exception: CalendarEvent | null = this.isRecurring ? null : this;
    let slot = series.originalStart;
    if (this.isRecurring) {
      slot = change.occurrenceStart ?? null;
      if (slot === null) {
        throw new ValidationError('occurrenceStart: one occurrence is named by its original start');
      }
      const row = await items.findSeriesException(
        this.workspaceId,
        series.ref,
        DisabledState.key(slot),
        access,
      );
      const found = row === null ? null : Item.from(row);
      exception = found instanceof CalendarEvent ? found : null;
      if (exception === null && !seriesHasSlot(this.data, slot, caller.settings.timezone)) {
        throw new NotAnOccurrenceError('occurrenceStart: not an occurrence of this series');
      }
    } else {
      master = await this.#ownMaster(series.ref, access);
    }
    const state = master?.overlay.disabledState;
    const whole = state?.whole === true;
    if (whole && !change.disabled) throw new ValidationError(SERIES_DISABLED_MESSAGE);
    if (change.disabled && whole) return () => this.reload();
    if (exception === null && master !== null && slot !== null) {
      master.overlay.disabledState.assertRoomFor(slot, change.disabled);
    }
    const target = { master, exception, slot };
    return async () => {
      const { master: m, exception: e, slot: at } = target;
      if (change.disabled) {
        if (e !== null) await e.storeOverlay({ disabled: true, editedAt: now });
        else if (m !== null && at !== null) await m.storeDisabledOccurrence(at, true, now);
        return this.reload();
      }
      if (e !== null) await e.storeOverlay({ disabled: null, editedAt: now });
      if (m !== null && at !== null && m.overlay.disabledState.listed(at)) {
        await m.storeDisabledOccurrence(at, false, now);
      }
      return this.reload();
    };
  }

  /** This exception row's master in the same integration copy, if the caller may see it. */
  async #ownMaster(
    ref: GoogleSeriesRef,
    access: Readonly<Record<string, unknown>>,
  ): Promise<CalendarEvent | null> {
    const [doc] = await (
      await getItemRepository()
    ).aggregate(this.workspaceId, [
      {
        $match: {
          $and: [
            access,
            {
              'source.provider': this.provider,
              'source.accountId': ref.accountId,
              integrationId: ref.integrationId,
              'source.externalId': calendarEventExternalId(ref.calendarId, ref.eventId),
            },
          ],
        },
      },
      { $limit: 1 },
    ]);
    const found = doc === undefined ? null : Item.fromDoc(doc);
    return found instanceof CalendarEvent ? found : null;
  }

  protected override needsGuestNotice(): boolean {
    return eventHasGuests(this.data.props);
  }

  /** Its time is Google's: an `allDay` is never kept here for it (TimeRange keeps its form). */
  protected override keepsOwnTime(): boolean {
    return true;
  }

  /** Its time compares as a whole: an edit that lands on the same range changes nothing. */
  protected override changedFields(half: ProviderHalf): ProviderHalf {
    const { startAt, endAt, allDay, ...rest } = half;
    const changed: MutableHalf = { ...super.changedFields(rest) };
    if (startAt === undefined && endAt === undefined && allDay === undefined) return changed;
    const next = this.#range(half);
    if (!next.equals(this.timeRange)) {
      changed.startAt = next.start;
      changed.endAt = next.end;
      changed.allDay = next.allDay;
    }
    return changed;
  }

  protected async writeBack(
    caller: Caller,
    integration: Integration,
    half: ProviderHalf,
    notifyGuests: boolean | undefined,
  ): Promise<void> {
    if (!isCalendarProvider(integration)) throw new NotFoundError();
    // changedFields gives the time whole (start, end and allDay) or not at all.
    const patch: EventPatch = {
      ...(half.title === undefined ? {} : { title: half.title }),
      ...(half.startAt instanceof Date && half.endAt instanceof Date
        ? { startAt: half.startAt, endAt: half.endAt, allDay: half.allDay ?? this.data.allDay }
        : {}),
    };
    await integration.updateEvent(
      caller,
      { id: this.id },
      patch,
      notifyGuests === undefined ? {} : { notifyGuests },
    );
  }

  /** The range an edit asks for, from the event's own (an event keeps a start: 400 to clear it). */
  #range(half: ProviderHalf): TimeRange {
    if (half.startAt === null || half.endAt === null) {
      throw new ValidationError('startAt: an event keeps its time');
    }
    const current = this.timeRange;
    if (current === null) {
      if (half.startAt === undefined || half.endAt === undefined) {
        throw new ValidationError('startAt: A time is given whole: startAt and endAt together');
      }
      return TimeRange.of(half.startAt, half.endAt, half.allDay ?? false);
    }
    return current.changedBy({
      ...(half.startAt === undefined ? {} : { start: half.startAt }),
      ...(half.endAt === undefined ? {} : { end: half.endAt }),
      ...(half.allDay === undefined ? {} : { allDay: half.allDay }),
    });
  }

  // ─── A recurring to-do ────────────────────────────────────────────────────

  /**
   * Editors: a recurring to-do (plan Addendum A3), created as a recurring event in the workspace's
   * primary calendar and stored at once as its event item (no local to-do). In order: the rule
   * (400), a due date (400 `needs_due_date`), a primary calendar whose integration still exists
   * (409 `primary_calendar_unset`), owned by the caller (403 `integration_not_owner`), read & write
   * (409 `integration_read_only`; demo data: `provider_writes_off`), under the hourly create limit
   * (429 `create_rate_limited`); then the integration's write session inserts it. Audited as
   * `provider.create`. A topic files it (its overlay); a priority is kept as an override (also on
   * a retry that found the event at Google already).
   *
   * The primary calendar is always one the integration reads, so the integration's
   * `ensureReads` (the same audited helper that setting the primary calls, reason
   * `primary_calendar_read`) only restores that invariant here (it was disclosed when the owner
   * picked the calendar). If it fails after Google created the event: 409 `created_not_stored`.
   */
  static async createRecurring(
    caller: Caller,
    input: NewRecurringTodo,
    now: Date = new Date(),
  ): Promise<{ event: CalendarEvent; created: boolean }> {
    caller.require('editor');
    const rule = RecurrenceRule.fromLines(input.recurrence);
    if (input.dueAt === undefined || input.dueAt === null) {
      throw new AppError(400, 'A recurring to-do needs a due date', { code: 'needs_due_date' });
    }
    if (input.topicId !== undefined && input.topicId !== null) {
      await Topic.assertOf(caller.workspaceId, input.topicId);
    }
    const integration = await CalendarEvent.#primaryIntegration(caller);
    const calendarId = WorkspaceSettings.from(caller.settings).primaryCalendar?.calendarId ?? '';
    const eventId = eventIdFor(
      input.idempotencyKey === undefined
        ? randomUUID()
        : `recurring|${caller.workspaceId}|${caller.userId}|${input.idempotencyKey}`,
    );
    const event = todoEvent(
      {
        title: input.title,
        note: input.note ?? null,
        dueAt: input.dueAt,
        allDay: input.allDay ?? false,
      },
      caller.settings.timezone,
      eventId,
    );
    if (event === null) throw new ValidationError('title: Must not be empty');
    if (!rule.fits(input.allDay ?? false)) {
      throw new ValidationError(
        'recurrence: UNTIL must be a date for an all-day event, a UTC time for a timed one',
      );
    }
    const data = integration.toJSON();
    // A retry of a create that was stored: the same event, answered as it is (nothing is sent,
    // no place is taken).
    if (input.idempotencyKey !== undefined) {
      const known = await MirroredItem.findStored(
        data,
        calendarEventExternalId(calendarId, eventId),
      );
      // Its topic and priority may be what the first try did not get to store: again, idempotently.
      if (known instanceof CalendarEvent) {
        return { event: await CalendarEvent.#applyLocal(known, data, input, now), created: false };
      }
    }

    const quota = CreateQuota.forHour(caller.userId, integration.provider, now);
    await quota.reserveOrRefuse();
    let result: WriteResult;
    try {
      result = await integration.insertEvent(caller, calendarId, event, [rule.toString()]);
    } catch (error) {
      // Refused before anything was sent (the gate, the grant): the place goes back.
      await quota.release();
      throw error;
    }
    if (result.kind !== 'created') {
      if (result.kind === 'refused') await quota.release();
      await auditProviderCreate(caller, data, result.kind, null);
      throw createFailure(result);
    }
    const existed = result.existed === true;
    if (existed) {
      // Google had it already (a retry whose first answer was lost): nothing new was made.
      await quota.release();
    } else {
      await auditProviderCreate(caller, data, 'created', result.record);
    }
    // The primary calendar is always a read calendar (the owner was told when picking it): this
    // only restores that invariant, it never widens what the integration reads.
    try {
      if (await integration.ensureReads(caller, calendarId)) {
        logger.warn('The primary calendar was not a read calendar: added again', {
          integrationId: data.id,
        });
      }
    } catch (error) {
      // The event exists at Google already: a masked 500 would invite a second series.
      logger.warn('A created recurring event could not be kept read', {
        integrationId: data.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new CreatedNotStoredError(data.provider, ['event']);
    }
    // A retry that found the event at Google stores Google's version (its summary, time and rule
    // may differ from this request's); a read that fails leaves it to the next sync.
    let atGoogle: Record<string, unknown> | null = null;
    if (existed) {
      try {
        atGoogle = await integration.readEvent(caller, calendarId, eventId);
      } catch (error) {
        logger.warn('A recurring event found at Google could not be read back', {
          integrationId: data.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        throw new CreatedNotStoredError(data.provider, ['event']);
      }
      // Deleted at Google since (cancelled, or 410 gone): a retry can't bring it back. A 404 threw
      // above: the series may have moved, so that stays "created, not stored" (Try again).
      if (atGoogle === null || atGoogle['status'] === 'cancelled') {
        throw new ProviderItemMissingError(data.provider);
      }
    }
    const stored = await CalendarEvent.#storeCreated(
      caller,
      data,
      calendarId,
      event,
      rule,
      result,
      atGoogle,
    );
    return { event: await CalendarEvent.#applyLocal(stored, data, input, now), created: !existed };
  }

  /**
   * The request's topic and priority on the stored event, where it has none yet: on the first
   * store, and on a retry that completes one that failed. A replay of the same key never puts them
   * back over a later edit. A failure leaves the event stored without them: 409
   * `created_not_stored`, and the same retry completes it.
   */
  static async #applyLocal(
    stored: CalendarEvent,
    data: IntegrationData,
    input: NewRecurringTodo,
    now: Date,
  ): Promise<CalendarEvent> {
    const overlay = stored.overlay;
    const topic = input.topicId ?? null;
    const priority = input.priority ?? null;
    const local = {
      ...(topic === null || overlay.topicOverride !== null ? {} : { topicOverride: topic }),
      ...(priority === null || overlay.overrides.toView().priority !== null
        ? {}
        : { overrides: { priority } }),
    };
    if (Object.keys(local).length === 0) return stored;
    try {
      const updated = await stored.storeOverlay({ ...local, editedAt: now });
      return updated instanceof CalendarEvent ? updated : stored;
    } catch (error) {
      logger.warn('A created recurring event could not keep its topic or priority', {
        integrationId: data.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new CreatedNotStoredError(data.provider, ['event']);
    }
  }

  /**
   * The event just created, stored as its item. A failure here leaves the event at Google: 409
   * `created_not_stored` (written: the event), and it appears after the next sync.
   */
  static async #storeCreated(
    caller: Caller,
    data: IntegrationData,
    calendarId: string,
    event: PlainEventBody,
    rule: RecurrenceRule,
    result: Extract<WriteResult, { kind: 'created' }>,
    atGoogle: Record<string, unknown> | null,
  ): Promise<CalendarEvent> {
    let stored: MirroredItem | null = null;
    try {
      const mapped = CalendarEvent.#mapped(caller, data, calendarId, event, rule, result, atGoogle);
      stored = mapped === null ? null : await MirroredItem.store(data, mapped);
    } catch (error) {
      logger.warn('A created recurring event could not be stored', {
        integrationId: data.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    if (!(stored instanceof CalendarEvent)) {
      throw new CreatedNotStoredError(data.provider, ['event']);
    }
    return stored;
  }

  /** The workspace's primary calendar integration, the caller's and writable now. */
  static async #primaryIntegration(caller: Caller): Promise<Integration & CalendarProvider> {
    const primary = WorkspaceSettings.from(caller.settings).primaryCalendar;
    if (primary === null) throw new PrimaryCalendarUnsetError();
    const integration = await Integration.forWorker(primary.integrationId);
    if (integration?.workspaceId !== caller.workspaceId || !isCalendarProvider(integration)) {
      throw new PrimaryCalendarUnsetError();
    }
    if (!integration.isOwnedBy(caller.userId)) throw new IntegrationNotOwnerError(integration.id);
    integration.assertWritable(caller);
    if (!integration.canCreate) {
      throw new AppError(409, 'Only Google Calendar connected with Google can create events');
    }
    return integration;
  }

  /** The created event as the calendar sync maps it (its series' rule included). */
  static #mapped(
    caller: Caller,
    integration: IntegrationData,
    calendarId: string,
    event: PlainEventBody,
    rule: RecurrenceRule,
    result: Extract<WriteResult, { kind: 'created' }>,
    atGoogle: Record<string, unknown> | null,
  ): MappedItem | null {
    const mapped = mapCalendarEvent(
      atGoogle ?? {
        id: result.record.id,
        status: 'confirmed',
        summary: event.summary,
        htmlLink: result.record.url ?? '',
        updated: new Date().toISOString(),
        start: event.start,
        end: event.end,
        recurrence: [rule.toString()],
      },
      { calendarId, accountId: integration.accountId, timeZone: caller.settings.timezone },
    );
    return 'deleted' in mapped ? null : mapped;
  }
}
