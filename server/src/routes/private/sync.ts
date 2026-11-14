import { Router } from 'express';
import { SyncController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { SyncRunView } from '../../types/integrations.js';

/**
 * "Sync now" and the sync-run history (BACKEND.md §4, DATA.md §3.9). Syncs are queued: the answer
 * is 202 with run ids to poll through `GET …/sync-runs`. Behind requireWorkspace (non-members:
 * 404). Only an integration's owner syncs it or sees its runs, whatever their role
 * (PERMISSIONS-V2 rulings 1 and 20): another member's integration, a deleted one or one from
 * another workspace is 404.
 */
const router = Router();

// ─── POST /api/private/workspaces/:wid/sync ─────────────────────────────────

/**
 * Viewer. 202. Queues every integration the member owns here that can sync now: not paused,
 * expired or waiting for a reconnect, with a saved credential (live mode), and not synced
 * manually in the last 5 minutes. Possibly none.
 */
export interface SyncAllResponseData {
  runIds: string[];
}

router.post('/workspaces/:wid/sync', requireWorkspace('viewer'), SyncController.syncAll);

// ─── POST /api/private/workspaces/:wid/integrations/:iid/sync ───────────────

/**
 * Its owner. 202. 409 while the integration waits for its owner (paused, expired, a reconnect, no
 * credential). 429 with `Retry-After` (seconds) within 5 minutes of its last manual sync.
 */
export interface SyncIntegrationResponseData {
  runId: string;
}

router.post(
  '/workspaces/:wid/integrations/:iid/sync',
  requireWorkspace('viewer'),
  SyncController.syncIntegration,
);

// ─── GET /api/private/workspaces/:wid/sync-runs ─────────────────────────────

/** `limit` 1–100, default 20. */
export interface ListSyncRunsQuery {
  integrationId?: string;
  limit?: number;
}

/**
 * Viewer: the runs of the member's own integrations (`integrationId`: one of them, else 404).
 * Newest first: counts and a fixed `{code, message}`; never the failed records.
 */
export type ListSyncRunsResponseData = SyncRunView[];

router.get('/workspaces/:wid/sync-runs', requireWorkspace('viewer'), SyncController.listRuns);

export { router as syncRouter };
