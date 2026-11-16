import { Router } from 'express';
import { PrimaryCalendarController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { PrimaryCalendarView } from '../../types/primaryCalendar.js';

/**
 * The workspace's primary calendar (plan Addendum A2): the one Google calendar TodoList pushes the
 * workspace's dated items to. Its owner chooses it among the Google Calendar integrations they own
 * that are read & write; it is suspended (pushes skipped) while that integration is read-only or
 * after it is disconnected.
 */
const router = Router();

// ─── GET /api/private/workspaces/:wid/primary-calendar ──────────────────────

/** Any member. Its integration and calendar ids reach that integration's owner only. */
export type GetPrimaryCalendarResponseData = PrimaryCalendarView;

router.get(
  '/workspaces/:wid/primary-calendar',
  requireWorkspace('viewer'),
  PrimaryCalendarController.get,
);

// ─── PUT /api/private/workspaces/:wid/primary-calendar ──────────────────────

/**
 * A workspace owner, with a Google Calendar integration of their own (404 for anyone else's)
 * that is read & write (409 `integration_read_only`): a calendar of its account it can write
 * (400 otherwise), or a new one (`newCalendarName`: created at Google, read by the integration,
 * recorded as TodoList's own; 409 `scope_missing` for a grant from before that permission). 502
 * when Google did not answer. Audited as `workspace.primary_calendar`.
 */
export type SetPrimaryCalendarResponseData = PrimaryCalendarView;

router.put(
  '/workspaces/:wid/primary-calendar',
  requireWorkspace('owner'),
  PrimaryCalendarController.set,
);

// ─── DELETE /api/private/workspaces/:wid/primary-calendar ───────────────────

/** A workspace owner: no primary calendar, so nothing is pushed. Audited as `workspace.primary_calendar`. */
export type ClearPrimaryCalendarResponseData = PrimaryCalendarView;

router.delete(
  '/workspaces/:wid/primary-calendar',
  requireWorkspace('owner'),
  PrimaryCalendarController.clear,
);

export { router as primaryCalendarRouter };
