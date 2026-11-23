/**
 * The daily clean-up, run by the hourly tick after the sync dispatch: in the tick of
 * PURGE_HOUR_UTC (once a day, on every stage) it runs the purge (jobs/purge.ts) and answers its
 * counts; every other tick it does nothing and answers none. So the stack's one EventBridge rule
 * (infra/lib/constructs/schedule.ts) stays its only schedule.
 *
 * A tick that misses the purge hour (EventBridge gave up on it) leaves the purge for the next day:
 * every rule it applies is "older than", so a late run removes the same rows, one day later.
 */
import { PURGE_HOUR_UTC } from '../../infra/lib/constants.js';
import { logger } from '../services/logger.js';
import { purgeDeleted, type PurgeResult } from './purge.js';
import type { AfterDispatchPass } from './scheduledTick.js';

export class PurgePass implements AfterDispatchPass {
  readonly name = 'purge';
  readonly #purge: (now: Date) => Promise<PurgeResult>;

  /** `purge` is the job itself; a test passes its own. */
  constructor(purge: (now: Date) => Promise<PurgeResult> = purgeDeleted) {
    this.#purge = purge;
  }

  /** The purge's counts in the purge hour (logged too); nothing in any other hour. */
  async run(now: Date): Promise<Record<string, number>> {
    if (now.getUTCHours() !== PURGE_HOUR_UTC) return {};
    const result = await this.#purge(now);
    const counts = {
      items: result.items,
      containers: result.containers,
      timedOutRuns: result.timedOutRuns,
      orphanedDashboards: result.orphanedDashboards.dashboards,
      orphanedVersions: result.orphanedDashboards.versions,
      orphanedViews: result.orphanedDashboards.views,
      orphanedTopics: result.orphanedTopics,
    };
    logger.info('daily purge done', counts);
    return counts;
  }
}
