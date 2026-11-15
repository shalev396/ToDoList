/**
 * "Sync now" for one integration (Integration#requestSync and Integration.requestSyncAll's
 * collaborator): whether it waits for its owner (as the dispatcher sees it), how long until a
 * manual sync is allowed again, and queueing the run.
 */
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getSyncRunRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import { enqueueSync } from '../../services/syncJobs.js';

/** Why an integration can't be synced now. */
export type SyncHold = 'demo' | 'paused' | 'expired' | 'reconnect' | 'no_credential';

/** What a sync request needs of the integration (its credential check is Integration's). */
export interface SyncSubject {
  readonly data: IntegrationData;
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
    const { data } = this.#subject;
    const runs = await (
      await getSyncRunRepository()
    ).listForIntegration(data.workspaceId, data.id, RECENT_RUNS);
    const newestManual = runs
      .filter((run) => run.trigger === 'manual')
      .reduce<number>((newest, run) => Math.max(newest, run.createdAt.getTime()), 0);
    if (newestManual === 0) return 0;
    return Math.max(0, newestManual + LIMITS.manualSyncIntervalMs - Date.now());
  }

  /**
   * Queues the manual run. A failure to start it (on Lambda, the async invoke of the function
   * itself) is not the request's: 503, the detail in the log.
   */
  async enqueue(): Promise<string> {
    const integrationId = this.#subject.data.id;
    try {
      return (await enqueueSync(integrationId, 'manual')).runId;
    } catch (error) {
      logger.error('could not queue a manual sync', { integrationId, error });
      throw new AppError(503, 'Could not queue the sync. Try again later.');
    }
  }
}
