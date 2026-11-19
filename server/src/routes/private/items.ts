import { Router } from 'express';
import { ItemsController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { ItemDetail } from '../../types/items.js';

export type {
  ListItemsQuery,
  ListItemsResponseData,
  OpenIn,
  ItemOverlayView,
  ItemSummary,
  ItemDetail,
  UpdateItemRequestBody,
  UpdateItemResponseData,
  UpdateOverlayRequestBody,
  UpdateOverlayResponseData,
  GetItemResponseData,
  FacetContainer,
  FacetsResponseData,
} from '../../types/items.js';

/**
 * Items and facets (DATA.md §3.6, BACKEND.md §4). Full paths under /workspaces/:wid, a role per
 * route. Every read starts from the caller's access filter (private items); text is
 * redacted like `/query` rows. Non-members get 404, a member below the role 403.
 */
const router = Router();

// ─── GET /api/private/workspaces/:wid/items ─────────────────────────────────

/** Viewer (types/items.ts: ListItemsQuery, ListItemsResponseData). */

router.get('/workspaces/:wid/items', requireWorkspace('viewer'), ItemsController.list);

// ─── POST /api/private/workspaces/:wid/items ────────────────────────────────

/**
 * Editor. Creates a local to-do: 201. The same `idempotencyKey` from the same user (permanent, unique
 * per owner) answers 200 with the item already created. `topicId` (a topic of the workspace, or
 * null for Unsorted) defaults to the workspace's `personal` topic when it has one; an unknown
 * topic is 400. `startAt` and `endAt` time it (a to-do needs a start for travel): an end needs a
 * start and is not before it (400).
 *
 * With `recurrence` (one `RRULE:` line, plan Addendum A3) it is a recurring to-do instead: a
 * recurring event created in the workspace's primary calendar only (409 `primary_calendar_unset`
 * without one), by that calendar integration's owner (403 `integration_not_owner`) while it is read
 * & write (409 `integration_read_only`), and answered at once as its event item (201); `dueAt` is
 * its first occurrence (400 `needs_due_date` without it); no local to-do is made, and no
 * `containerId` is taken. The same `idempotencyKey` again answers 200 with the same event (nothing
 * sent). An event made at Google but not stored here answers 409 `created_not_stored` with
 * `details.written`: it appears after the next sync.
 */
export interface CreateItemRequestBody {
  title: string;
  note?: string;
  dueAt?: string | null;
  allDay?: boolean;
  topicId?: string | null;
  containerId?: string | null;
  priority?: number | null;
  idempotencyKey?: string;
  /** ISO 8601 with an offset. Not with `recurrence`. */
  startAt?: string;
  /** Needs `startAt`, and is not before it. */
  endAt?: string;
  /** A recurring to-do: one `RRULE:` line. */
  recurrence?: string[];
}

export type CreateItemResponseData = ItemDetail;

router.post('/workspaces/:wid/items', requireWorkspace('editor'), ItemsController.create);

// ─── GET /api/private/workspaces/:wid/items/:id ─────────────────────────────

router.get('/workspaces/:wid/items/:id', requireWorkspace('viewer'), ItemsController.get);

// ─── PATCH /api/private/workspaces/:wid/items/:id ───────────────────────────

router.patch('/workspaces/:wid/items/:id', requireWorkspace('editor'), ItemsController.update);

// ─── DELETE /api/private/workspaces/:wid/items/:id ──────────────────────────

/** Editor. Local items only, soft delete: 204. A mirrored item: 409 `{message, openIn}`. */
router.delete('/workspaces/:wid/items/:id', requireWorkspace('editor'), ItemsController.remove);

// ─── PATCH /api/private/workspaces/:wid/items/:id/overlay ───────────────────

router.patch(
  '/workspaces/:wid/items/:id/overlay',
  requireWorkspace('editor'),
  ItemsController.overlay,
);

// ─── POST /api/private/workspaces/:wid/items/:id/complete ───────────────────

/** Editor. Local items only (mirrored: 409 `{message, openIn}`). `done` → done, else open. */
export interface CompleteItemRequestBody {
  done: boolean;
}

export type CompleteItemResponseData = ItemDetail;

router.post(
  '/workspaces/:wid/items/:id/complete',
  requireWorkspace('editor'),
  ItemsController.complete,
);

// ─── GET /api/private/workspaces/:wid/facets ────────────────────────────────

/**
 * Viewer. The filter values present in what the caller may see: their own integrations, the
 * shared ones and the local to-dos they may see (PERMISSIONS-V2 ruling 13). `connectors`
 * (comma-separated integration ids, `local` for to-dos): only what those sources hold, as a
 * filter block's listening blocks read them.
 */
export interface FacetsQuery {
  connectors?: string;
}

router.get('/workspaces/:wid/facets', requireWorkspace('viewer'), ItemsController.facets);

export { router as itemsRouter };
