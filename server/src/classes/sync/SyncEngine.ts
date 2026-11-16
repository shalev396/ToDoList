/**
 * The sync engine (BACKEND.md §5, DATA.md §4): the body of one sync of one integration, behind
 * Integration#sync (the template method), whoever started it: the sync worker (a background job,
 * sync/worker.ts) or the demo seed (seed/seedWorkspace.ts). One engine is one run (a method
 * object). Its collaborators: the run's accounting (SyncTally), its store (SyncStore.ts: its
 * cursors and rows, SyncedRows being internal) and their container cache (ContainerCache), the
 * pure record rules (syncRecords.ts). A run stores to the database as it goes; a batch of fixture
 * replays of integrations that never synced stores in memory and writes every run at once
 * (`executeTogether`, FreshReplay), with the same outcome.
 *
 * Internal to the sync: a private constructor behind two static doors (`execute`,
 * `executeTogether`), not in any barrel, and an importer test (syncInternals.test.ts) holds that
 * only Integration loads it. The
 * provider's adapter (the strategy) is resolved here from the integration's provider, never
 * handed in; a test transport is taken in live mode only under node:test.
 *
 * 1. The integration and its workspace were loaded and its run opened (Integration#sync).
 * 2. Transport: the adapter's recorded fixture set, the live network, or a test's.
 * 3. Inside the read session (sync/secrets.ts; fixtures: `{}`), for every resource of the adapter:
 *    read its cursor (SyncCursors), then page by page upsert containers (topic rules) and items
 *    (container ids, inherited topics), each hashed, stamped with the resource and bulk-upserted
 *    on its natural key; then store the next cursor.
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
import { AuditLog, type AuditEntry } from '../AuditLog.js';
import { sessionAuth, sessionTransport } from '../integration/definitions/index.js';
import { assertUnderTest } from '../../config/testSwitches.js';
import type { ErrorInfo, SourceAccount } from '../../models/definitions/common.js';
import type { ContainerUpsert } from '../../models/definitions/Container.js';
import {
  isExpiring,
  type IntegrationData,
  type SyncResultPatch,
} from '../../models/definitions/Integration.js';
import type { ItemUpsert, SweepWindow } from '../../models/definitions/Item.js';
import type { SyncRunFailure } from '../../models/definitions/SyncRun.js';
import type { SyncStatePatch, SyncStateUpsert } from '../../models/definitions/SyncState.js';
import type { WorkspaceData } from '../../models/definitions/Workspace.js';
import { logger } from '../../services/logger.js';
import { FixtureMissingError, ProviderHttpError } from '../../sync/errors.js';
import { DEFAULT_FIXTURE_SET, fixtureSetDir } from '../../sync/fixtureSets.js';
import type { Transport } from '../../sync/http.js';
import '../../sync/providers/index.js';
import { containerProblem, itemProblem } from '../../sync/recordCheck.js';
import { getAdapter } from '../../sync/registry.js';
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
import type { SyncMode } from '../../types/env.d.ts';
import { settleAll } from '../../utils/concurrency.js';
import { ContainerCache } from './ContainerCache.js';
import { FreshReplay, NotReplayableError } from './FreshReplay.js';
import { SyncCursors } from './SyncCursors.js';
import { SyncedRows } from './SyncedRows.js';
import type { RunClock, SyncRunOptions } from './SyncOptions.js';
import type { RunCursors, RunRows, RunStore } from './SyncStore.js';
import {
  adapterFailureCode,
  checkedWindow,
  SyncRunError,
  toContainerUpsert,
  toItemUpsert,
} from './syncRecords.js';
import { SyncRun } from './SyncRun.js';
import { SyncTally } from './SyncTally.js';

/** Failed runs in a row before the integration goes to `error` (BACKEND.md §12). */
export const FAILED_RUNS_BEFORE_ERROR = 3;
/**
 * A full sync of every resource is due once the last complete one is this old. Under 24 h, so a
 * twice-daily schedule gets one every day despite timing jitter.
 */
export const FULL_SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000;

const FIXTURE_SET_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * What the engine needs of the integration it syncs. Integration#sync hands it over, its own
 * writes as functions: never the credential itself (only its read session, by id), never an
 * adapter.
 */
export interface SyncTarget {
  readonly data: IntegrationData;
  /** The integration as stored now (null: disconnected or gone): a fresh read. */
  reload(): Promise<IntegrationData | null>;
  /** The run's end on the integration (a pause or expiry set meanwhile wins). */
  recordSyncResult(result: SyncResultPatch): Promise<void>;
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

/** Codes that mean a bug in the engine or an adapter: logged as errors. */
const BUG_CODES: ReadonlySet<SyncErrorCode> = new Set([
  'internal',
  'adapter_error',
  'invalid_data',
]);

/** How a run's fetching and storing ended, before it is finished. */
interface RunOutcome {
  error: ErrorInfo | null;
  /** Every resource listed in full: a complete full sync. */
  fullSyncCompleted: boolean;
}

/** One run of a batch (executeTogether): its integration, its opened run, how it syncs. */
export interface BatchRun {
  target: SyncTarget;
  run: SyncRun;
  options: SyncRunOptions;
  clock: RunClock;
}

/** What a batch needs of its integrations as a whole (Integration.syncTogether). */
export interface BatchTarget {
  /** The integrations of these ids still connected (a fresh read), by id. */
  reloadAll(ids: readonly string[]): Promise<Map<string, IntegrationData>>;
  /** recordSyncResult of each integration, at once. */
  recordSyncResults(results: readonly { id: string; result: SyncResultPatch }[]): Promise<void>;
}

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
  /** Where the run fetches and stores to: the database, or a batch's replay. */
  readonly #store: RunStore;
  readonly #cursors: RunCursors;
  readonly #rows: RunRows;
  readonly #containers: ContainerCache;
  readonly #tally: SyncTally;
  /** Wall clock when the run started fetching: rows not touched since then were not seen. */
  #seenSince = new Date(0);
  /** Set once the run's final status is written. */
  #recorded = false;

  private constructor(
    target: SyncTarget,
    run: SyncRun,
    workspace: WorkspaceData,
    options: SyncRunOptions,
    clock: RunClock,
    store: RunStore,
  ) {
    this.#target = target;
    this.#integration = target.data;
    this.#workspace = workspace;
    this.#run = run;
    this.#options = options;
    this.#clock = clock;
    this.#store = store;
    this.#cursors = store.cursors;
    this.#rows = store.rows;
    this.#containers = new ContainerCache(store.rows);
    this.#tally = new SyncTally(run.id, target.data.id);
  }

  /** The integration's own cursors and rows, in the database, each write as it happens. */
  static #databaseStore(target: SyncTarget): RunStore {
    return {
      cursors: SyncCursors.of(target.data),
      rows: SyncedRows.of(target.data),
      reload: () => target.reload(),
    };
  }

  /**
   * One opened run of `target` (Integration#sync): fetch and store every resource, check for a
   * disconnect, then record the run, its outcome and the audit entry. A throw before the final
   * write ends the run failed (never left `running`) and goes on to the caller.
   */
  static async execute(
    target: SyncTarget,
    run: SyncRun,
    workspace: WorkspaceData,
    options: SyncRunOptions,
    clock: RunClock,
  ): Promise<SyncRunSummary> {
    const store = SyncEngine.#databaseStore(target);
    const engine = new SyncEngine(target, run, workspace, options, clock, store);
    try {
      return await engine.#finish(await engine.#sync(), store);
    } catch (thrown) {
      await engine.#abandon(thrown);
      throw thrown;
    }
  }

  /**
   * Opened runs of several integrations of one workspace at once (Integration.syncTogether: the
   * demo seed's fixture replays), each with the outcome `execute` would give it, in a handful of
   * round trips instead of dozens per run:
   * 1. whether any of the integrations has a stored item or container, their stored cursors and
   *    which of them are still connected are read at once;
   * 2. when none has rows (none ever synced), every run fetches and stores in memory
   *    (FreshReplay), all at once, from those cursors. A run whose integration is no longer
   *    connected writes nothing, and finishes as `execute` would (`integration_deleted`);
   * 3. the containers and items of every run are bulk-upserted at once, then their cursors (with
   *    the `__run__` state of each run that succeeded);
   * 4. the runs that succeeded end at once: their runs, their integrations' status, then their
   *    `sync.run` audit entries. A run that failed finishes on its own, as `execute` does.
   * When an integration has rows, every run syncs with `execute` instead; so does a run the replay
   * refuses (NotReplayableError: the database would have answered it otherwise). Whichever step
   * throws, every run still open then ends `failed`, as `execute` ends its run: none is left
   * `running`. Answers in the order of `runs`.
   */
  static async executeTogether(
    runs: readonly BatchRun[],
    workspace: WorkspaceData,
    batch: BatchTarget,
  ): Promise<SyncRunSummary[]> {
    if (runs.some(({ target }) => target.data.workspaceId !== workspace.id)) {
      throw new Error('SyncEngine.executeTogether: the runs of one workspace at a time');
    }
    try {
      return await SyncEngine.#together(runs, workspace, batch);
    } catch (thrown) {
      await SyncEngine.#abandonAll(runs, workspace.id, thrown);
      throw thrown;
    }
  }

  /** executeTogether's steps (see there); whatever throws, the caller ends the open runs. */
  static async #together(
    runs: readonly BatchRun[],
    workspace: WorkspaceData,
    batch: BatchTarget,
  ): Promise<SyncRunSummary[]> {
    const workspaceId = workspace.id;
    const alone = (entry: BatchRun): Promise<SyncRunSummary> =>
      SyncEngine.execute(entry.target, entry.run, workspace, entry.options, entry.clock);
    const ids = runs.map(({ target }) => target.data.id);
    // Whether any of them has rows, their stored cursors, and which are still connected: at once.
    const [hasRows, states, connected] = await settleAll([
      SyncedRows.anyOf(workspaceId, ids),
      SyncCursors.listOf(workspaceId, ids),
      batch.reloadAll(ids),
    ] as const);
    if (hasRows) return settleAll(runs.map(alone));

    const engines = runs.map((entry) => {
      const replay = new FreshReplay(entry.target.data, states.get(entry.target.data.id) ?? []);
      const { target, run, options, clock } = entry;
      return {
        entry,
        replay,
        engine: new SyncEngine(target, run, workspace, options, clock, replay),
      };
    });
    const settled = await Promise.allSettled(engines.map(({ engine }) => engine.#sync()));
    const thrown = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && !(result.reason instanceof NotReplayableError),
    );
    // Nothing is written yet.
    if (thrown !== undefined) throw thrown.reason;
    const replayed = engines.flatMap((replaying, index) => {
      const result = settled[index];
      return result?.status === 'fulfilled' ? [{ ...replaying, outcome: result.value }] : [];
    });

    const kept = replayed.filter(({ entry }) => connected.has(entry.target.data.id));
    const succeeded = kept.flatMap((replaying) => {
      const integration = connected.get(replaying.entry.target.data.id);
      if (replaying.outcome.error !== null || integration === undefined) return [];
      const finishedAt = finishedAtOf(replaying.entry.clock);
      const ending = replaying.engine.#success(replaying.outcome, integration, finishedAt);
      return [{ ...replaying, integration, finishedAt, ending }];
    });
    await SyncEngine.#writeReplays(
      workspaceId,
      kept.map(({ replay }) => replay),
      succeeded.map(({ integration, ending }) => ({
        integrationId: integration.id,
        resource: SyncCursors.RUN,
        patch: ending.cursor,
      })),
    );

    // The runs, their integrations' status and their audit entries: at once.
    await settleAll([
      SyncRun.succeedAll(
        succeeded.map(({ engine, finishedAt }) => ({
          run: engine.#run,
          results: engine.#results(),
          outcome: { finishedAt, partial: engine.#tally.anyFailed },
        })),
      ),
      batch.recordSyncResults(
        succeeded.map(({ integration, ending }) => ({ id: integration.id, result: ending.result })),
      ),
      AuditLog.recordAll(
        { workspaceId, actor: Actor.system() },
        succeeded.map(({ engine }) => engine.#auditEntry()),
      ),
    ] as const);
    for (const { engine } of succeeded) engine.#recorded = true;

    const finished = new Set(succeeded.map(({ engine }) => engine));
    // A run that failed, or whose integration is gone, finishes on its own in the database; one
    // the replay refused syncs there.
    return settleAll(
      engines.map(async ({ entry, engine }, index) => {
        if (finished.has(engine)) return engine.#summary(null);
        const result = settled[index];
        if (result?.status !== 'fulfilled') return alone(entry);
        return engine.#finish(result.value, SyncEngine.#databaseStore(entry.target));
      }),
    );
  }

  /**
   * A batch threw: every run of it still open (none it recorded, whichever step failed) ends
   * `failed` with the code of what was thrown, as `execute` ends its run, so none is left
   * `running`. One conditional write: a run that finished meanwhile keeps its outcome. Best
   * effort: the database may be the reason it threw.
   */
  static async #abandonAll(
    runs: readonly BatchRun[],
    workspaceId: string,
    thrown: unknown,
  ): Promise<void> {
    const code = errorCodeOf(thrown);
    const open = runs.filter(({ run }) => run.isOpen);
    logger.error('sync batch threw', {
      runIds: open.map(({ run }) => run.id),
      code,
      error: thrown,
    });
    try {
      await SyncRun.cancelAll(
        workspaceId,
        open.map(({ run, clock }) => ({
          id: run.id,
          error: SyncRun.error(code),
          finishedAt: finishedAtOf(clock),
        })),
      );
    } catch (error) {
      logger.error('sync batch runs could not be marked failed', { workspaceId, error });
    }
  }

  /**
   * What the replays wrote, in the database: their containers and items in one bulk upsert each,
   * then their cursors with `runStates` (the `__run__` state of each run that succeeded). Every
   * row must be new (the batch checked that none was stored).
   */
  static async #writeReplays(
    workspaceId: string,
    replays: readonly FreshReplay[],
    runStates: readonly SyncStateUpsert[],
  ): Promise<void> {
    const containers = replays.flatMap((replay) => replay.writtenContainers);
    const items = replays.flatMap((replay) => replay.writtenItems);
    // None is stored (checked before the replay): nothing to read first, and each must insert.
    const written = await SyncedRows.upsertAll(workspaceId, containers, items, {
      assumeNew: true,
    });
    if (
      written.containers.inserted !== containers.length ||
      written.items.inserted !== items.length
    ) {
      throw new Error('SyncEngine.executeTogether: rows were stored while the batch replayed');
    }
    await SyncCursors.saveAll(workspaceId, [
      ...replays.flatMap((replay) => replay.savedCursors),
      ...runStates,
    ]);
  }

  /** Fetches and stores every resource; how that ended (a failure is the run's error, no throw). */
  async #sync(): Promise<RunOutcome> {
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
      // A replay's refusal is no run error: the batch syncs that run in the database instead.
      if (thrown instanceof NotReplayableError) throw thrown;
      const code = errorCodeOf(thrown);
      error = SyncRun.error(code);
      this.#logFailure(code, thrown);
    }
    return { error, fullSyncCompleted };
  }

  /**
   * After fetching and storing, in the database (`store`): a check for a disconnect, then the
   * run, its outcome and the audit entry.
   */
  async #finish(outcome: RunOutcome, store: RunStore): Promise<SyncRunSummary> {
    let { error } = outcome;
    // Disconnected while the run was in flight: what it wrote or revived is deleted again.
    const connected = await this.#target.reload();
    if (connected === null) {
      await this.#deleteWritesOfDisconnected(store.rows);
      error = SyncRun.error('integration_deleted');
    }

    const finishedAt = finishedAtOf(this.#clock);
    const results = this.#results();
    if (error !== null) await this.#run.fail(error, finishedAt, results);
    else await this.#run.succeed(results, { finishedAt, partial: this.#tally.anyFailed });
    this.#recorded = true;

    if (connected !== null) {
      await this.#recordOutcome(connected, { ...outcome, error }, finishedAt, store.cursors);
    }

    const { action, target, meta } = this.#auditEntry();
    await AuditLog.record(
      { workspaceId: this.#integration.workspaceId, actor: Actor.system() },
      action,
      target,
      meta,
    );
    return this.#summary(error);
  }

  /** What the run stores of its records: its counts (an object literal, by name), its failures. */
  #results(): { counts: Record<string, number>; failures: SyncRunFailure[] } {
    return { counts: { ...this.#tally.counts }, failures: this.#tally.failures };
  }

  /** The run's `sync.run` audit entry: its trigger and its counts. */
  #auditEntry(): AuditEntry {
    return {
      action: 'sync.run',
      target: AuditTarget.integration(this.#integration.id),
      meta: { trigger: this.#run.trigger, counts: { ...this.#tally.counts } },
    };
  }

  /** What the run answers once it is recorded. */
  #summary(error: ErrorInfo | null): SyncRunSummary {
    const counts: SyncCounts = { ...this.#tally.counts };
    return { runId: this.#run.id, status: this.#run.status, counts, error };
  }

  /**
   * A run that threw before its final write ends failed, so it is never left `running`. Best
   * effort: the database may be the reason it threw.
   */
  async #abandon(thrown: unknown): Promise<void> {
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
    // The provider's own adapter, from the registry: never one handed in.
    const adapter = getAdapter(integration.provider);
    if (adapter === null) throw new SyncRunError('no_adapter');
    // A live run reaches its provider only: a test may stand in for it, nothing else.
    if (mode === 'live' && options.transport !== undefined) {
      assertUnderTest('a live sync over a test transport');
    }
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
    const unidentifiedBefore = this.#tally.unidentified;
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
    if ((await this.#store.reload()) === null) {
      throw new SyncRunError('integration_deleted');
    }
    const now = this.#clock.now;
    await this.#cursors.save(resource, {
      ...result.nextState,
      ...(result.fullSync ? { lastFullSyncAt: now } : { lastIncrementalAt: now }),
    });
    if (!result.fullSync) return result;
    if (this.#tally.unidentified > unidentifiedBefore) {
      // A record failed without an id: any unseen record of this resource may be that one.
      logger.warn('sync sweep skipped: a record failed without an id', {
        runId: this.#run.id,
        integrationId: this.#integration.id,
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
    this.#tally.fetched(page.items.length + deletedItems.length + reported.length);
    for (const failure of reported) {
      this.#tally.recordFailure(failure.externalId, adapterFailureCode(failure.code));
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
    const tally = this.#tally;
    const topicRules = this.#workspace.settings.topicRules;
    const containers: ContainerUpsert[] = [];
    for (const container of mapped) {
      const skip = tally.skipCode(resource, container.source, () => containerProblem(container));
      if (skip === null) {
        containers.push(toContainerUpsert(this.#integration, topicRules, resource, container));
      } else {
        tally.recordFailure(container.source.externalId, skip);
      }
    }
    if (containers.length > 0) {
      await this.#rows.upsertContainers(containers);
      await this.#containers.refresh(containers.map((container) => container.source.externalId));
    }
    const gone = tally.deletedIds(resource, deleted);
    if (gone.length > 0) {
      await this.#rows.deleteContainers(this.#account, gone, this.#clock.now);
      // A deleted container must not be found by the items that follow.
      await this.#containers.refresh(gone);
    }
  }

  /** One page's items: upserted (container ids, inherited topics), then the delete-only ones. */
  async #storeItems(
    resource: string,
    mapped: readonly MappedItem[],
    deleted: readonly DeletedRecord[],
  ): Promise<void> {
    const tally = this.#tally;
    const live: ItemUpsert[] = [];
    const signalled: ItemUpsert[] = [];
    for (const item of mapped) {
      const skip = tally.skipCode(resource, item.source, () => itemProblem(item));
      if (skip !== null) {
        tally.recordFailure(item.source.externalId, skip);
        continue;
      }
      const container = await this.#containers.find(item.containerExternalId);
      const upsert = toItemUpsert(this.#integration, resource, item, container);
      (upsert.deletedAt === null ? live : signalled).push(upsert);
    }
    if (live.length > 0) tally.upserted(await this.#rows.upsertItems(live));
    if (signalled.length > 0) {
      // Whole records that carry their delete (`deletedAt`): written, counted as deleted; a copy
      // already deleted is unchanged and keeps its deletedAt.
      tally.signalled(await this.#rows.upsertItems(signalled));
    }
    const gone = tally.deletedIds(resource, deleted);
    if (gone.length > 0) {
      tally.sourceDeleted(await this.#rows.deleteItems(this.#account, gone, this.#clock.now));
    }
  }

  /**
   * After a full listing of `resource`: its items (inside the window, if any) and containers not
   * seen since the run started are deleted, except every record that failed in this run so far.
   * Containers carry no time field, so a windowed listing never sweeps them.
   */
  async #sweepResource(resource: string, window: SweepWindow | null): Promise<void> {
    const options = { deletedAt: this.#clock.now, keepExternalIds: this.#tally.keptExternalIds() };
    this.#tally.swept(
      await this.#rows.sweepItems(resource, this.#seenSince, {
        ...options,
        ...(window === null ? {} : { window }),
      }),
    );
    if (window !== null) return;
    const swept = await this.#rows.sweepContainers(resource, this.#seenSince, options);
    // Swept containers must not be found by the items of later resources.
    if (swept > 0) await this.#containers.refreshResource(resource);
  }

  /**
   * After a run in which every listed resource completed: the records of resources the adapter no
   * longer lists (a calendar removed from the config, say) are deleted, except every record that
   * failed in the run. A record that failed without an id may be one of them, so then nothing is.
   */
  async #sweepOrphanedResources(resources: readonly string[]): Promise<void> {
    if (this.#tally.unidentified > 0) {
      logger.warn('sync orphan sweep skipped: a record failed without an id', {
        runId: this.#run.id,
        integrationId: this.#integration.id,
      });
      return;
    }
    const options = { deletedAt: this.#clock.now, keepExternalIds: this.#tally.keptExternalIds() };
    this.#tally.swept(await this.#rows.sweepOrphanedItems(resources, options));
    await this.#rows.sweepOrphanedContainers(resources, options);
  }

  /**
   * The integration was disconnected during the run. The disconnect soft-deleted its items and
   * containers, but this run may have written or revived some since: they are deleted again.
   */
  async #deleteWritesOfDisconnected(rows: RunRows): Promise<void> {
    await rows.softDeleteAll(this.#clock.now);
    logger.warn('sync run stopped: the integration was disconnected', {
      runId: this.#run.id,
      integrationId: this.#integration.id,
    });
  }

  /**
   * What a run that succeeded writes on its (still connected) integration: its `__run__` state (no
   * failed runs in a row; the last full sync, when it was one) and its status, lastSyncAt and
   * lastError.
   */
  #success(
    outcome: RunOutcome,
    integration: IntegrationData,
    finishedAt: Date,
  ): { cursor: SyncStatePatch; result: SyncResultPatch } {
    return {
      cursor: {
        consecutiveErrors: 0,
        ...(outcome.fullSyncCompleted ? { lastFullSyncAt: this.#clock.now } : {}),
      },
      result: {
        status: isExpiring(integration.expiresAt, finishedAt) ? 'expiring' : 'active',
        lastSyncAt: finishedAt,
        lastError: null,
      },
    };
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
    outcome: RunOutcome,
    finishedAt: Date,
    cursors: RunCursors,
  ): Promise<void> {
    const { error } = outcome;
    if (error === null) {
      const { cursor, result } = this.#success(outcome, integration, finishedAt);
      await cursors.saveRun(cursor);
      await this.#target.recordSyncResult(result);
      return;
    }
    const failedRuns = await cursors.countFailedRun(this.#run.id);
    const needsAttention = error.code === 'auth_failed' || failedRuns >= FAILED_RUNS_BEFORE_ERROR;
    await this.#target.recordSyncResult({
      lastError: error,
      ...(needsAttention ? { status: 'error' as const } : {}),
    });
  }

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
