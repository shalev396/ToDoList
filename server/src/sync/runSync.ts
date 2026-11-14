/**
 * runIntegrationSync: one sync of one integration (BACKEND.md §5, DATA.md §4), whoever started
 * it: the sync worker (a background job, sync/worker.ts) or the demo seed (seed/seedWorkspace.ts).
 *
 * 1. Load the integration and its workspace. Gone: nothing is synced, and a queued run named by
 *    `runId` ends `failed` with `integration_deleted` (never left `queued`). A paused or expired
 *    integration is not synced: its run ends `failed` with `skipped_paused` / `skipped_expired`.
 *    Otherwise start the SyncRun (or the queued one named by `runId`).
 * 2. Transport: the adapter's recorded fixture set, the live network, or a test's.
 * 3. Inside withProviderSecret() (fixtures: `{}`; live: the vault), for every resource of the
 *    adapter: read its SyncState, then page by page upsert containers (topic rules) and items
 *    (container ids, inherited topics), each hashed, stamped with the resource and bulk-upserted
 *    on its natural key; then store the resource's next state.
 * 4. A resource that listed everything it owns (`fullSync`) is swept at once: its rows not seen
 *    since the run started get `deletedAt` (only inside its time window, when it has one). Once
 *    every resource completed, the rows of resources no longer listed are deleted too. A record
 *    that failed in the run is never swept.
 * 5. Finish: the integration is checked again (disconnected mid-run → what the run wrote is
 *    deleted again, `integration_deleted`); then the run (`succeeded`, `partial` when records were
 *    skipped, `failed`), the integration's status (a pause or expiry set meanwhile wins) and an
 *    audit entry.
 *
 * A record without an id or URL, one that fails validation (recordCheck.ts) or one the adapter
 * reports is skipped and recorded (the run goes on). Anything thrown fails the run with a fixed `{code, message}`, never provider text, and
 * no run is left `running`. `auth_failed` (401/403) sets the integration to `error` at once
 * (reconnect); other failures do so after three failed runs in a row, each run counted once
 * however often its job is retried.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncModeFor } from './syncMode.js';
import type { ErrorInfo, SourceAccount, SourceRef } from '../models/definitions/common.js';
import type { ContainerData, ContainerUpsert } from '../models/definitions/Container.js';
import { isExpiring, type IntegrationData } from '../models/definitions/Integration.js';
import {
  SWEEP_WINDOW_FIELDS,
  type ItemUpsert,
  type SweepWindow,
} from '../models/definitions/Item.js';
import type { SyncRunFailure, SyncRunPatch } from '../models/definitions/SyncRun.js';
import type { SyncStateData } from '../models/definitions/SyncState.js';
import type { WorkspaceData } from '../models/definitions/Workspace.js';
import {
  getAuditLogRepository,
  getContainerRepository,
  getIntegrationRepository,
  getItemRepository,
  getSyncRunRepository,
  getSyncStateRepository,
  getWorkspaceRepository,
} from '../models/index.js';
import { classifyTopic, defaultTopicForIntegration } from '../services/topicRules.js';
import { logger } from '../services/logger.js';
import type { IntegrationStatus, SyncRunStatus, SyncTrigger } from '../types/domain.js';
import type { SyncMode } from '../types/env.d.ts';
import { transportForIntegration } from '../services/oauth/transport.js';
import { FixtureMissingError, ProviderHttpError } from './errors.js';
import { containerSourceHash, itemSourceHash } from './hash.js';
import type { Clock, Transport } from './http.js';
import './providers/index.js';
import { containerProblem, deletedRecordProblem, itemProblem } from './recordCheck.js';
import { getAdapter } from './registry.js';
import { withProviderSecret } from './secrets.js';
import { fixtureTransport, loadFixtureSet } from './transports/fixtures.js';
import { liveTransport } from './transports/live.js';
import {
  ListingTooLargeError,
  type AdapterContext,
  type AdapterPage,
  type DeletedRecord,
  type MappedContainer,
  type MappedItem,
  type ProviderAdapter,
  type ResourceResult,
  type SyncCounts,
  type SyncErrorCode,
  type SyncRunSummary,
} from './types.js';

/** SyncStates pseudo-resource for the integration as a whole: failed runs in a row, last full sync. */
export const RUN_STATE_RESOURCE = '__run__';
/** Failed runs in a row before the integration goes to `error` (BACKEND.md §12). */
export const FAILED_RUNS_BEFORE_ERROR = 3;
/**
 * A full sync of every resource is due once the last complete one is this old. Under 24 h, so a
 * twice-daily schedule gets one every day despite timing jitter.
 */
export const FULL_SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Skipped records listed on a run; `counts.failed` has the total. */
export const MAX_RECORDED_FAILURES = 50;

const DEFAULT_FIXTURE_SET = 'v1';
const FIXTURE_SET_NAME = /^[A-Za-z0-9_-]+$/;
/** src/sync/fixtures (next to this file; in the Lambda bundle, next to index.mjs). */
const FIXTURES_ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** The only text a failed run stores or shows: fixed per code (BACKEND.md §6). */
export const SYNC_ERROR_MESSAGES: Readonly<Record<SyncErrorCode, string>> = {
  auth_failed: 'Reconnect required',
  not_found: 'Not found at the provider',
  gone: 'No longer available at the provider',
  rate_limited: 'Provider rate limit reached',
  client_error: 'The provider refused the request',
  server_error: 'The provider is unavailable',
  bad_response: 'Unexpected response from the provider',
  network: 'Could not reach the provider',
  no_adapter: 'This provider cannot be synced yet',
  integration_deleted: 'The integration was disconnected',
  adapter_error: 'The provider adapter failed',
  invalid_data: 'A synced record could not be stored',
  listing_too_large: 'The provider listing is too large to sync',
  fixtures_missing: 'No recorded fixtures for this provider',
  credential_unavailable: 'The stored credential could not be used',
  enqueue_failed: 'Could not queue the sync',
  skipped_paused: 'The integration is paused',
  skipped_expired: 'The connection has expired',
  timeout: 'The sync did not finish in time',
  internal: 'Sync failed',
};

interface SyncRunBaseOptions {
  /** `fixtures` replays recorded responses and never decrypts. A test can force it (testSwitches). */
  mode: SyncMode;
  /** A fixture set of the adapter (default `v1`). Fixtures mode only. */
  fixtureSet?: string;
  /** The run's time (default: now). */
  now?: Date;
  /** Replaces the live or fixture transport (tests). */
  transport?: Transport;
  /** Clock for the adapter's request throttle and waits (default: the real one). Fixtures replays pass one that never waits. */
  clock?: Clock;
}

/** A trigger, for a new run; or the id of a queued run (enqueueSync), which has its own trigger. */
export type SyncRunOptions = SyncRunBaseOptions &
  ({ trigger: SyncTrigger; runId?: never } | { runId: string; trigger?: never });

/** A failure the engine detects itself. */
class SyncRunError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, options?: ErrorOptions) {
    super(`sync failed: ${code}`, options);
    this.name = 'SyncRunError';
    this.code = code;
  }
}

/** What items need of their container: its id and topic (and the resource that swept it). */
type CachedContainer = Pick<ContainerData, 'id' | 'topicId' | 'syncResource'>;

/** Mutable state of one run. */
interface RunState {
  integration: IntegrationData;
  workspace: WorkspaceData;
  runId: string;
  trigger: SyncTrigger;
  now: Date;
  /** Wall clock when the run started fetching: rows not touched since then were not seen. */
  seenSince: Date;
  counts: SyncCounts;
  /** The first MAX_RECORDED_FAILURES skipped records, stored on the run. */
  failures: SyncRunFailure[];
  /** Every external id that failed in this run: never swept (a failure is not a deletion). */
  failedIds: Set<string>;
  /** Failed records without an id: the resource they came from cannot be swept this run. */
  unidentifiedFailures: number;
  /** Invalid fields already logged in this run, as `<resource> <field>`: one warning each. */
  loggedInvalidFields: Set<string>;
  /**
   * This integration's live containers by external id, loaded at the first lookup of the run
   * (null until then) and kept current by refreshContainers().
   */
  containers: Map<string, CachedContainer> | null;
}

function zeroCounts(): SyncCounts {
  return { fetched: 0, inserted: 0, updated: 0, unchanged: 0, closed: 0, deleted: 0, failed: 0 };
}

function skippedRun(): SyncRunSummary {
  return { runId: null, status: 'skipped', counts: zeroCounts(), error: null };
}

/**
 * The next millisecond on the wall clock. `lastSeenAt` has millisecond precision, so every row an
 * earlier run touched has `lastSeenAt` strictly before it, and every row this run touches has
 * `lastSeenAt` at or after it.
 */
async function nextMillisecond(): Promise<Date> {
  const start = Date.now();
  while (Date.now() <= start) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  return new Date();
}

function isFullSyncDue(runState: SyncStateData | null, now: Date): boolean {
  const last = runState?.lastFullSyncAt ?? null;
  return last === null || now.getTime() - last.getTime() >= FULL_SYNC_INTERVAL_MS;
}

/** Error names meaning the database refused a mapped value: Mongoose casting or validation. */
const INVALID_DATA_ERRORS: ReadonlySet<string> = new Set([
  'CastError',
  'ValidationError',
  'ValidatorError',
  'StrictModeError',
]);
/** MongoDB's DocumentValidationFailure: the collection's $jsonSchema validator refused a write. */
const DOCUMENT_VALIDATION_FAILURE = 121;

/**
 * The code a thrown value ends the run with. Deterministic failures get codes the worker does not
 * retry, since the same input fails again: a missing fixture (`fixtures_missing`), a listing past
 * the adapter's bound (`listing_too_large`), a value the database refuses (`invalid_data`), a
 * programming error such as a TypeError (`adapter_error`).
 */
function errorCodeOf(error: unknown): SyncErrorCode {
  if (error instanceof ProviderHttpError || error instanceof SyncRunError) return error.code;
  if (error instanceof FixtureMissingError) return 'fixtures_missing';
  if (error instanceof ListingTooLargeError) return 'listing_too_large';
  if (!(error instanceof Error)) return 'internal';
  if (
    INVALID_DATA_ERRORS.has(error.name) ||
    (error as { code?: unknown }).code === DOCUMENT_VALIDATION_FAILURE
  ) {
    return 'invalid_data';
  }
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) {
    return 'adapter_error';
  }
  return 'internal';
}

/** Why a mapped record can't be stored, or null. Checked at run time: adapters map provider data. */
function sourceProblem(source: SourceRef): 'missing_id' | 'missing_url' | null {
  if (typeof source.externalId !== 'string' || source.externalId === '') return 'missing_id';
  if (typeof source.url !== 'string' || source.url.trim() === '') return 'missing_url';
  return null;
}

/** A record failed validation: its field is logged by name (never its value), once per run. */
function invalidRecord(run: RunState, resource: string, field: string): 'invalid_record' {
  const logged = `${resource} ${field}`;
  if (!run.loggedInvalidFields.has(logged)) {
    run.loggedInvalidFields.add(logged);
    logger.warn('sync record skipped: invalid field', {
      runId: run.runId,
      integrationId: run.integration.id,
      resource,
      field,
    });
  }
  return 'invalid_record';
}

/**
 * Why a mapped record is skipped, as its failure code, or null when it can be stored: no id or
 * link (`missing_id`, `missing_url`), or a field that fails validation (`invalid_record`,
 * recordCheck.ts).
 */
function skipCode(
  run: RunState,
  resource: string,
  source: SourceRef,
  invalidField: () => string | null,
): string | null {
  const missing = sourceProblem(source);
  if (missing !== null) return missing;
  const field = invalidField();
  return field === null ? null : invalidRecord(run, resource, field);
}

/** The ids of the valid delete-only records; the others are recorded as failures. */
function deletedIds(run: RunState, resource: string, records: readonly DeletedRecord[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    const { externalId } = record;
    if (typeof externalId !== 'string' || externalId === '') {
      recordFailure(run, externalId, 'missing_id');
      continue;
    }
    const field = deletedRecordProblem(record);
    if (field === null) ids.push(externalId);
    else recordFailure(run, externalId, invalidRecord(run, resource, field));
  }
  return ids;
}

/** What an adapter's failure code must look like: short snake_case, never provider text. */
const FAILURE_CODE = /^[a-z][a-z0-9_]{1,40}$/;

/** An adapter-reported failure code, or `invalid_failure_code` when it is anything else. */
function adapterFailureCode(code: unknown): string {
  return typeof code === 'string' && FAILURE_CODE.test(code) ? code : 'invalid_failure_code';
}

/** Counts a skipped record, keeps its id out of the sweeps, and records the first 50. */
function recordFailure(run: RunState, externalId: unknown, code: string): void {
  const id = typeof externalId === 'string' ? externalId : '';
  run.counts.failed += 1;
  if (id === '') run.unidentifiedFailures += 1;
  else run.failedIds.add(id);
  if (run.failures.length < MAX_RECORDED_FAILURES) run.failures.push({ externalId: id, code });
}

/** The run's source: provider and account always come from the integration, never the adapter. */
function ownedSource(source: SourceRef, integration: IntegrationData): SourceRef {
  return { ...source, provider: integration.provider, accountId: integration.accountId };
}

function toContainerUpsert(
  run: RunState,
  resource: string,
  mapped: MappedContainer,
): ContainerUpsert {
  const { integration } = run;
  const upsert: ContainerUpsert = {
    integrationId: integration.id,
    topicId:
      mapped.topicId !== undefined
        ? mapped.topicId
        : classifyTopic(
            {
              matchKey: mapped.matchKey ?? mapped.name,
              defaultTopicId: defaultTopicForIntegration(integration),
            },
            run.workspace.settings.topicRules,
          ),
    type: mapped.type,
    name: mapped.name,
    path: mapped.path ?? [],
    props: mapped.props ?? {},
    deletedAt: mapped.deletedAt ?? null,
    source: ownedSource(mapped.source, integration),
    syncResource: resource,
  };
  return { ...upsert, source: { ...upsert.source, hash: containerSourceHash(upsert) } };
}

function toItemUpsert(
  run: RunState,
  resource: string,
  mapped: MappedItem,
  container: CachedContainer | null,
): ItemUpsert {
  const { integration } = run;
  const upsert: ItemUpsert = {
    integrationId: integration.id,
    containerId: container?.id ?? null,
    kind: mapped.kind,
    // An item files under its container's topic, none (Unsorted) included.
    topicId:
      mapped.topicId !== undefined
        ? mapped.topicId
        : container !== null
          ? container.topicId
          : defaultTopicForIntegration(integration),
    title: mapped.title,
    bodyPreview: mapped.bodyPreview ?? null,
    status: mapped.status,
    statusRaw: mapped.statusRaw ?? null,
    priority: mapped.priority ?? null,
    startAt: mapped.startAt ?? null,
    dueAt: mapped.dueAt ?? null,
    endAt: mapped.endAt ?? null,
    allDay: mapped.allDay ?? false,
    assignees: mapped.assignees ?? [],
    labels: mapped.labels ?? [],
    props: mapped.props ?? {},
    closedAt: mapped.closedAt ?? null,
    deletedAt: mapped.deletedAt ?? null,
    source: ownedSource(mapped.source, integration),
    syncResource: resource,
  };
  return { ...upsert, source: { ...upsert.source, hash: itemSourceHash(upsert) } };
}

/** This integration's live containers, all of them or only the given external ids. */
async function loadContainers(
  run: RunState,
  externalIds?: readonly string[],
): Promise<Map<string, CachedContainer>> {
  const list = await (
    await getContainerRepository()
  ).list(run.integration.workspaceId, {
    integrationId: run.integration.id,
    ...(externalIds === undefined ? {} : { externalIds }),
  });
  return new Map(
    list.map(({ id, topicId, syncResource, source }) => [
      source.externalId,
      { id, topicId, syncResource },
    ]),
  );
}

/** An item's container, by its external id, from the run's cache (loaded once per run). */
async function containerFor(
  run: RunState,
  externalId: string | null | undefined,
): Promise<CachedContainer | null> {
  if (externalId === undefined || externalId === null || externalId === '') return null;
  run.containers ??= await loadContainers(run);
  return run.containers.get(externalId) ?? null;
}

/**
 * After containers were written or swept: looks up only those external ids again, so the cache
 * gains new ones, follows changes (a topic) and drops deleted ones. Nothing to do before the
 * cache is loaded: the first lookup reads every container.
 */
async function refreshContainers(run: RunState, externalIds: readonly string[]): Promise<void> {
  const cache = run.containers;
  if (cache === null || externalIds.length === 0) return;
  const fresh = await loadContainers(run, externalIds);
  for (const externalId of externalIds) {
    const container = fresh.get(externalId);
    if (container === undefined) cache.delete(externalId);
    else cache.set(externalId, container);
  }
}

/**
 * The provider account the run's records belong to (the engine's, never the adapter's), as this
 * integration's copy: another member's integration of the same account keeps its own.
 */
function accountOf(run: RunState): SourceAccount {
  return {
    provider: run.integration.provider,
    accountId: run.integration.accountId,
    integrationId: run.integration.id,
  };
}

/** One page's containers: upserted (topic rules), then the delete-only ones. */
async function storeContainers(
  run: RunState,
  resource: string,
  mapped: readonly MappedContainer[],
  deleted: readonly DeletedRecord[],
): Promise<void> {
  const workspaceId = run.integration.workspaceId;
  const repository = await getContainerRepository();
  const containers: ContainerUpsert[] = [];
  for (const container of mapped) {
    const skip = skipCode(run, resource, container.source, () => containerProblem(container));
    if (skip === null) containers.push(toContainerUpsert(run, resource, container));
    else recordFailure(run, container.source.externalId, skip);
  }
  if (containers.length > 0) {
    await repository.bulkUpsert(workspaceId, containers);
    await refreshContainers(
      run,
      containers.map((container) => container.source.externalId),
    );
  }
  const gone = deletedIds(run, resource, deleted);
  if (gone.length > 0) {
    await repository.softDeleteBySource(workspaceId, accountOf(run), gone, run.now);
    // A deleted container must not be found by the items that follow.
    await refreshContainers(run, gone);
  }
}

/** One page's items: upserted (container ids, inherited topics), then the delete-only ones. */
async function storeItems(
  run: RunState,
  resource: string,
  mapped: readonly MappedItem[],
  deleted: readonly DeletedRecord[],
): Promise<void> {
  const workspaceId = run.integration.workspaceId;
  const repository = await getItemRepository();
  const live: ItemUpsert[] = [];
  const signalled: ItemUpsert[] = [];
  for (const item of mapped) {
    const skip = skipCode(run, resource, item.source, () => itemProblem(item));
    if (skip !== null) {
      recordFailure(run, item.source.externalId, skip);
      continue;
    }
    const container = await containerFor(run, item.containerExternalId);
    const upsert = toItemUpsert(run, resource, item, container);
    (upsert.deletedAt === null ? live : signalled).push(upsert);
  }
  if (live.length > 0) {
    const result = await repository.bulkUpsert(workspaceId, live);
    run.counts.inserted += result.inserted;
    run.counts.updated += result.updated;
    run.counts.unchanged += result.unchanged;
    run.counts.closed += result.closed;
  }
  if (signalled.length > 0) {
    // Whole records that carry their delete (`deletedAt`): written, counted as deleted; a copy
    // already deleted is unchanged and keeps its deletedAt.
    const result = await repository.bulkUpsert(workspaceId, signalled);
    run.counts.deleted += result.inserted + result.updated;
    run.counts.unchanged += result.unchanged;
  }
  const gone = deletedIds(run, resource, deleted);
  if (gone.length > 0) {
    const result = await repository.softDeleteBySource(workspaceId, accountOf(run), gone, run.now);
    run.counts.deleted += result.deleted;
    run.counts.unchanged += result.alreadyDeleted;
  }
}

/**
 * Stores one page of `resource`: containers first (upserts, then delete-only ones), then items
 * against them (upserts, then delete-only ones).
 */
async function storePage(run: RunState, resource: string, page: AdapterPage): Promise<void> {
  if (page.resource !== resource) throw new SyncRunError('adapter_error');
  const reported = page.failures ?? [];
  const deletedItems = page.deletedItems ?? [];
  run.counts.fetched += page.items.length + deletedItems.length + reported.length;
  for (const failure of reported) {
    recordFailure(run, failure.externalId, adapterFailureCode(failure.code));
  }
  await storeContainers(run, resource, page.containers, page.deletedContainers ?? []);
  await storeItems(run, resource, page.items, deletedItems);
}

/** A resource's window, checked: a field the sweep may be bounded by and valid dates, from < to. */
function checkedWindow(window: unknown): SweepWindow | null {
  if (window === undefined) return null;
  const { field, from, to } = (window ?? {}) as Partial<Record<keyof SweepWindow, unknown>>;
  const valid =
    (SWEEP_WINDOW_FIELDS as readonly unknown[]).includes(field) &&
    from instanceof Date &&
    to instanceof Date &&
    from.getTime() < to.getTime();
  if (!valid) throw new SyncRunError('adapter_error');
  return { field: field as SweepWindow['field'], from, to };
}

/**
 * After a full listing of `resource`: its items (inside the window, if any) and containers not
 * seen since the run started are deleted, except every record that failed in this run so far.
 * Containers carry no time field, so a windowed listing never sweeps them.
 */
async function sweepResource(
  run: RunState,
  resource: string,
  window: SweepWindow | null,
): Promise<void> {
  const { workspaceId, id: integrationId } = run.integration;
  const options = { deletedAt: run.now, keepExternalIds: [...run.failedIds] };
  run.counts.deleted += await (
    await getItemRepository()
  ).sweepUnseen(workspaceId, integrationId, resource, run.seenSince, {
    ...options,
    ...(window === null ? {} : { window }),
  });
  if (window !== null) return;
  const swept = await (
    await getContainerRepository()
  ).sweepUnseen(workspaceId, integrationId, resource, run.seenSince, options);
  // Swept containers must not be found by the items of later resources.
  if (swept > 0 && run.containers !== null) {
    const ofResource = [...run.containers]
      .filter(([, container]) => container.syncResource === resource)
      .map(([externalId]) => externalId);
    await refreshContainers(run, ofResource);
  }
}

/** Fetches and stores one resource, saves its next state, then sweeps it after a full listing. */
async function syncResource(
  run: RunState,
  adapter: ProviderAdapter,
  ctx: AdapterContext,
  resource: string,
): Promise<ResourceResult> {
  const { workspaceId, id: integrationId } = run.integration;
  const states = await getSyncStateRepository();
  const unidentifiedBefore = run.unidentifiedFailures;
  const pages = adapter.fetch(
    ctx,
    resource,
    await states.get(workspaceId, integrationId, resource),
  );
  let step = await pages.next();
  try {
    while (step.done !== true) {
      await storePage(run, resource, step.value);
      step = await pages.next();
    }
  } catch (error) {
    // Let the adapter's generator run its finally blocks; it may already be closed.
    await pages.return({ nextState: {}, fullSync: false }).catch(() => undefined);
    throw error;
  }
  const result = step.value;
  const window = checkedWindow(result.window);
  // Disconnected meanwhile: stop here (the run deletes again what it wrote, see finishing).
  if ((await (await getIntegrationRepository()).findByIdForWorker(integrationId)) === null) {
    throw new SyncRunError('integration_deleted');
  }
  await states.upsert(workspaceId, integrationId, resource, {
    ...result.nextState,
    ...(result.fullSync ? { lastFullSyncAt: run.now } : { lastIncrementalAt: run.now }),
  });
  if (!result.fullSync) return result;
  if (run.unidentifiedFailures > unidentifiedBefore) {
    // A record failed without an id: any unseen record of this resource may be that one.
    logger.warn('sync sweep skipped: a record failed without an id', {
      runId: run.runId,
      integrationId,
      resource,
    });
    return result;
  }
  await sweepResource(run, resource, window);
  return result;
}

/**
 * After a run in which every listed resource completed: the records of resources the adapter no
 * longer lists (a calendar removed from the config, say) are deleted, except every record that
 * failed in the run. A record that failed without an id may be one of them, so then nothing is.
 */
async function sweepOrphanedResources(run: RunState, resources: readonly string[]): Promise<void> {
  const { workspaceId, id: integrationId } = run.integration;
  if (run.unidentifiedFailures > 0) {
    logger.warn('sync orphan sweep skipped: a record failed without an id', {
      runId: run.runId,
      integrationId,
    });
    return;
  }
  const options = { deletedAt: run.now, keepExternalIds: [...run.failedIds] };
  run.counts.deleted += await (
    await getItemRepository()
  ).sweepOrphanedResources(workspaceId, integrationId, resources, options);
  await (
    await getContainerRepository()
  ).sweepOrphanedResources(workspaceId, integrationId, resources, options);
}

async function selectTransport(
  adapter: ProviderAdapter,
  mode: SyncMode,
  fixtureSet: string | undefined,
): Promise<Transport> {
  if (mode === 'live') return liveTransport();
  const set = fixtureSet ?? DEFAULT_FIXTURE_SET;
  if (!FIXTURE_SET_NAME.test(set)) throw new SyncRunError('fixtures_missing');
  const dir = join(adapter.fixturesDir ?? join(FIXTURES_ROOT, adapter.provider), set);
  try {
    return fixtureTransport(await loadFixtureSet(dir));
  } catch (error) {
    throw new SyncRunError('fixtures_missing', { cause: error });
  }
}

/**
 * Every resource, inside the secret's scope (each full one is swept as it completes), then the
 * records of resources no longer listed. Returns whether every resource listed in full: a
 * complete full sync.
 */
async function syncAll(
  run: RunState,
  opts: SyncRunOptions,
  mode: SyncMode,
  fullSyncDue: boolean,
): Promise<boolean> {
  const adapter = getAdapter(run.integration.provider);
  if (adapter === null) throw new SyncRunError('no_adapter');
  const chosen = opts.transport ?? (await selectTransport(adapter, mode, opts.fixtureSet));
  // A test that points at its provider stand-in: live OAuth syncs reach only that stand-in.
  const transport = mode === 'live' ? transportForIntegration(chosen, run.integration) : chosen;
  const resources = [...new Set(adapter.resources(run.integration))];
  // Names starting with `__` are the engine's (`__run__`).
  if (resources.some((resource) => resource.startsWith('__'))) {
    throw new SyncRunError('adapter_error');
  }

  const progress = { inSecretScope: false };
  let fullSyncCompleted: boolean;
  try {
    fullSyncCompleted = await withProviderSecret(run.integration, mode, async (secret) => {
      progress.inSecretScope = true;
      // One context for every resource of the run (the contract): adapters key run memory on it.
      const ctx: AdapterContext = {
        integration: run.integration,
        secret,
        client: adapter.createClient(transport, opts.clock),
        now: run.now,
        timeZone: run.workspace.settings.timezone,
        fullSyncDue,
      };
      const results: ResourceResult[] = [];
      for (const resource of resources) {
        results.push(await syncResource(run, adapter, ctx, resource));
      }
      return results.length > 0 && results.every((result) => result.fullSync);
    });
  } catch (error) {
    // Thrown before the callback ran: the vault could not produce the secret. A provider that
    // refused the OAuth refresh (the vault's refresh runs before the callback) is `auth_failed`:
    // the owner reconnects, and the dispatch stops sending the dead refresh token.
    if (!progress.inSecretScope) {
      if (error instanceof ProviderHttpError && error.code === 'auth_failed') throw error;
      throw new SyncRunError('credential_unavailable', { cause: error });
    }
    throw error;
  }
  // Every listed resource completed.
  await sweepOrphanedResources(run, resources);
  return fullSyncCompleted;
}

/** How a run opens: `running`, or at once `failed` (an integration that is not synced). */
type RunOpening = Required<Pick<SyncRunPatch, 'status'>> &
  Pick<SyncRunPatch, 'finishedAt' | 'counts' | 'error'>;

/**
 * Opens a new run, or the queued one named by `runId` (its counts, error and failures reset).
 * Null when that run is not this integration's.
 */
async function openRun(
  integration: IntegrationData,
  opts: SyncRunOptions,
  now: Date,
  opening: RunOpening,
): Promise<{ id: string; trigger: SyncTrigger } | null> {
  const runs = await getSyncRunRepository();
  const { workspaceId } = integration;
  const fields: SyncRunPatch = {
    startedAt: now,
    finishedAt: null,
    counts: {},
    error: null,
    failures: [],
    ...opening,
  };
  if (opts.runId !== undefined) {
    const queued = await runs.findById(workspaceId, opts.runId);
    if (queued?.integrationId !== integration.id) return null;
    await runs.update(workspaceId, queued.id, fields);
    return { id: queued.id, trigger: queued.trigger };
  }
  const created = await runs.create(workspaceId, {
    integrationId: integration.id,
    trigger: opts.trigger,
    status: opening.status,
    startedAt: now,
  });
  if (opening.status !== 'running') await runs.update(workspaceId, created.id, fields);
  return { id: created.id, trigger: created.trigger };
}

/** Codes of a run for an integration that waits for the user: it is not synced. */
const HELD_RUN_CODES: Partial<Record<IntegrationStatus, 'skipped_paused' | 'skipped_expired'>> = {
  paused: 'skipped_paused',
  expired: 'skipped_expired',
};

/**
 * A paused or expired integration is not synced: its run (new, or the queued one) ends `failed`
 * with `skipped_paused` / `skipped_expired`. Nothing else is written: no data, no status, no
 * failed-run count.
 */
async function skipHeldIntegration(
  integration: IntegrationData,
  opts: SyncRunOptions,
  now: Date,
  code: 'skipped_paused' | 'skipped_expired',
): Promise<SyncRunSummary> {
  const error = errorInfo(code);
  const counts = zeroCounts();
  const opened = await openRun(integration, opts, now, {
    status: 'failed',
    finishedAt: now,
    counts: { ...counts },
    error,
  });
  if (opened === null) return skippedRun();
  logger.info('sync skipped', { runId: opened.id, integrationId: integration.id, code });
  return { runId: opened.id, status: 'failed', counts, error };
}

/**
 * The integration is gone (disconnected, or its organization deleted): nothing is synced. A run
 * named by `runId` that is still `queued` or `running` ends `failed` with `integration_deleted`, so
 * it is never left open; one left `running` by a crash may have revived rows after the disconnect
 * deleted them, so they are deleted again. Anything else is a no-op (`skipped`).
 */
async function endRunOfGoneIntegration(
  integrationId: string,
  integration: IntegrationData | null,
  opts: SyncRunOptions,
  now: Date,
): Promise<SyncRunSummary> {
  if (opts.runId === undefined) return skippedRun();
  const found =
    integration ??
    (await (await getIntegrationRepository()).findIncludingDeletedForWorker(integrationId));
  if (found === null) return skippedRun();
  const { workspaceId } = found;
  const runs = await getSyncRunRepository();
  const named = await runs.findById(workspaceId, opts.runId);
  if (named?.integrationId !== integrationId) return skippedRun();
  const error = errorInfo('integration_deleted');
  const counts = zeroCounts();
  const ended = await runs.updateIfStatus(workspaceId, named.id, ['queued', 'running'], {
    status: 'failed',
    finishedAt: now,
    counts: { ...counts },
    error,
    failures: [],
  });
  if (ended === null) return skippedRun();
  if (named.status === 'running') {
    await (await getItemRepository()).softDeleteForIntegration(workspaceId, integrationId, now);
    await (
      await getContainerRepository()
    ).softDeleteForIntegration(workspaceId, integrationId, now);
  }
  logger.info('sync run ended: the integration is gone', { runId: named.id, integrationId });
  return { runId: named.id, status: 'failed', counts, error };
}

/** Codes that mean a bug in the engine or an adapter: logged as errors. */
const BUG_CODES: ReadonlySet<SyncErrorCode> = new Set([
  'internal',
  'adapter_error',
  'invalid_data',
]);

/** Ids and the code; the cause only for engine and unexpected errors (the logger redacts it). */
function logFailure(run: RunState, code: SyncErrorCode, thrown: unknown): void {
  const meta: Record<string, unknown> = {
    runId: run.runId,
    integrationId: run.integration.id,
    provider: run.integration.provider,
    code,
  };
  if (thrown instanceof ProviderHttpError) {
    meta['status'] = thrown.status;
  } else if (thrown instanceof SyncRunError) {
    if (thrown.cause !== undefined) meta['cause'] = thrown.cause;
  } else if (code === 'invalid_data') {
    // The refused value is provider data: log where it failed, never the value.
    const { name, path } = thrown as { name?: unknown; path?: unknown };
    meta['error'] = { name, path };
  } else {
    meta['error'] = thrown;
  }
  if (BUG_CODES.has(code)) logger.error('sync run failed', meta);
  else logger.warn('sync run failed', meta);
}

function errorInfo(code: SyncErrorCode): ErrorInfo {
  return { code, message: SYNC_ERROR_MESSAGES[code] };
}

/**
 * The integration was disconnected during the run. The disconnect soft-deleted its items and
 * containers, but this run may have written or revived some since: they are deleted again.
 */
async function deleteWritesOfDisconnected(run: RunState): Promise<void> {
  const { workspaceId, id: integrationId } = run.integration;
  await (await getItemRepository()).softDeleteForIntegration(workspaceId, integrationId, run.now);
  await (
    await getContainerRepository()
  ).softDeleteForIntegration(workspaceId, integrationId, run.now);
  logger.warn('sync run stopped: the integration was disconnected', {
    runId: run.runId,
    integrationId,
  });
}

interface RunOutcome {
  error: ErrorInfo | null;
  /** Every resource listed in full. */
  fullSyncCompleted: boolean;
  finishedAt: Date;
}

/**
 * The run's effect on its (still connected) integration: failed runs in a row and the last full
 * sync on `__run__`, then status, lastSyncAt and lastError. Status writes never overwrite a pause
 * or an expiry (recordSyncResult). A failed run counts once, however often its job is retried: one
 * atomic write counts it and remembers its id (countFailedRun), so a crash cannot count it twice
 * or lose it.
 */
async function recordOutcome(
  run: RunState,
  integration: IntegrationData,
  outcome: RunOutcome,
): Promise<void> {
  const { workspaceId, id: integrationId } = integration;
  const states = await getSyncStateRepository();
  const integrations = await getIntegrationRepository();
  const { error, finishedAt } = outcome;
  if (error === null) {
    await states.upsert(workspaceId, integrationId, RUN_STATE_RESOURCE, {
      consecutiveErrors: 0,
      ...(outcome.fullSyncCompleted ? { lastFullSyncAt: run.now } : {}),
    });
    await integrations.recordSyncResult(workspaceId, integrationId, {
      status: isExpiring(integration.expiresAt, finishedAt) ? 'expiring' : 'active',
      lastSyncAt: finishedAt,
      lastError: null,
    });
    return;
  }
  const failedRuns =
    (await states.countFailedRun(workspaceId, integrationId, RUN_STATE_RESOURCE, run.runId)) ??
    // Already counted (a retry of the same run): the count as it stands.
    (await states.get(workspaceId, integrationId, RUN_STATE_RESOURCE))?.consecutiveErrors ??
    0;
  const needsAttention = error.code === 'auth_failed' || failedRuns >= FAILED_RUNS_BEFORE_ERROR;
  await integrations.recordSyncResult(workspaceId, integrationId, {
    lastError: error,
    ...(needsAttention ? { status: 'error' as const } : {}),
  });
}

/** The run's clock: the time it runs at, and the wall clock when it opened. */
interface RunClock {
  now: Date;
  wallStart: number;
}

/** The run's finishing time on its own clock: its start time plus the time it took. */
function finishedAtOf(clock: RunClock): Date {
  return new Date(clock.now.getTime() + (Date.now() - clock.wallStart));
}

/**
 * The body of an opened run: fetch and store every resource, check for a disconnect, then record
 * the run, its outcome and the audit entry. `recorded.done` is set once the run's final status is
 * written.
 */
async function executeRun(
  integration: IntegrationData,
  workspace: WorkspaceData,
  started: { id: string; trigger: SyncTrigger },
  opts: SyncRunOptions,
  clock: RunClock,
  recorded: { done: boolean },
): Promise<SyncRunSummary> {
  const { workspaceId } = integration;
  const { now } = clock;
  const runState = await (
    await getSyncStateRepository()
  ).get(workspaceId, integration.id, RUN_STATE_RESOURCE);
  const mode: SyncMode = syncModeFor(integration, opts.mode);
  const run: RunState = {
    integration,
    workspace,
    runId: started.id,
    trigger: started.trigger,
    now,
    seenSince: await nextMillisecond(),
    counts: zeroCounts(),
    failures: [],
    failedIds: new Set(),
    unidentifiedFailures: 0,
    loggedInvalidFields: new Set(),
    containers: null,
  };

  let error: ErrorInfo | null = null;
  let fullSyncCompleted = false;
  try {
    fullSyncCompleted = await syncAll(run, opts, mode, isFullSyncDue(runState, now));
  } catch (thrown) {
    const code = errorCodeOf(thrown);
    error = errorInfo(code);
    logFailure(run, code, thrown);
  }

  // Disconnected while the run was in flight: what it wrote or revived is deleted again.
  const connected = await (await getIntegrationRepository()).findByIdForWorker(integration.id);
  if (connected === null) {
    await deleteWritesOfDisconnected(run);
    error = errorInfo('integration_deleted');
  }

  const finishedAt = finishedAtOf(clock);
  const status: SyncRunStatus =
    error !== null ? 'failed' : run.counts.failed > 0 ? 'partial' : 'succeeded';
  const counts = { ...run.counts };
  await (
    await getSyncRunRepository()
  ).update(workspaceId, run.runId, {
    status,
    finishedAt,
    counts,
    error,
    failures: run.failures,
  });
  recorded.done = true;

  if (connected !== null) {
    await recordOutcome(run, connected, { error, fullSyncCompleted, finishedAt });
  }

  await (
    await getAuditLogRepository()
  ).append(workspaceId, {
    actorUserId: 'system',
    action: 'sync.run',
    targetType: 'integration',
    targetId: integration.id,
    meta: { trigger: run.trigger, counts },
  });

  return { runId: run.runId, status, counts, error };
}

/**
 * A run that threw before its final write ends failed, so it is never left `running`. Best
 * effort: the database may be the reason it threw.
 */
async function abandonRun(
  integration: IntegrationData,
  runId: string,
  clock: RunClock,
  thrown: unknown,
): Promise<void> {
  const code = errorCodeOf(thrown);
  logger.error('sync run threw', { runId, integrationId: integration.id, code, error: thrown });
  try {
    await (
      await getSyncRunRepository()
    ).update(integration.workspaceId, runId, {
      status: 'failed',
      finishedAt: finishedAtOf(clock),
      error: errorInfo(code),
    });
  } catch (error) {
    logger.error('sync run could not be marked failed', {
      runId,
      integrationId: integration.id,
      error,
    });
  }
}

export async function runIntegrationSync(
  integrationId: string,
  opts: SyncRunOptions,
): Promise<SyncRunSummary> {
  const now = opts.now ?? new Date();
  const integration = await (await getIntegrationRepository()).findByIdForWorker(integrationId);
  const workspace =
    integration === null
      ? null
      : await (await getWorkspaceRepository()).findById(integration.workspaceId);
  if (integration === null || workspace === null) {
    return endRunOfGoneIntegration(integrationId, integration, opts, now);
  }

  const held = HELD_RUN_CODES[integration.status];
  if (held !== undefined) return skipHeldIntegration(integration, opts, now, held);

  const clock: RunClock = { now, wallStart: Date.now() };
  const started = await openRun(integration, opts, now, { status: 'running' });
  if (started === null) return skippedRun();
  const recorded = { done: false };
  try {
    return await executeRun(integration, workspace, started, opts, clock, recorded);
  } catch (thrown) {
    // Whatever threw, the run ends failed with finishedAt; the throw goes on to the caller.
    if (!recorded.done) await abandonRun(integration, started.id, clock, thrown);
    throw thrown;
  }
}
