/**
 * The dispatched sync (the API function's `sync-dispatch` action, invoked directly; no schedule
 * for now): one queued run per dispatchable integration, i.e. not deleted, `active`, `expiring` or
 * `error`, not failed on auth, and with a credential. Expired and paused ones, those whose last
 * error is `auth_failed`, and those without a credential yet (R6) wait for the user (a reconnect,
 * or the credential). Each run is a background job carrying ids and the mode only
 * (Integration.requestRun, SyncRun.request, services/syncJobs.ts). An integration whose owner is no longer an active
 * member of its workspace is never dispatched (ownedByMembers). Every read and write is a class's.
 */
import { Integration } from '../classes/integration/index.js';
import { Member } from '../classes/workspace/index.js';
import { logger } from '../services/logger.js';
import type { SyncTrigger } from '../types/domain.js';
import { runWithConcurrency } from '../utils/concurrency.js';

/** Jobs being started at once (each is one async invoke of the function on Lambda). */
const ENQUEUE_CONCURRENCY = 8;

export interface DispatchResult {
  dispatched: number;
  /** Integrations whose run could not be queued (logged; the run is marked failed). */
  failed: number;
}

/**
 * Defence in depth (PERMISSIONS-V2 ruling 6): only the integrations whose owner is an active
 * member of their workspace. Leaving or removal disconnects a member's integrations; this keeps a
 * disconnect that stopped part-way, or data from before the upgrade, from syncing on a former
 * member's credential. The skipped ones are logged by count.
 */
export async function ownedByMembers<T extends { workspaceId: string; ownerUserId: string }>(
  integrations: readonly T[],
): Promise<T[]> {
  const workspaceIds = [...new Set(integrations.map((integration) => integration.workspaceId))];
  const members = new Map(
    await runWithConcurrency(
      workspaceIds,
      ENQUEUE_CONCURRENCY,
      async (workspaceId): Promise<[string, Set<string>]> => [
        workspaceId,
        new Set(await Member.userIdsIn(workspaceId)),
      ],
    ),
  );
  const owned = integrations.filter(
    (integration) => members.get(integration.workspaceId)?.has(integration.ownerUserId) === true,
  );
  if (owned.length < integrations.length) {
    logger.warn('sync dispatch: skipped integrations whose owner is no longer a member', {
      skipped: integrations.length - owned.length,
    });
  }
  return owned;
}

export async function dispatchAllSyncs(trigger: SyncTrigger = 'schedule'): Promise<DispatchResult> {
  const integrations = await ownedByMembers(
    (await Integration.listForDispatch()).filter(
      // No credential yet (R6): every run would fail on the missing secret.
      (integration) => integration.credentialId !== null,
    ),
  );
  const queued = await runWithConcurrency(
    integrations,
    ENQUEUE_CONCURRENCY,
    async (integration) => {
      try {
        // The system's, on behalf of no member; read again by id, as a run is queued.
        await Integration.requestRun(integration.id, trigger);
        return true;
      } catch (error) {
        logger.error('sync dispatch: could not queue a run', {
          integrationId: integration.id,
          error,
        });
        return false;
      }
    },
  );
  const dispatched = queued.filter((ok) => ok).length;
  return { dispatched, failed: queued.length - dispatched };
}
