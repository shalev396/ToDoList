import { Router } from 'express';
import { TimeBlocksController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';

export type {
  CreateTimeBlockRequest,
  EditTimeBlockRequest,
  SkipOccurrenceRequest,
  TimeBlockResponseData,
} from '../../types/timeBlocks.js';

/**
 * Time blocks and areas (docs/superpowers/specs/2026-11-17-time-blocks-design.md): TodoList's own
 * reserved time, a local item of kind `block` (an area: `props.layer: 'area'`). Full paths under
 * /workspaces/:wid, editors and owners. Each answers the block as now stored (an ItemDetail, as
 * `GET …/items/:id` answers it). A block is read and listed as an item, and deleted with
 * `DELETE …/items/:id`. Non-members get 404, a viewer 403; a block the caller can't see (another
 * member's private one), or an id that is no time block, is 404.
 */
const router = Router();

// ─── POST /api/private/workspaces/:wid/time-blocks ──────────────────────────

/**
 * Editor (types/timeBlocks.ts: CreateTimeBlockRequest). 201; the same `idempotencyKey` from the
 * same user answers 200 with the block made the first time (a key used for a to-do: 409).
 * - `subject`: an option of the Subject attribute, matched whatever its case; a new one is added
 *   (the attribute too, on first use). The title defaults to it; an area needs a title.
 * - `topicId` defaults to the topic last used with the subject, else none (Unsorted).
 * - It lasts 1 minute to 24 hours. `recurrence`: one `RRULE:` line (FREQ DAILY, WEEKLY, MONTHLY or
 *   YEARLY; an UNTIL is a UTC time), expanded on the workspace's wall clock.
 */
router.post(
  '/workspaces/:wid/time-blocks',
  requireWorkspace('editor'),
  TimeBlocksController.create,
);

// ─── PATCH /api/private/workspaces/:wid/time-blocks/:id ─────────────────────

/**
 * Editor (EditTimeBlockRequest). `scope: 'this'` moves one occurrence (`originalStart`, and its new
 * `startAt` and `endAt`; nothing else): an exception keyed by its original start, 400
 * `not_an_occurrence` when that is none of the series' starts, 400 past 366 exceptions.
 * `scope: 'all'` changes the series (title, note, subject, topic, start, end, recurrence); a new
 * start or rule drops the exceptions that are no longer occurrences.
 */
router.patch(
  '/workspaces/:wid/time-blocks/:id',
  requireWorkspace('editor'),
  TimeBlocksController.edit,
);

// ─── POST /api/private/workspaces/:wid/time-blocks/:id/skip ─────────────────

/** Editor (SkipOccurrenceRequest). One occurrence left out; 400 `not_an_occurrence` as above. */
router.post(
  '/workspaces/:wid/time-blocks/:id/skip',
  requireWorkspace('editor'),
  TimeBlocksController.skip,
);

export { router as timeBlocksRouter };
