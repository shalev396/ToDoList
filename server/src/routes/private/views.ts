import { Router } from 'express';
import { ViewsController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { Query } from '../../types/builder.js';
import type { SavedView } from '../../types/dashboards.js';
import type { Visibility } from '../../types/domain.js';

/**
 * Saved views (DATA.md §3.13): a named query + viz that blocks reference by `savedViewId`. No
 * publish step: a published block bound to a view runs the view as it is now. Behind
 * requireWorkspace (non-members: 404); a private view is 404 for everyone but its owner.
 *
 * 400 `{message, pointer}` for a query or viz the Logic Bridge refuses (`/query/where/rules/0/field`).
 */
const router = Router();

// ─── GET /api/private/workspaces/:wid/views ─────────────────────────────────

/** Viewer. By title. */
export type ListViewsResponseData = SavedView[];

router.get('/workspaces/:wid/views', requireWorkspace('viewer'), ViewsController.list);

// ─── POST /api/private/workspaces/:wid/views ────────────────────────────────

/** Editor. 201. The query compiles against the field whitelist; the viz fits a catalog type. */
export interface CreateViewRequestBody {
  title: string;
  query: Query;
  viz: Record<string, unknown>;
  visibility?: Visibility;
}

export type CreateViewResponseData = SavedView;

router.post('/workspaces/:wid/views', requireWorkspace('editor'), ViewsController.create);

// ─── GET /api/private/workspaces/:wid/views/:id ─────────────────────────────

/** Viewer. */
export type GetViewResponseData = SavedView;

router.get('/workspaces/:wid/views/:id', requireWorkspace('viewer'), ViewsController.get);

// ─── PATCH /api/private/workspaces/:wid/views/:id ───────────────────────────

/** Editor. At least one change; a new query is validated as on create. */
export interface UpdateViewRequestBody {
  title?: string;
  query?: Query;
  viz?: Record<string, unknown>;
  visibility?: Visibility;
}

export type UpdateViewResponseData = SavedView;

router.patch('/workspaces/:wid/views/:id', requireWorkspace('editor'), ViewsController.update);

// ─── DELETE /api/private/workspaces/:wid/views/:id ──────────────────────────

/** Editor. 204, no body. */
router.delete('/workspaces/:wid/views/:id', requireWorkspace('editor'), ViewsController.remove);

export { router as viewsRouter };
