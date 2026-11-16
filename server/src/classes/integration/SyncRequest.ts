/**
 * "Sync now" for one integration (Integration#requestSync and Integration.requestSyncAll's
 * collaborator): whether it waits for its owner (as the dispatcher sees it), how long until a
 * manual sync is allowed again, and queueing the run; `requestAll` does it for each of a
 * caller's integrations.
 */
import type { Caller } from '../base/Caller.js';
import { SyncRun, type SyncRunOwner } from '../sync/SyncRun.js';
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { logger } from '../../services/logger.js';

/** Why an integration can't be synced now. */
export type SyncHold = 'demo' | 'paused' | 'expired' | 'reconnect' | 'no_credential';

/** What a sync request needs of the integration (its credential check is Integration's). */
export interface SyncSubject {
  readonly data: IntegrationData;
  /** The integration whose runs are read. */
  readonly target: SyncRunOwner;
  /** Queues its manual run for `caller` (Integration.requestRun): the run's id. */
  requestRun(caller: Caller): Promise<string>;
  readonly usesFixtures: boolean;
  hasCredential(): Promise<boolean>;
}

/** Runs looked at for the newest manual one: far more than 5 minutes can hold. */
const RECENT_RUNS = 20;

export class SyncRequest {
  /** The refusal of an integration that waits for its owner. */
  static readonly HOLD_MESSAGES: Readonly<Record<SyncHold, string>> = Object.freeze({
    demo: 'Demo data never syncs: its items are a sample',
    paused: 'This integration is paused: save its credential again to resume',
    expired: 'This connection has expired: save a new credential',
    reconnect: 'Reconnect required: save the credential again',
    no_credential: 'Save the credential first',
  });

  readonly #subject: SyncSubject;

  constructor(subject: SyncSubject) {
    this.#subject = subject;
  }

  /** What waits for the owner, as the dispatcher sees it; live mode also needs a credential. */
  async hold(): Promise<SyncHold | null> {
    const { data, usesFixtures } = this.#subject;
    if (data.demo) return 'demo';
    if (data.status === 'paused') return 'paused';
    if (data.status === 'expired') return 'expired';
    if (data.lastError?.code === 'auth_failed') return 'reconnect';
    if (!usesFixtures && !(await this.#subject.hasCredential())) return 'no_credential';
    return null;
  }

  /** How long until the integration may be synced manually again (0: now). */
  async manualWait(): Promise<number> {
    const runs = await SyncRun.listFor(this.#subject.target, RECENT_RUNS);
    const newestManual = runs
      .filter((run) => run.trigger === 'manual')
      .reduce<number>((newest, run) => Math.max(newest, run.createdAt.getTime()), 0);
    if (newestManual === 0) return 0;
    return Math.max(0, newestManual + LIMITS.manualSyncIntervalMs - Date.now());
  }

  /**
   * "Sync now" for every integration the caller owns here and can sync (Integration.requestSyncAll
   * hands over each one's subject). Those waiting for them or synced manually less than the
   * interval ago are skipped. 503 only when nothing could be queued because the queue failed.
   */
  static async requestAll(
    caller: Caller,
    subjects: readonly SyncSubject[],
  ): Promise<{ runIds: string[] }> {
    const runIds: string[] = [];
    let queueFailures = 0;
    for (const subject of subjects) {
      const request = new SyncRequest(subject);
      if ((await request.hold()) !== null) continue;
      if ((await request.manualWait()) > 0) continue;
      try {
        runIds.push(await request.enqueue(caller));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        queueFailures += 1;
      }
    }
    if (runIds.length === 0 && queueFailures > 0) {
      throw new AppError(503, 'Could not queue the sync. Try again later.');
    }
    return { runIds };
  }

  /**
   * Queues the manual run for its owner (Integration.requestRun). A failure to start it (on Lambda,
   * the async invoke of the function itself) is not the request's: 503, the detail in the log.
   */
  async enqueue(caller: Caller): Promise<string> {
    const integrationId = this.#subject.data.id;
    try {
      return await this.#subject.requestRun(caller);
    } catch (error) {
      logger.error('could not queue a manual sync', { integrationId, error });
      throw new AppError(503, 'Could not queue the sync. Try again later.');
    }
  }
}
