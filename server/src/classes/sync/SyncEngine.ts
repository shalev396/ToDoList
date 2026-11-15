/**
 * The sync engine (BACKEND.md §5, DATA.md §4): the body of one sync of one integration, behind
 * Integration#sync (the template method), whoever started it: the sync worker (a background job,
 * sync/worker.ts) or the demo seed (seed/seedWorkspace.ts). One engine is one run (a method
 * object): it holds the run's counts, failures and container cache privately.
 *
 * 1. The integration is loaded with its workspace (Integration.runSync). Gone: nothing is synced,
 *    and a queued run named by `runId` ends `failed` with `integration_deleted` (never left
 *    `queued`). A paused or expired integration is not synced: its run ends `failed` with
 *    `skipped_paused` / `skipped_expired`. Otherwise its SyncRun starts (or the queued one named by
 *    `runId`).
 * 2. Transport: the adapter's recorded fixture set, the live network, or a test's.
 * 3. Inside the read session (sync/secrets.ts; fixtures: `{}`), for every resource of the adapter
 *    (the strategy): read its cursor (SyncCursors), then page by page upsert containers (topic
 *    rules) and items (container ids, inherited topics) through Container and Item, each hashed,
 *    stamped with the resource and bulk-upserted on its natural key; then store the next cursor.
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
 * reports is skipped and recorded (the run goes on). Anything thrown fails the run with a fixed
 * `{code, message}`, never provider text, and no run is left `running`. `auth_failed` (401/403)
 * sets the integration to `error` at once (reconnect); other failures do so after three failed
 * runs in a row, each run counted once however often its job is retried.
 */
import { Actor } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { AuditLog } from '../AuditLog.js';
import { sessionAuth, sessionTransport } from '../integration/definitions/index.js';
import { Container } from '../item/Container.js';
import { Item } from '../item/Item.js';
import { TopicRules } from '../workspace/TopicRules.js';
import type { ErrorInfo, SourceAccount, SourceRef } from '../../models/definitions/common.js';
import type { ContainerData, ContainerUpsert } from '../../models/definitions/Container.js';
import {
  isExpiring,
  type IntegrationData,
  type SyncResultPatch,
} from '../../models/definitions/Integration.js';
import {
  SWEEP_WINDOW_FIELDS,
  type ItemUpsert,
  type SweepWindow,
} from '../../models/definitions/Item.js';
import type { SyncRunFailure } from '../../models/definitions/SyncRun.js';
import type { WorkspaceData } from '../../models/definitions/Workspace.js';
import { logger } from '../../services/logger.js';
import { FixtureMissingError, ProviderHttpError } from '../../sync/errors.js';
import { DEFAULT_FIXTURE_SET, fixtureSetDir } from '../../sync/fixtureSets.js';
import { containerSourceHash, itemSourceHash } from '../../sync/hash.js';
import type { Clock, Transport } from '../../sync/http.js';
import { containerProblem, deletedRecordProblem, itemProblem } from '../../sync/recordCheck.js';
import { withProviderSecret } from '../../sync/secrets.js';
import { syncModeFor } from '../../sync/syncMode.js';
import { fixtureTransport, loadFixtureSet } from '../../sync/transports/fixtures.js';
import { liveTransport } from '../../sync/transports/live.js';
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
} from '../../sync/types.js';
import type { IntegrationStatus, SyncRunStatus, SyncTrigger } from '../../types/domain.js';
import type { SyncMode } from '../../types/env.d.ts';
import { SyncCursors } from './SyncCursors.js';
import { SyncRun } from './SyncRun.js';

/** Failed runs in a row before the integration goes to `error` (BACKEND.md §12). */
export const FAILED_RUNS_BEFORE_ERROR = 3;
/**
 * A full sync of every resource is due once the last complete one is this old. Under 24 h, so a
 * twice-daily schedule gets one every day despite timing jitter.
 */
export const FULL_SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Skipped records listed on a run; `counts.failed` has the total. */
export const MAX_RECORDED_FAILURES = 50;

const FIXTURE_SET_NAME = /^[A-Za-z0-9_-]+$/;

export interface SyncOptions {
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

/** A trigger, for a new run; or the id of a queued run (SyncRun.request), which has its own trigger. */
export type SyncRunOptions = SyncOptions &
  ({ trigger: SyncTrigger; runId?: never } | { runId: string; trigger?: never });

/**
 * What the engine needs of the integration it syncs. Integration#sync hands it over, its
 * protected members as functions: never the credential itself, only its read session.
 */
export interface SyncTarget {
  readonly data: IntegrationData;
  /** The provider's adapter (the strategy), or null when none is registered. */
  readonly adapter: ProviderAdapter | null;
  /** The integration as stored now (null: disconnected or gone): a fresh read. */
  reload(): Promise<IntegrationData | null>;
  /** The run's end on the integration (a pause or expiry set meanwhile wins). */
  recordSyncResult(result: SyncResultPatch): Promise<void>;
}

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

/** The run's clock: the time it runs at, and the wall clock when it opened. */
export interface RunClock {
  now: Date;
  wallStart: number;
}

function zeroCounts(): SyncCounts {
  return { fetched: 0, inserted: 0, updated: 0, unchanged: 0, closed: 0, deleted: 0, failed: 0 };
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

/** What an adapter's failure code must look like: short snake_case, never provider text. */
const FAILURE_CODE = /^[a-z][a-z0-9_]{1,40}$/;

/** An adapter-reported failure code, or `invalid_failure_code` when it is anything else. */
function adapterFailureCode(code: unknown): string {
  return typeof code === 'string' && FAILURE_CODE.test(code) ? code : 'invalid_failure_code';
}

/** The run's source: provider and account always come from the integration, never the adapter. */
function ownedSource(source: SourceRef, integration: IntegrationData): SourceRef {
  return { ...source, provider: integration.provider, accountId: integration.accountId };
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

/** Codes that mean a bug in the engine or an adapter: logged as errors. */
const BUG_CODES: ReadonlySet<SyncErrorCode> = new Set([
  'internal',
  'adapter_error',
  'invalid_data',
]);

/** Codes of a run for an integration that waits for the user: it is not synced. */
const HELD_RUN_CODES: Partial<Record<IntegrationStatus, 'skipped_paused' | 'skipped_expired'>> = {
  paused: 'skipped_paused',
  expired: 'skipped_expired',
};

/** The run's finishing time on its own clock: its start time plus the time it took. */
function finishedAtOf(clock: RunClock): Date {
  return new Date(clock.now.getTime() + (Date.now() - clock.wallStart));
}

async function selectTransport(
  adapter: ProviderAdapter,
  mode: SyncMode,
  fixtureSet: string | undefined,
): Promise<Transport> {
  if (mode === 'live') return liveTransport();
  const set = fixtureSet ?? DEFAULT_FIXTURE_SET;
  if (!FIXTURE_SET_NAME.test(set)) throw new SyncRunError('fixtures_missing');
  // src/sync/fixtures, or in the Lambda bundle the folder next to index.mjs (fixtureSets.ts).
  const dir = fixtureSetDir(adapter, set);
  try {
    return fixtureTransport(await loadFixtureSet(dir));
  } catch (error) {
    throw new SyncRunError('fixtures_missing', { cause: error });
  }
}

export class SyncEngine {
  readonly #target: SyncTarget;
  readonly #integration: IntegrationData;
  readonly #workspace: WorkspaceData;
  readonly #run: SyncRun;
  readonly #options: SyncRunOptions;
  readonly #clock: RunClock;
  readonly #cursors: SyncCursors;
  /** Wall clock when the run started fetching: rows not touched since then were not seen. */
  #seenSince = new Date(0);
  readonly #counts: SyncCounts = zeroCounts();
  /** The first MAX_RECORDED_FAILURES skipped records, stored on the run. */
  readonly #failures: SyncRunFailure[] = [];
  /** Every external id that failed in this run: never swept (a failure is not a deletion). */
  readonly #failedIds = new Set<string>();
  /** Failed records without an id: the resource they came from cannot be swept this run. */
  #unidentifiedFailures = 0;
  /** Invalid fields already logged in this run, as `<resource> <field>`: one warning each. */
  readonly #loggedInvalidFields = new Set<string>();
  /**
   * This integration's live containers by external id, loaded at the first lookup of the run
   * (null until then) and kept current by #refreshContainers().
   */
  #containers: Map<string, CachedContainer> | null = null;
  /** Set once the run's final status is written. */
  #recorded = false;

  constructor(
    target: SyncTarget,
    run: SyncRun,
    workspace: WorkspaceData,
    options: SyncRunOptions,
    clock: RunClock,
  ) {
    this.#target = target;
    this.#integration = target.data;
    this.#workspace = workspace;
    this.#run = run;
    this.#options = options;
    this.#clock = clock;
    this.#cursors = SyncCursors.of(target.data);
  }

  // ─── Opening a run (before the engine exists) ────────────────────────────

  /** Nothing ran: the integration or workspace is gone, or the run is not this integration's. */
  static skippedRun(): SyncRunSummary {
    return { runId: null, status: 'skipped', counts: zeroCounts(), error: null };
  }

  /** The hold of an integration that waits for its user (paused, expired), or null. */
  static holdOf(status: IntegrationStatus): 'skipped_paused' | 'skipped_expired' | null {
    return HELD_RUN_CODES[status] ?? null;
  }

  /**
   * A paused or expired integration is not synced: its run (new, or the queued one) ends `failed`
   * with `skipped_paused` / `skipped_expired`. Nothing else is written: no data, no status, no
   * failed-run count.
   */
  static async skipHeld(
    integration: IntegrationData,
    options: SyncRunOptions,
    now: Date,
    code: 'skipped_paused' | 'skipped_expired',
  ): Promise<SyncRunSummary> {
    const error = SyncRun.error(code);
    const counts = zeroCounts();
    let run: SyncRun | null;
    if (options.runId !== undefined) {
      run = await SyncRun.claim(integration, options.runId);
      await run?.skip(now, error, { ...counts });
    } else {
      run = await SyncRun.skipNew(integration, options.trigger, now, error, { ...counts });
    }
    if (run === null) return SyncEngine.skippedRun();
    logger.info('sync skipped', { runId: run.id, integrationId: integration.id, code });
    return { runId: run.id, status: 'failed', counts, error };
  }

  /**
   * Opens a new run, or the queued one named by `runId` (its counts, error and failures reset;
   * reopened when Lambda runs its job again). Null when that run is not this integration's.
   */
  static async openRun(
    integration: IntegrationData,
    options: SyncRunOptions,
    now: Date,
  ): Promise<SyncRun | null> {
    if (options.runId === undefined) return SyncRun.begin(integration, options.trigger, now);
    const run = await SyncRun.claim(integration, options.runId);
    if (run === null) return null;
    if (run.status === 'queued') await run.start(now);
    else await run.retry(now);
    return run;
  }

  /**
   * The integration is gone (disconnected, or its organization deleted): nothing is synced. A run
   * named by `runId` that is still `queued` or `running` ends `failed` with `integration_deleted`,
   * so it is never left open; one left `running` by a crash may have revived rows after the
   * disconnect deleted them, so they are deleted again. Anything else is a no-op (`skipped`).
   * `found` is the integration, deleted ones included (null: it never existed).
   */
  static async endRunOfGone(
    integrationId: string,
    found: IntegrationData | null,
    runId: string,
    now: Date,
  ): Promise<SyncRunSummary> {
    if (found === null) return SyncEngine.skippedRun();
    const run = await SyncRun.claim(found, runId);
    if (run === null) return SyncEngine.skippedRun();
    const wasRunning = run.status === 'running';
    const error = SyncRun.error('integration_deleted');
    const counts = zeroCounts();
    if (!(await run.cancel(error, now, { counts: { ...counts }, failures: [] }))) {
      return SyncEngine.skippedRun();
    }
    if (wasRunning) await SyncEngine.deleteWritesOf(found, now);
    logger.info('sync run ended: the integration is gone', { runId: run.id, integrationId });
    return { runId: run.id, status: 'failed', counts, error };
  }

  /**
   * What an integration's syncs wrote, soft-deleted again: it was disconnected while a run was in
   * flight (or a dead run's integration is gone), and the disconnect's delete may have been undone.
   */
  static async deleteWritesOf(
    integration: { readonly id: string; readonly workspaceId: string },
    at: Date,
  ): Promise<void> {
    await Item.softDeleteAllOf(integration.workspaceId, integration.id, at);
    await Container.softDeleteAllOf(integration.workspaceId, integration.id, at);
  }

  // ─── The run ─────────────────────────────────────────────────────────────

  /**
   * The body of an opened run: fetch and store every resource, check for a disconnect, then record
   * the run, its outcome and the audit entry.
   */
  async execute(): Promise<SyncRunSummary> {
    const integration = this.#integration;
    const { now } = this.#clock;
    const runState = await this.#cursors.run();
    const mode: SyncMode = syncModeFor(integration, this.#options.mode);
    this.#seenSince = await nextMillisecond();

    let error: ErrorInfo | null = null;
    let fullSyncCompleted = false;
    try {
      fullSyncCompleted = await this.#syncAll(
        mode,
        runState.isFullSyncDue(now, FULL_SYNC_INTERVAL_MS),
      );
    } catch (thrown) {
      const code = errorCodeOf(thrown);
      error = SyncRun.error(code);
      this.#logFailure(code, thrown);
    }

    // Disconnected while the run was in flight: what it wrote or revived is deleted again.
    const connected = await this.#target.reload();
    if (connected === null) {
      await this.#deleteWritesOfDisconnected();
      error = SyncRun.error('integration_deleted');
    }

    const finishedAt = finishedAtOf(this.#clock);
    const counts = { ...this.#counts };
    const results = { counts, failures: this.#failures };
    if (error !== null) await this.#run.fail(error, finishedAt, results);
    else await this.#run.succeed(results, { finishedAt, partial: this.#counts.failed > 0 });
    this.#recorded = true;
    const status: SyncRunStatus = this.#run.status;

    if (connected !== null) {
      await this.#recordOutcome(connected, { error, fullSyncCompleted, finishedAt });
    }

    await AuditLog.record(
      { workspaceId: integration.workspaceId, actor: Actor.system() },
      'sync.run',
      AuditTarget.integration(integration.id),
      { trigger: this.#run.trigger, counts },
    );

    return { runId: this.#run.id, status, counts, error };
  }

  /**
   * A run that threw before its final write ends failed, so it is never left `running`. Best
   * effort: the database may be the reason it threw.
   */
  async abandon(thrown: unknown): Promise<void> {
    if (this.#recorded) return;
    const runId = this.#run.id;
    const integrationId = this.#integration.id;
    const code = errorCodeOf(thrown);
    logger.error('sync run threw', { runId, integrationId, code, error: thrown });
    try {
      await this.#run.fail(SyncRun.error(code), finishedAtOf(this.#clock));
    } catch (error) {
      logger.error('sync run could not be marked failed', { runId, integrationId, error });
    }
  }

  /**
   * Every resource, inside the secret's scope (each full one is swept as it completes), then the
   * records of resources no longer listed. Returns whether every resource listed in full: a
   * complete full sync.
   */
  async #syncAll(mode: SyncMode, fullSyncDue: boolean): Promise<boolean> {
    const integration = this.#integration;
    const options = this.#options;
    const adapter = this.#target.adapter;
    if (adapter === null) throw new SyncRunError('no_adapter');
    const chosen = options.transport ?? (await selectTransport(adapter, mode, options.fixtureSet));
    // A test that points at its provider stand-in: live OAuth syncs reach only that stand-in.
    const transport = mode === 'live' ? sessionTransport(integration, chosen) : chosen;
    const resources = [...new Set(adapter.resources(integration))];
    // Names starting with `__` are the engine's (`__run__`).
    if (resources.some((resource) => resource.startsWith('__'))) {
      throw new SyncRunError('adapter_error');
    }

    const progress = { inSecretScope: false };
    let fullSyncCompleted: boolean;
    try {
      fullSyncCompleted = await withProviderSecret(integration, mode, async (secret) => {
        progress.inSecretScope = true;
        // One context for every resource of the run (the contract): adapters key run memory on it.
        const client = adapter.createClient(transport, options.clock);
        const now = this.#clock.now;
        const ctx: AdapterContext = {
          integration,
          // The headers come from the integration's auth strategy, never from the adapter.
          auth: sessionAuth(integration, secret, client, now),
          client,
          now,
          timeZone: this.#workspace.settings.timezone,
          fullSyncDue,
        };
        const results: ResourceResult[] = [];
        for (const resource of resources) {
          results.push(await this.#syncResource(adapter, ctx, resource));
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
    await this.#sweepOrphanedResources(resources);
    return fullSyncCompleted;
  }

  /** Fetches and stores one resource, saves its next cursor, then sweeps it after a full listing. */
  async #syncResource(
    adapter: ProviderAdapter,
    ctx: AdapterContext,
    resource: string,
  ): Promise<ResourceResult> {
    const integrationId = this.#integration.id;
    const unidentifiedBefore = this.#unidentifiedFailures;
    const pages = adapter.fetch(ctx, resource, (await this.#cursors.get(resource)).toState());
    let step = await pages.next();
    try {
      while (step.done !== true) {
        await this.#storePage(resource, step.value);
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
    if ((await this.#target.reload()) === null) {
      throw new SyncRunError('integration_deleted');
    }
    const now = this.#clock.now;
    await this.#cursors.save(resource, {
      ...result.nextState,
      ...(result.fullSync ? { lastFullSyncAt: now } : { lastIncrementalAt: now }),
    });
    if (!result.fullSync) return result;
    if (this.#unidentifiedFailures > unidentifiedBefore) {
      // A record failed without an id: any unseen record of this resource may be that one.
      logger.warn('sync sweep skipped: a record failed without an id', {
        runId: this.#run.id,
        integrationId,
        resource,
      });
      return result;
    }
    await this.#sweepResource(resource, window);
    return result;
  }

  /**
   * Stores one page of `resource`: containers first (upserts, then delete-only ones), then items
   * against them (upserts, then delete-only ones).
   */
  async #storePage(resource: string, page: AdapterPage): Promise<void> {
    if (page.resource !== resource) throw new SyncRunError('adapter_error');
    const reported = page.failures ?? [];
    const deletedItems = page.deletedItems ?? [];
    this.#counts.fetched += page.items.length + deletedItems.length + reported.length;
    for (const failure of reported) {
      this.#recordFailure(failure.externalId, adapterFailureCode(failure.code));
    }
    await this.#storeContainers(resource, page.containers, page.deletedContainers ?? []);
    await this.#storeItems(resource, page.items, deletedItems);
  }

  /** One page's containers: upserted (topic rules), then the delete-only ones. */
  async #storeContainers(
    resource: string,
    mapped: readonly MappedContainer[],
    deleted: readonly DeletedRecord[],
  ): Promise<void> {
    const workspaceId = this.#integration.workspaceId;
    const containers: ContainerUpsert[] = [];
    for (const container of mapped) {
      const skip = this.#skipCode(resource, container.source, () => containerProblem(container));
      if (skip === null) containers.push(this.#toContainerUpsert(resource, container));
      else this.#recordFailure(container.source.externalId, skip);
    }
    if (containers.length > 0) {
      await Container.upsertSynced(workspaceId, containers);
      await this.#refreshContainers(containers.map((container) => container.source.externalId));
    }
    const gone = this.#deletedIds(resource, deleted);
    if (gone.length > 0) {
      await Container.deleteSynced(workspaceId, this.#account, gone, this.#clock.now);
      // A deleted container must not be found by the items that follow.
      await this.#refreshContainers(gone);
    }
  }

  /** One page's items: upserted (container ids, inherited topics), then the delete-only ones. */
  async #storeItems(
    resource: string,
    mapped: readonly MappedItem[],
    deleted: readonly DeletedRecord[],
  ): Promise<void> {
    const workspaceId = this.#integration.workspaceId;
    const counts = this.#counts;
    const live: ItemUpsert[] = [];
    const signalled: ItemUpsert[] = [];
    for (const item of mapped) {
      const skip = this.#skipCode(resource, item.source, () => itemProblem(item));
      if (skip !== null) {
        this.#recordFailure(item.source.externalId, skip);
        continue;
      }
      const container = await this.#containerFor(item.containerExternalId);
      const upsert = this.#toItemUpsert(resource, item, container);
      (upsert.deletedAt === null ? live : signalled).push(upsert);
    }
    if (live.length > 0) {
      const result = await Item.upsertSynced(workspaceId, live);
      counts.inserted += result.inserted;
      counts.updated += result.updated;
      counts.unchanged += result.unchanged;
      counts.closed += result.closed;
    }
    if (signalled.length > 0) {
      // Whole records that carry their delete (`deletedAt`): written, counted as deleted; a copy
      // already deleted is unchanged and keeps its deletedAt.
      const result = await Item.upsertSynced(workspaceId, signalled);
      counts.deleted += result.inserted + result.updated;
      counts.unchanged += result.unchanged;
    }
    const gone = this.#deletedIds(resource, deleted);
    if (gone.length > 0) {
      const result = await Item.deleteSynced(workspaceId, this.#account, gone, this.#clock.now);
      counts.deleted += result.deleted;
      counts.unchanged += result.alreadyDeleted;
    }
  }

  /**
   * After a full listing of `resource`: its items (inside the window, if any) and containers not
   * seen since the run started are deleted, except every record that failed in this run so far.
   * Containers carry no time field, so a windowed listing never sweeps them.
   */
  async #sweepResource(resource: string, window: SweepWindow | null): Promise<void> {
    const { workspaceId, id: integrationId } = this.#integration;
    const options = { deletedAt: this.#clock.now, keepExternalIds: [...this.#failedIds] };
    this.#counts.deleted += await Item.sweepUnseen(
      workspaceId,
      integrationId,
      resource,
      this.#seenSince,
      { ...options, ...(window === null ? {} : { window }) },
    );
    if (window !== null) return;
    const swept = await Container.sweepUnseen(
      workspaceId,
      integrationId,
      resource,
      this.#seenSince,
      options,
    );
    // Swept containers must not be found by the items of later resources.
    if (swept > 0 && this.#containers !== null) {
      const ofResource = [...this.#containers]
        .filter(([, container]) => container.syncResource === resource)
        .map(([externalId]) => externalId);
      await this.#refreshContainers(ofResource);
    }
  }

  /**
   * After a run in which every listed resource completed: the records of resources the adapter no
   * longer lists (a calendar removed from the config, say) are deleted, except every record that
   * failed in the run. A record that failed without an id may be one of them, so then nothing is.
   */
  async #sweepOrphanedResources(resources: readonly string[]): Promise<void> {
    const { workspaceId, id: integrationId } = this.#integration;
    if (this.#unidentifiedFailures > 0) {
      logger.warn('sync orphan sweep skipped: a record failed without an id', {
        runId: this.#run.id,
        integrationId,
      });
      return;
    }
    const options = { deletedAt: this.#clock.now, keepExternalIds: [...this.#failedIds] };
    this.#counts.deleted += await Item.sweepOrphanedResources(
      workspaceId,
      integrationId,
      resources,
      options,
    );
    await Container.sweepOrphanedResources(workspaceId, integrationId, resources, options);
  }

  /**
   * The integration was disconnected during the run. The disconnect soft-deleted its items and
   * containers, but this run may have written or revived some since: they are deleted again.
   */
  async #deleteWritesOfDisconnected(): Promise<void> {
    await SyncEngine.deleteWritesOf(this.#integration, this.#clock.now);
    logger.warn('sync run stopped: the integration was disconnected', {
      runId: this.#run.id,
      integrationId: this.#integration.id,
    });
  }

  /**
   * The run's effect on its (still connected) integration: failed runs in a row and the last full
   * sync on `__run__`, then status, lastSyncAt and lastError. Status writes never overwrite a pause
   * or an expiry (recordSyncResult). A failed run counts once, however often its job is retried: one
   * atomic write counts it and remembers its id (countFailedRun), so a crash cannot count it twice
   * or lose it.
   */
  async #recordOutcome(
    integration: IntegrationData,
    outcome: { error: ErrorInfo | null; fullSyncCompleted: boolean; finishedAt: Date },
  ): Promise<void> {
    const { error, finishedAt } = outcome;
    if (error === null) {
      await this.#cursors.saveRun({
        consecutiveErrors: 0,
        ...(outcome.fullSyncCompleted ? { lastFullSyncAt: this.#clock.now } : {}),
      });
      await this.#target.recordSyncResult({
        status: isExpiring(integration.expiresAt, finishedAt) ? 'expiring' : 'active',
        lastSyncAt: finishedAt,
        lastError: null,
      });
      return;
    }
    const failedRuns = await this.#cursors.countFailedRun(this.#run.id);
    const needsAttention = error.code === 'auth_failed' || failedRuns >= FAILED_RUNS_BEFORE_ERROR;
    await this.#target.recordSyncResult({
      lastError: error,
      ...(needsAttention ? { status: 'error' as const } : {}),
    });
  }

  // ─── Records ─────────────────────────────────────────────────────────────

  /**
   * The provider account the run's records belong to (the engine's, never the adapter's), as this
   * integration's copy: another member's integration of the same account keeps its own.
   */
  get #account(): SourceAccount {
    const integration = this.#integration;
    return {
      provider: integration.provider,
      accountId: integration.accountId,
      integrationId: integration.id,
    };
  }

  /** A record failed validation: its field is logged by name (never its value), once per run. */
  #invalidRecord(resource: string, field: string): 'invalid_record' {
    const logged = `${resource} ${field}`;
    if (!this.#loggedInvalidFields.has(logged)) {
      this.#loggedInvalidFields.add(logged);
      logger.warn('sync record skipped: invalid field', {
        runId: this.#run.id,
        integrationId: this.#integration.id,
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
  #skipCode(resource: string, source: SourceRef, invalidField: () => string | null): string | null {
    const missing = sourceProblem(source);
    if (missing !== null) return missing;
    const field = invalidField();
    return field === null ? null : this.#invalidRecord(resource, field);
  }

  /** The ids of the valid delete-only records; the others are recorded as failures. */
  #deletedIds(resource: string, records: readonly DeletedRecord[]): string[] {
    const ids: string[] = [];
    for (const record of records) {
      const { externalId } = record;
      if (typeof externalId !== 'string' || externalId === '') {
        this.#recordFailure(externalId, 'missing_id');
        continue;
      }
      const field = deletedRecordProblem(record);
      if (field === null) ids.push(externalId);
      else this.#recordFailure(externalId, this.#invalidRecord(resource, field));
    }
    return ids;
  }

  /** Counts a skipped record, keeps its id out of the sweeps, and records the first 50. */
  #recordFailure(externalId: unknown, code: string): void {
    const id = typeof externalId === 'string' ? externalId : '';
    this.#counts.failed += 1;
    if (id === '') this.#unidentifiedFailures += 1;
    else this.#failedIds.add(id);
    if (this.#failures.length < MAX_RECORDED_FAILURES) {
      this.#failures.push({ externalId: id, code });
    }
  }

  #toContainerUpsert(resource: string, mapped: MappedContainer): ContainerUpsert {
    const integration = this.#integration;
    const upsert: ContainerUpsert = {
      integrationId: integration.id,
      topicId:
        mapped.topicId !== undefined
          ? mapped.topicId
          : TopicRules.of(this.#workspace.settings.topicRules).classify({
              matchKey: mapped.matchKey ?? mapped.name,
              defaultTopicId: TopicRules.defaultFor(integration),
            }),
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

  #toItemUpsert(
    resource: string,
    mapped: MappedItem,
    container: CachedContainer | null,
  ): ItemUpsert {
    const integration = this.#integration;
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
            : TopicRules.defaultFor(integration),
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

  // ─── The container cache ─────────────────────────────────────────────────

  /** This integration's live containers, all of them or only the given external ids. */
  async #loadContainers(externalIds?: readonly string[]): Promise<Map<string, CachedContainer>> {
    const { workspaceId, id } = this.#integration;
    const list = await Container.listSynced(workspaceId, id, externalIds);
    return new Map(
      list.map(({ id: containerId, topicId, syncResource, source }) => [
        source.externalId,
        { id: containerId, topicId, syncResource },
      ]),
    );
  }

  /** An item's container, by its external id, from the run's cache (loaded once per run). */
  async #containerFor(externalId: string | null | undefined): Promise<CachedContainer | null> {
    if (externalId === undefined || externalId === null || externalId === '') return null;
    this.#containers ??= await this.#loadContainers();
    return this.#containers.get(externalId) ?? null;
  }

  /**
   * After containers were written or swept: looks up only those external ids again, so the cache
   * gains new ones, follows changes (a topic) and drops deleted ones. Nothing to do before the
   * cache is loaded: the first lookup reads every container.
   */
  async #refreshContainers(externalIds: readonly string[]): Promise<void> {
    const cache = this.#containers;
    if (cache === null || externalIds.length === 0) return;
    const fresh = await this.#loadContainers(externalIds);
    for (const externalId of externalIds) {
      const container = fresh.get(externalId);
      if (container === undefined) cache.delete(externalId);
      else cache.set(externalId, container);
    }
  }

  // ─── Logging ─────────────────────────────────────────────────────────────

  /** Ids and the code; the cause only for engine and unexpected errors (the logger redacts it). */
  #logFailure(code: SyncErrorCode, thrown: unknown): void {
    const integration = this.#integration;
    const meta: Record<string, unknown> = {
      runId: this.#run.id,
      integrationId: integration.id,
      provider: integration.provider,
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
}
