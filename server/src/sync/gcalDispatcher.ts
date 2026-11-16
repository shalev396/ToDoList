/**
 * `gcal-dispatch` (a direct invoke of the API function; no schedule for now): one background
 * calendar sync per eligible OAuth Google Calendar integration (gcal/scheduledSync.ts). Each job
 * carries the integration id only (services/syncJobs.ts).
 */
import { listGcalScheduleTargets } from '../gcal/scheduledSync.js';
import { logger } from '../services/logger.js';
import { enqueueGcalSync } from '../services/syncJobs.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { ownedByMembers, type DispatchResult } from './dispatcher.js';

const ENQUEUE_CONCURRENCY = 8;

export async function dispatchGcalSyncs(): Promise<DispatchResult> {
  const targets = await ownedByMembers(await listGcalScheduleTargets());
  const queued = await runWithConcurrency(targets, ENQUEUE_CONCURRENCY, async ({ id }) => {
    try {
      await enqueueGcalSync(id);
      return true;
    } catch (error) {
      logger.error('gcal dispatch: could not queue a sync', { integrationId: id, error });
      return false;
    }
  });
  const dispatched = queued.filter((ok) => ok).length;
  return { dispatched, failed: queued.length - dispatched };
}
