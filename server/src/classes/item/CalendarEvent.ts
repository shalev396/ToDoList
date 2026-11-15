/**
 * A Google Calendar event mirrored by its integration (Schedulable): the calendar, clock, agenda
 * and timeline blocks read its time range, and the workspace calendar's push leaves it alone.
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
import { Topic } from '../workspace/Topic.js';
import { WorkspaceSettings } from '../workspace/WorkspaceSettings.js';
import { AppError } from '../../errors/AppError.js';
import { CreatedNotStoredError } from '../../errors/CreatedNotStoredError.js';
import { IntegrationNotOwnerError } from '../../errors/IntegrationNotOwnerError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { PrimaryCalendarUnsetError } from '../../errors/PrimaryCalendarUnsetError.js';
import { ProviderItemMissingError } from '../../errors/ProviderItemMissingError.js';
import { ProviderNoAnswerError } from '../../errors/ProviderNoAnswerError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { logger } from '../../services/logger.js';
import { calendarEventExternalId, mapCalendarEvent } from '../../sync/providers/google_calendar.js';
import type { MappedItem } from '../../sync/types.js';
import type { Schedulable } from './contracts.js';
import { CreateQuota } from './CreateQuota.js';
import { eventHasGuests } from './guests.js';
import { Item } from './Item.js';
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

export class CalendarEvent extends MirroredItem implements Schedulable {
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
      // Deleted at Google since (gone, or cancelled): a retry can't bring it back.
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
   * The request's topic and priority on the stored event (also on a retry that found it already:
   * the same values again, so it is idempotent). A failure leaves the event stored without them:
   * 409 `created_not_stored`, and the same retry completes it.
   */
  static async #applyLocal(
    stored: CalendarEvent,
    data: IntegrationData,
    input: NewRecurringTodo,
    now: Date,
  ): Promise<CalendarEvent> {
    const local = {
      ...(input.topicId === undefined || input.topicId === null
        ? {}
        : { topicOverride: input.topicId }),
      ...(input.priority === undefined || input.priority === null
        ? {}
        : { overrides: { priority: input.priority } }),
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
