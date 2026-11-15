/**
 * One sync of one integration (DATA.md §3.9): a provider sync run by the engine (Integration#sync),
 * or a Google Calendar push. `SyncRun` is the only code that reads or writes runs.
 *
 * A run is a state machine. Its status changes only through the transitions below, each a method,
 * and only through the private `#status` setter, which refuses any edge the machine doesn't have
 * (IllegalSyncRunTransitionError: a programming error, never a user's).
 *
 * | Transition                       | From                                  | To                    |
 * | -------------------------------- | ------------------------------------- | --------------------- |
 * | `SyncRun.queue` (created)        | —                                     | queued                |
 * | `SyncRun.begin` (created)        | —                                     | running               |
 * | `SyncRun.skipNew` (created)      | —                                     | failed                |
 * | `start`                          | queued                                | running               |
 * | `retry` (its job run again)      | running, succeeded, partial, failed   | running               |
 * | `skip` (a held integration)      | queued, running, succeeded, partial, failed | failed          |
 * | `succeed`                        | running                               | succeeded, partial    |
 * | `fail`                           | queued, running                       | failed                |
 * | `cancel` (conditional)           | queued, running                       | failed                |
 *
 * - `retry` and `skip` from a finished run exist because Lambda runs a job again (twice) after it
 *   throws: the job reopens the run it names, whatever that run's status, as it always has.
 * - `cancel` is one conditional write (`updateIfStatus`): it ends a run only while its stored
 *   status is still open (queued or running), so a run that finished meanwhile keeps its own
 *   outcome. A run never returns to `queued`, so for a run known to be running this is "while
 *   still running".
 * - Every other write is unconditional, exactly as before.
 */
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { ErrorInfo } from '../../models/definitions/common.js';
import type {
  SyncRunData,
  SyncRunFailure,
  SyncRunPatch,
} from '../../models/definitions/SyncRun.js';
import { getSyncRunRepository } from '../../models/index.js';
import { startSyncRunJob } from '../../services/syncJobs.js';
import { syncModeFor } from '../../sync/syncMode.js';
import type { SyncErrorCode } from '../../sync/types.js';
import type { AuthMethod, SyncRunStatus, SyncTrigger } from '../../types/domain.js';
import type { SyncRunView } from '../../types/integrations.js';

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

/** The integration a run belongs to: what a run needs of it. */
export interface SyncRunOwner {
  readonly id: string;
  readonly workspaceId: string;
}

/** What queueing a background sync needs of its integration (an Integration has it all). */
export interface SyncRequestTarget extends SyncRunOwner {
  readonly ownerUserId: string;
  /** Demo data: a FAKE credential, never synced. */
  readonly demo: boolean;
  /** How it connects: an OAuth one always syncs live (syncModeFor). */
  readonly authMethod: AuthMethod;
}

/** A run's transitions (the table in the header). */
export type SyncRunTransition = 'start' | 'retry' | 'skip' | 'succeed' | 'fail' | 'cancel';

const ANY_STARTED: readonly SyncRunStatus[] = ['running', 'succeeded', 'partial', 'failed'];
const OPEN: readonly SyncRunStatus[] = ['queued', 'running'];

/** Each transition: the statuses it leaves and the ones it may reach. */
export const SYNC_RUN_TRANSITIONS: Readonly<
  Record<SyncRunTransition, { from: readonly SyncRunStatus[]; to: readonly SyncRunStatus[] }>
> = Object.freeze({
  start: { from: ['queued'], to: ['running'] },
  retry: { from: ANY_STARTED, to: ['running'] },
  skip: { from: ['queued', ...ANY_STARTED], to: ['failed'] },
  succeed: { from: ['running'], to: ['succeeded', 'partial'] },
  fail: { from: OPEN, to: ['failed'] },
  cancel: { from: OPEN, to: ['failed'] },
});

/** A transition the machine doesn't have: a programming error (a 500 if it ever reached a user). */
export class IllegalSyncRunTransitionError extends Error {
  constructor(from: SyncRunStatus, to: SyncRunStatus, transition?: SyncRunTransition) {
    super(`A sync run cannot ${transition ?? 'go'} ${from} → ${to}`);
    this.name = 'IllegalSyncRunTransitionError';
  }
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const COUNT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** A code and its fixed message. A code the engine doesn't know keeps the generic message. */
function sanitizedError(error: ErrorInfo): { code: string; message: string } {
  if (!ERROR_CODE.test(error.code)) {
    return { code: 'internal', message: SYNC_ERROR_MESSAGES.internal };
  }
  const message = Object.hasOwn(SYNC_ERROR_MESSAGES, error.code)
    ? SYNC_ERROR_MESSAGES[error.code as SyncErrorCode]
    : SYNC_ERROR_MESSAGES.internal;
  return { code: error.code, message };
}

/** What a finished run stores of its records: its counts, and the records it skipped. */
export interface SyncRunResults {
  counts: Record<string, number>;
  failures?: SyncRunFailure[];
}

export class SyncRun
  extends WorkspaceEntity<SyncRunData>
  implements Auditable, Viewable<SyncRunView>
{
  /** The run as stored now: the loaded row, then each write's answer. */
  #current: Readonly<SyncRunData>;
  #state: SyncRunStatus;

  private constructor(data: SyncRunData) {
    super(data);
    this.#current = Object.freeze({ ...data });
    this.#state = data.status;
  }

  /** A run's error as it is stored and shown: its code and the code's fixed message. */
  static error(code: SyncErrorCode): ErrorInfo {
    return { code, message: SYNC_ERROR_MESSAGES[code] };
  }

  // ─── Created ─────────────────────────────────────────────────────────────

  /** A run queued for a background job (enqueue: "Sync now", the dispatcher, MCP). */
  static async queue(owner: SyncRunOwner, trigger: SyncTrigger): Promise<SyncRun> {
    const created = await (
      await getSyncRunRepository()
    ).create(owner.workspaceId, { integrationId: owner.id, trigger, status: 'queued' });
    return new SyncRun(created);
  }

  /** A run that starts now (a sync with a trigger, a calendar push). */
  static async begin(owner: SyncRunOwner, trigger: SyncTrigger, startedAt: Date): Promise<SyncRun> {
    const created = await (
      await getSyncRunRepository()
    ).create(owner.workspaceId, {
      integrationId: owner.id,
      trigger,
      status: 'running',
      startedAt,
    });
    return new SyncRun(created);
  }

  /**
   * A run of an integration that is not synced (paused, expired): created already `failed` with
   * `error`, its counts zero (`counts`), finished at `at`.
   */
  static async skipNew(
    owner: SyncRunOwner,
    trigger: SyncTrigger,
    at: Date,
    error: ErrorInfo,
    counts: Record<string, number>,
  ): Promise<SyncRun> {
    const runs = await getSyncRunRepository();
    const created = await runs.create(owner.workspaceId, {
      integrationId: owner.id,
      trigger,
      status: 'failed',
      startedAt: at,
    });
    const run = new SyncRun(created);
    await run.#write(SyncRun.#skipped(at, error, counts));
    return run;
  }

  /**
   * Queues one background sync of `integration` and starts its job; the queued run, whose id the
   * caller polls. `caller` (null: the system, the dispatcher) must be its owner, in its workspace
   * (404 otherwise; the caller has already checked, this is the second line). Never for demo data,
   * whose credential is FAKE (the dispatcher and "Sync now" skip it first). When the job cannot be
   * started (the invoke failed), the run ends `failed` with `enqueue_failed` and this throws.
   */
  static async request(
    caller: Caller | null,
    integration: SyncRequestTarget,
    trigger: SyncTrigger,
  ): Promise<SyncRun> {
    if (
      caller !== null &&
      (caller.workspaceId !== integration.workspaceId || caller.userId !== integration.ownerUserId)
    ) {
      throw new NotFoundError();
    }
    if (integration.demo) throw new Error('SyncRun.request: a demo integration never syncs');
    const run = await SyncRun.queue(integration, trigger);
    const mode = syncModeFor(integration);
    try {
      await startSyncRunJob({ integrationId: integration.id, runId: run.id, mode });
    } catch (error) {
      await run.fail(SyncRun.error('enqueue_failed'), new Date());
      throw error;
    }
    return run;
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /** A run of the workspace by id (null when missing). */
  static async find(workspaceId: string, id: string): Promise<SyncRun | null> {
    const data = await (await getSyncRunRepository()).findById(workspaceId, id);
    return data === null ? null : new SyncRun(data);
  }

  /** The run named by a job, when it is `owner`'s (null otherwise: another integration's, or none). */
  static async claim(owner: SyncRunOwner, runId: string): Promise<SyncRun | null> {
    const run = await SyncRun.find(owner.workspaceId, runId);
    return run?.integrationId === owner.id ? run : null;
  }

  /** The newest runs of one integration, newest first. */
  static async listFor(owner: SyncRunOwner, limit: number): Promise<SyncRun[]> {
    return (
      await (await getSyncRunRepository()).listForIntegration(owner.workspaceId, owner.id, limit)
    ).map((data) => new SyncRun(data));
  }

  /**
   * The newest runs of the caller's integrations here, newest first, at most `limit`. The caller
   * has checked they may see each one (Integration.listOwn, Integration.findOwn).
   */
  static async list(
    caller: Caller,
    owners: readonly SyncRunOwner[],
    limit: number,
  ): Promise<SyncRun[]> {
    const runs: SyncRun[] = [];
    for (const owner of owners) {
      if (owner.workspaceId !== caller.workspaceId) continue;
      runs.push(...(await SyncRun.listFor(owner, limit)));
    }
    return runs
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  /** One run of the caller's workspace by id; 404 when missing. Whose it is, the caller checks. */
  static async get(caller: Caller, runId: string): Promise<SyncRun> {
    const run = await SyncRun.find(caller.workspaceId, runId);
    if (run === null) throw new NotFoundError();
    return run;
  }

  /**
   * GLOBAL, every workspace: the runs still `running` that started before `before`, oldest first,
   * at most `limit` (the purge's reaper only).
   */
  static async listRunningStartedBefore(before: Date, limit: number): Promise<SyncRun[]> {
    return (await (await getSyncRunRepository()).listRunningStartedBefore(before, limit)).map(
      (data) => new SyncRun(data),
    );
  }

  /**
   * The reaper: every run still `running` `staleAfterMs` after it started is dead (its job timed
   * out): ended `failed` with `timeout`, unless it finished meanwhile (cancel). At most `limit`
   * per call; returns the runs it ended.
   */
  static async reapStuck(now: Date, staleAfterMs: number, limit: number): Promise<SyncRun[]> {
    const stale = await SyncRun.listRunningStartedBefore(
      new Date(now.getTime() - staleAfterMs),
      limit,
    );
    const reaped: SyncRun[] = [];
    for (const run of stale) {
      if (await run.cancel(SyncRun.error('timeout'), now)) reaped.push(run);
    }
    return reaped;
  }

  // ─── What a run is ───────────────────────────────────────────────────────

  get status(): SyncRunStatus {
    return this.#state;
  }

  /** The status, changed only along the machine's edges. */
  set #status(next: SyncRunStatus) {
    const allowed = Object.values(SYNC_RUN_TRANSITIONS).some(
      ({ from, to }) => from.includes(this.#state) && to.includes(next),
    );
    if (!allowed) throw new IllegalSyncRunTransitionError(this.#state, next);
    this.#state = next;
  }

  get integrationId(): string {
    return this.#current.integrationId;
  }

  get trigger(): SyncTrigger {
    return this.#current.trigger;
  }

  get startedAt(): Date {
    return this.#current.startedAt;
  }

  get finishedAt(): Date | null {
    return this.#current.finishedAt;
  }

  get counts(): Readonly<Record<string, number>> {
    return this.#current.counts;
  }

  get error(): Readonly<ErrorInfo> | null {
    return this.#current.error;
  }

  get createdAt(): Date {
    return this.#current.createdAt;
  }

  get isOpen(): boolean {
    return OPEN.includes(this.#state);
  }

  /** Whether it has finished (succeeded, partial or failed). */
  get isFinished(): boolean {
    return !this.isOpen;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('sync_run', this.id);
  }

  override toJSON(): SyncRunData {
    return structuredClone({ ...this.#current, status: this.#state });
  }

  /**
   * What the API, the UI and MCP show, field by field: counts are named numbers; an error is a
   * code and its fixed message; the failed records never leave the server.
   */
  toView(): SyncRunView {
    const run = this.#current;
    const counts: Record<string, number> = {};
    for (const [name, value] of Object.entries(run.counts)) {
      if (COUNT_NAME.test(name) && Number.isFinite(value)) counts[name] = value;
    }
    return {
      id: run.id,
      integrationId: run.integrationId,
      trigger: run.trigger,
      status: this.#state,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      counts,
      error: run.error === null ? null : sanitizedError(run.error),
    };
  }

  // ─── Transitions ─────────────────────────────────────────────────────────

  /** queued → running: the job's first run (counts, error and failures reset). */
  async start(at: Date): Promise<void> {
    this.#check('start', 'running');
    await this.#write({ ...SyncRun.#reopened(at), status: 'running' });
    this.#status = 'running';
  }

  /** A started run → running again: Lambda runs its job again (counts, error and failures reset). */
  async retry(at: Date): Promise<void> {
    this.#check('retry', 'running');
    await this.#write({ ...SyncRun.#reopened(at), status: 'running' });
    this.#status = 'running';
  }

  /**
   * → failed, at once: its integration is not synced (paused, expired). Reopened with `error`, its
   * counts zero (`counts`), finished at `at`.
   */
  async skip(at: Date, error: ErrorInfo, counts: Record<string, number>): Promise<void> {
    this.#check('skip', 'failed');
    await this.#write(SyncRun.#skipped(at, error, counts));
    this.#status = 'failed';
  }

  /**
   * running → succeeded, or `partial` when some records were skipped or some steps failed: its
   * counts, and the records it skipped when it keeps them (the engine).
   */
  async succeed(
    results: SyncRunResults,
    outcome: { finishedAt: Date; partial: boolean },
  ): Promise<void> {
    const status = outcome.partial ? 'partial' : 'succeeded';
    this.#check('succeed', status);
    await this.#write({
      status,
      finishedAt: outcome.finishedAt,
      counts: results.counts,
      ...(results.failures === undefined ? {} : { error: null, failures: results.failures }),
    });
    this.#status = status;
  }

  /**
   * queued or running → failed with `error`: its job could not be started (queued), or it failed
   * while running; with its counts and skipped records when it has them.
   */
  async fail(error: ErrorInfo, finishedAt: Date, results?: SyncRunResults): Promise<void> {
    this.#check('fail', 'failed');
    await this.#write({
      status: 'failed',
      finishedAt,
      ...(results === undefined
        ? {}
        : { counts: results.counts, ...(results.failures ? { failures: results.failures } : {}) }),
      error,
    });
    this.#status = 'failed';
  }

  /**
   * queued or running → failed with `error`, only while it is still open (one conditional write):
   * its integration is gone, its job timed out, or its push failed. The stored status decides, not
   * the one this object was loaded with (a job run again may have reopened it meanwhile). False
   * when it is not open (it keeps its own outcome).
   */
  async cancel(error: ErrorInfo, finishedAt: Date, results?: SyncRunResults): Promise<boolean> {
    const ended = await (
      await getSyncRunRepository()
    ).updateIfStatus(this.workspaceId, this.id, SYNC_RUN_TRANSITIONS.cancel.from, {
      status: 'failed',
      finishedAt,
      ...(results === undefined
        ? {}
        : { counts: results.counts, ...(results.failures ? { failures: results.failures } : {}) }),
      error,
    });
    if (ended === null) return false;
    this.#current = Object.freeze({ ...ended });
    this.#status = 'failed';
    return true;
  }

  /** Refuses a transition from the current status, or to a status it doesn't reach. */
  #check(transition: SyncRunTransition, to: SyncRunStatus): void {
    const rule = SYNC_RUN_TRANSITIONS[transition];
    if (!rule.from.includes(this.#state) || !rule.to.includes(to)) {
      throw new IllegalSyncRunTransitionError(this.#state, to, transition);
    }
  }

  /** One unconditional write; the run as stored after it. */
  async #write(patch: SyncRunPatch): Promise<void> {
    const updated = await (await getSyncRunRepository()).update(this.workspaceId, this.id, patch);
    if (updated !== null) this.#current = Object.freeze({ ...updated });
  }

  /** A run opened (again): what a run starts from. */
  static #reopened(at: Date): SyncRunPatch {
    return { startedAt: at, finishedAt: null, counts: {}, error: null, failures: [] };
  }

  /** A run that ends as it opens: not synced. */
  static #skipped(at: Date, error: ErrorInfo, counts: Record<string, number>): SyncRunPatch {
    return { ...SyncRun.#reopened(at), status: 'failed', finishedAt: at, counts, error };
  }
}
