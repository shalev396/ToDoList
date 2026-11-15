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
import type { Caller } from '../base/Caller.js';
import type { Revocable } from '../base/contracts.js';
import type { PlanEntry, SkippedItem, WireOp } from '../../gcal/diff.js';
import type { PlanNarrowing } from '../../gcal/plan.js';
import type { MappedItem } from '../../sync/types.js';
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
import type { PlainEventBody } from './writers/calendarApi.js';
import type { CreatedRecord, CreateFields, WriteResult } from './writers/trackerWriter.js';

export type { CreatedRecord, CreateFields, PlainEventBody, Revocable, WriteResult };

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
 * A to-do integration (Jira, ClickUp, Linear, GitHub): it reads tasks (the sync) and creates one
 * from a to-do. Reading is the base; every to-do operation that changes the provider is here.
 */
export interface TaskProvider extends CreateFunnel {
  createTask(caller: Caller, request: CreateTaskRequest): Promise<CreatedTask>;
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

/** A push: the plan's ops, as of `now`. */
export interface CalendarPushRequest {
  ops: readonly WireOp[];
  now: Date;
}

/** A calendar integration (Google Calendar): events in, and the two-way push out. */
export interface CalendarProvider extends CreateFunnel {
  listCalendars(caller: Caller): Promise<GoogleCalendarEntry[]>;
  /** One event created from a to-do, in the calendar the user picked. */
  insertEvent(caller: Caller, calendarId: string, event: PlainEventBody): Promise<WriteResult>;
  /** What a push would do now (allowed in read-only mode: it writes nothing). */
  dryRun(caller: Caller, narrowing?: PlanNarrowing, now?: Date): Promise<CalendarDryRun>;
  /** The push, start to commit: the run's id. */
  push(caller: Caller, request: CalendarPushRequest): Promise<string>;
}

/** One thing a grant lets its owner pick: a Jira site, a ClickUp workspace, a calendar. */
export interface PickerResource {
  id: string;
}

/**
 * A connection whose grant reaches several resources, of which its owner picks the ones to read
 * (Jira sites, ClickUp workspaces, Google calendars). Its owner only.
 */
export interface ResourcePicker<R extends PickerResource = PickerResource> {
  /** What this connection lets its owner pick now; null: nothing (a token connection reads its one site). */
  readonly pickerKind: PickerKind | null;
  /** The resources the grant reaches, live from the provider. */
  pickerResources(caller: Caller): Promise<R[]>;
  /** Reads exactly these from now on (each must be one the grant reaches: 400 otherwise). */
  choose(caller: Caller, ids: readonly string[]): Promise<Integration>;
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
  return hasMethod(integration, 'createTask') && hasMethod(integration, 'createOptions');
}

export function isCalendarProvider(
  integration: Integration,
): integration is Integration & CalendarProvider {
  return hasMethod(integration, 'insertEvent') && hasMethod(integration, 'push');
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
