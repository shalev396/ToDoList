/**
 * Capability contracts of integrations (`implements`): what a provider class can do beyond the
 * base. Routes, services and MCP ask the base type through the type guards below
 * (`isTaskProvider(integration)`) instead of switching on the provider, and the compiler makes
 * every implementing class provide the whole contract: a to-do operation added to TaskProvider
 * must then exist for every to-do integration.
 *
 * Every write these contracts make goes through the protected write session
 * (Integration#withWriteSession), the one place that refuses demo data and read-only
 * integrations.
 */
import type { CleanupProgress } from '../../types/primaryCalendar.js';
import type { TimeBudget } from './calendar/TimeBudget.js';
import type { Caller } from '../base/Caller.js';
import type { Revocable } from '../base/contracts.js';
import type { PlanEntry, SkippedItem, WireOp } from '../../gcal/diff.js';
import type { PlanNarrowing } from '../calendar/PushPlan.js';
import type { ItemData } from '../../models/definitions/Item.js';
import type { MappedItem } from '../../sync/types.js';
import type { OAuthResource } from '../../types/integrations.js';
import type { FacetContainer, ItemSummary } from '../../types/items.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
} from '../../types/providerCreate.js';
import type { SecretJson } from './auth/AuthStrategy.js';
import type { ApiKeyAuth } from './auth/ApiKeyAuth.js';
import type { OAuthAuth } from './auth/OAuthAuth.js';
import type { PickerKind } from './definitions/IntegrationDefinition.js';
import type { Integration } from './Integration.js';
import type { TaskPatch } from './TaskEdit.js';
import type { PlainEventBody, WrittenEvent } from './writers/calendarApi.js';
import type { CreatedRecord, CreateFields, WriteResult } from './writers/trackerWriter.js';

export type {
  CreatedRecord,
  CreateFields,
  PlainEventBody,
  Revocable,
  TaskPatch,
  WriteResult,
  WrittenEvent,
};

/** A stored item an operation is about: its id (the integration reads the item itself). */
export interface ItemRef {
  readonly id: string;
}

/** The create funnel: one step's choices (sites, projects, lists, repos, calendars). */
export interface CreateFunnel {
  createOptions(caller: Caller, query: CreateOptionsQuery): Promise<CreateOptionsResponseData>;
}

/** What one create sends, and how its answer is recorded at once. */
export interface CreateTaskRequest {
  target: CreateTarget;
  fields: CreateFields;
  /**
   * Called once with the provider's answer, right after it comes and before the read-back: the
   * caller records it (the audit entry, the copy's status) whatever happens next.
   */
  settle(result: WriteResult): Promise<void>;
}

/** The provider's answer, and the created item read back and mapped (null: not read back). */
export interface CreatedTask {
  result: WriteResult;
  mapped: MappedItem | null;
}

/**
 * A to-do integration (Jira, ClickUp, Linear, GitHub): it reads tasks (the sync), creates one from
 * a to-do, and writes a mirrored item's edits back. Reading is the base; every to-do operation
 * that changes the provider is here.
 */
export interface TaskProvider extends CreateFunnel {
  createTask(caller: Caller, request: CreateTaskRequest): Promise<CreatedTask>;
  /**
   * One edit of a mirrored item of this integration (plan Addendum A1), its owner's: the fields
   * its provider holds (its definition's `writableFields`, for the item's kind) are written there
   * through the write session and saved here as the provider confirmed them; TodoList's own fields
   * and the fields the provider lacks are saved here only. An edit with nothing for the provider
   * never opens a write session (and works while read-only). The item as now stored.
   */
  updateTask(caller: Caller, item: ItemRef, patch: TaskPatch): Promise<ItemData>;
}

/** One calendar of the account, for the picker. */
export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  /** `owner`, `writer`, `reader` or `freeBusyReader`: only the first two can take a push. */
  accessRole: string;
}

/** What a push would create, update and remove: nothing is written. */
export interface CalendarDryRun {
  dryRun: true;
  counts: { create: number; update: number; remove: number };
  entries: PlanEntry[];
  skipped: SkippedItem[];
}

/**
 * An edit of one pulled event, in the item's own names: what changes, each optional, at least
 * one. Its time is given whole: `startAt` and `endAt` together, with `allDay` (default: a timed
 * event). An all-day event runs from the day `startAt` falls on in the workspace's zone up to the
 * day `endAt` falls on, that day excluded (as Google and the event's item keep it); an `endAt` on
 * the start's day is that one day. `description` is written to Google; an item keeps none.
 */
export interface EventPatch {
  title?: string;
  /** Plain text; null clears it. */
  description?: string | null;
  startAt?: Date;
  endAt?: Date;
  allDay?: boolean;
}

/**
 * Whether Google tells an event's other guests about a change (`sendUpdates`): required for an
 * event that has guests (409 `event_has_guests` without it), optional otherwise.
 */
export interface GuestNotice {
  readonly notifyGuests?: boolean;
}

/** An event TodoList pushed, by the item it was pushed for (its CalendarLink of this integration). */
export interface LinkedItemRef {
  readonly itemId: string;
}

/**
 * A push: the plan's ops, as of `now`, to the workspace's primary calendar `calendarId` (the one
 * the pull after the writes reads back).
 */
export interface CalendarPushRequest {
  ops: readonly WireOp[];
  now: Date;
  calendarId: string;
  /** The request's time budget (its plan already spent part of it); a fresh one when absent. */
  budget?: TimeBudget;
}

/**
 * What "Also remove everything TodoList added" did (counts only): the events and calendars
 * removed, the calendars kept, the events left on the current workspace calendar (`skipped`) and
 * the steps Google refused for good (`failed`). `remaining` is 0 once it completed.
 */
export type AddedRemoval = CleanupProgress;

/**
 * An integration that can take back what TodoList added at its provider, always on its owner's
 * request: only what TodoList itself made, only while it is read & write (409
 * `integration_read_only`), within the write budget (409 `cleanup_incomplete` with the progress
 * when time runs out; the next call goes on).
 */
export interface AddedContentRemover {
  /** "Also remove everything TodoList added", before a disconnect. */
  removeAdded(caller: Caller): Promise<AddedRemoval>;
  /** "Remove" the events it pushed (an earlier workspace calendar's leftovers). */
  removePushed(
    caller: Caller,
  ): Promise<{ events: number; remaining: 0; skipped: number; failed: number }>;
  /** How many events it pushed are still live. */
  pushedEventCount(caller: Caller): Promise<number>;
}

/**
 * A calendar integration (Google Calendar): events in, and the two-way push out; an event created,
 * changed or deleted, and a calendar of TodoList's own created. Every write is its owner's,
 * through the write session.
 */
export interface CalendarProvider extends CreateFunnel {
  listCalendars(caller: Caller): Promise<GoogleCalendarEntry[]>;
  /**
   * One event created from a to-do, in the calendar the user picked; with `recurrence` (one
   * `RRULE:` line, checked by a strict parser: 400 otherwise), a recurring one (plan Addendum A3).
   */
  insertEvent(
    caller: Caller,
    calendarId: string,
    event: PlainEventBody,
    recurrence?: readonly string[],
  ): Promise<WriteResult>;
  /**
   * A pulled event's title, time or description changed, by its item (this integration's event
   * item, on one of the calendars it reads: 404 otherwise); the item follows. Never a raw calendar
   * or event id from a caller.
   */
  updateEvent(
    caller: Caller,
    item: ItemRef,
    patch: EventPatch,
    notice?: GuestNotice,
  ): Promise<WrittenEvent>;
  /**
   * Its owner makes sure the integration reads `calendarId`, the workspace's primary calendar (always
   * a read calendar); whether it was added.
   */
  ensureReads(caller: Caller, calendarId: string): Promise<boolean>;
  /** One event as Google has it now (a read; null when gone): what a retried create stored. */
  readEvent(
    caller: Caller,
    calendarId: string,
    eventId: string,
  ): Promise<Record<string, unknown> | null>;
  /** A pulled event deleted, by its item (already gone is done); the item goes too. */
  deleteEvent(caller: Caller, item: ItemRef, notice?: GuestNotice): Promise<void>;
  /**
   * An event TodoList pushed, deleted by its CalendarLink of this integration (the live
   * `to_google` link of the item it was pushed for, whose event id is the one TodoList gives that
   * item: 404 otherwise); the link is tombstoned. For the push's clean-up (an item deleted, a
   * disconnect). `deletedBy`: the member whose delete of the to-do this follows; the audit entry
   * names them, with their address and user agent, while the integration's owner (`caller`) still
   * opens the write session. Without it the entry names `caller`.
   */
  deleteLinkedEvent(caller: Caller, link: LinkedItemRef, deletedBy?: Caller): Promise<void>;
  /**
   * A calendar of TodoList's own, named `name` (Google's `calendars.insert`, which needs the
   * `calendar.app.created` scope: a grant without it is 409 `scope_missing`). It is read from
   * then on and recorded as TodoList's own (the only kind of calendar TodoList may delete).
   */
  createCalendar(caller: Caller, name: string): Promise<GoogleCalendarEntry>;
  /**
   * Whether `calendarId` may be the workspace's primary calendar on this integration: its owner's
   * (404), read & write (409 `integration_read_only`), and a calendar of the account it can write
   * (400 otherwise). The calendar as the account lists it.
   */
  primaryCandidate(caller: Caller, calendarId: string): Promise<GoogleCalendarEntry>;
  /** What a push would do now (allowed in read-only mode: it writes nothing). */
  dryRun(caller: Caller, narrowing?: PlanNarrowing, now?: Date): Promise<CalendarDryRun>;
  /** The push, start to commit: the run's id. */
  push(caller: Caller, request: CalendarPushRequest): Promise<string>;
}

/** One thing a grant lets its owner pick: a Jira site, a ClickUp workspace, a calendar. */
export interface PickerResource {
  id: string;
}

/** What each kind of picker lists. */
export interface PickerResources {
  sites: OAuthResource;
  workspaces: OAuthResource;
  calendars: GoogleCalendarEntry;
}

/**
 * A connection whose grant reaches several resources, of which its owner picks the ones to read:
 * Jira sites, ClickUp workspaces, Google calendars (`K`). Its owner only (404 otherwise); a
 * connection with nothing to pick (`pickerKind` null: a token connection reads its one site)
 * refuses both with 409.
 */
export interface ResourcePicker<K extends PickerKind = PickerKind> {
  /** What this connection lets its owner pick now; null: nothing. */
  readonly pickerKind: K | null;
  /** The resources the grant reaches, live from the provider. */
  pickerResources(caller: Caller): Promise<PickerResources[K][]>;
  /** Reads exactly these from now on (each must be one the grant reaches: 400 otherwise). */
  choose(caller: Caller, ids: readonly string[]): Promise<Integration>;
}

/**
 * A learning platform (Moodle), read only: the courses the account is enrolled in, a course's
 * assignments, and the deadlines across them (plan: "courses, assignments, deadlines"). Moodle is
 * coming soon, so its methods refuse with 400 `provider_coming_soon` until it opens (its demo
 * sample reads all three through the sync, as containers and items).
 */
export interface CourseProvider {
  courses(caller: Caller): Promise<FacetContainer[]>;
  assignments(caller: Caller, courseId: string): Promise<ItemSummary[]>;
  deadlines(caller: Caller): Promise<ItemSummary[]>;
}

/** Connects through the provider's OAuth sign-in. */
export interface SupportsOAuth<TSecret extends SecretJson = SecretJson> {
  readonly oauth: OAuthAuth<TSecret>;
}

/** Connects with a key or token the user pastes. */
export interface SupportsApiKey<TSecret extends SecretJson = SecretJson> {
  readonly apiKey: ApiKeyAuth<TSecret>;
}

const hasMethod = (value: object, name: string): boolean =>
  typeof (value as Record<string, unknown>)[name] === 'function';

export function isTaskProvider(
  integration: Integration,
): integration is Integration & TaskProvider {
  return ['createTask', 'createOptions', 'updateTask'].every((name) =>
    hasMethod(integration, name),
  );
}

export function isCalendarProvider(
  integration: Integration,
): integration is Integration & CalendarProvider {
  return [
    'insertEvent',
    'push',
    'updateEvent',
    'deleteEvent',
    'deleteLinkedEvent',
    'createCalendar',
    'primaryCandidate',
    'ensureReads',
  ].every((name) => hasMethod(integration, name));
}

/** Can take back what TodoList added at its provider (AddedContentRemover). */
export function isAddedContentRemover(
  integration: Integration,
): integration is Integration & AddedContentRemover {
  return hasMethod(integration, 'removeAdded');
}

/** Can create one item from a to-do: a task or a calendar event. */
export function isCreateFunnel(
  integration: Integration,
): integration is Integration & CreateFunnel {
  return hasMethod(integration, 'createOptions');
}

export function isResourcePicker(
  integration: Integration,
): integration is Integration & ResourcePicker {
  return hasMethod(integration, 'pickerResources') && hasMethod(integration, 'choose');
}

/** A picker of this kind with something to pick now (its `pickerKind` is `kind`). */
export function picksFrom<K extends PickerKind>(
  integration: Integration,
  kind: K,
): integration is Integration & ResourcePicker<K> {
  return isResourcePicker(integration) && integration.pickerKind === kind;
}

/** Reads a learning platform's courses, assignments and deadlines (CourseProvider). */
export function isCourseProvider(
  integration: Integration,
): integration is Integration & CourseProvider {
  return ['courses', 'assignments', 'deadlines'].every((name) => hasMethod(integration, name));
}

export function isRevocable(integration: Integration): integration is Integration & Revocable {
  return hasMethod(integration, 'revoke');
}

export function supportsOAuth(
  integration: Integration,
): integration is Integration & SupportsOAuth {
  return 'oauth' in integration;
}

export function supportsApiKey(
  integration: Integration,
): integration is Integration & SupportsApiKey {
  return 'apiKey' in integration;
}
