import { Router } from 'express';
import { GcalSyncController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';

/**
 * The Google Calendar push: the one sanctioned write, onto the member's own calendar through
 * their Google sign-in (OAuth). Behind requireWorkspace; only
 * the owner of the integration the workspace's primary calendar is on pushes (409
 * `calendar_not_primary` for any other), the dated items they may see (PERMISSIONS-V2 ruling 12,
 * as amended by the calendar phase). Another member's integration, a deleted one or one from
 * another workspace is 404.
 */
const router = Router();

// ─── POST /api/private/workspaces/:wid/gcal-sync ────────────────────────────

/** `confirm` defaults to false: a dry run. */
export interface GcalSyncRequestBody {
  integrationId: string;
  confirm?: boolean;
}

/**
 * Its owner (any role). Dry run (200): the counts of what a push would do; nothing is written. Confirmed (202):
 * the run to poll through `GET …/sync-runs`. 409 while the integration waits for its owner, 429 once
 * 4,000 events were created in 24 hours, 502 when Google is silent.
 */
export type GcalSyncResponseData =
  | { dryRun: true; counts: { create: number; update: number; remove: number } }
  | { dryRun: false; runId: string };

router.post('/workspaces/:wid/gcal-sync', requireWorkspace('viewer'), GcalSyncController.run);

export { router as gcalSyncRouter };
