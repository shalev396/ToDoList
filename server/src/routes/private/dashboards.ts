import { Router } from 'express';
import { DashboardsController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { DashboardScope, DashboardVars, Layouts } from '../../types/builder.js';
import type {
  DashboardDryRunResult,
  DashboardPublishResult,
  DashboardSummary,
  DashboardVersionView,
  DashboardView,
  DashboardWriteResult,
} from '../../types/dashboards.js';
import type { DashboardPage } from '../../types/domain.js';

/**
 * Dashboards (BUILDER.md §5–§9). Every route sits behind requireWorkspace (non-members: 404).
 *
 * Errors: 400 `{message, pointer}` for an op, layout or dashboard the Logic Bridge refuses (the
 * pointer locates it: `/ops/0/blockId`, `/blocks/2/viz/kind`); 403 below the route's role; 404 for
 * an unknown (or not visible) dashboard; **409 `{message, currentVersion}`** when `expectedVersion`
 * is stale: refetch, then retry on the current version.
 */
const router = Router();

/** Every write carries the version it was made against (optimistic concurrency). */
interface VersionedRequest {
  expectedVersion: number;
}

// ─── GET /api/private/workspaces/:wid/dashboards ────────────────────────────

/** `?topic=<topic id>|main` (main: the main dashboard) and `?page=topic|group`. */
export interface ListDashboardsQuery {
  topic?: string;
  page?: DashboardPage;
}

/** Viewer. Oldest first. Viewers only see published dashboards, with their published title. */
export type ListDashboardsResponseData = DashboardSummary[];

router.get('/workspaces/:wid/dashboards', requireWorkspace('viewer'), DashboardsController.list);

// ─── POST /api/private/workspaces/:wid/dashboards ───────────────────────────

/**
 * Editor. 201 with the new dashboard at version 1. `title` is required without `fromTemplate`;
 * `scope` overrides the template's field by field (a topic page needs `topicId`, a group page `topicId` and `groupVar`; an unknown topic is 400); `language` (default en) picks the template's
 * titles. An owner's dashboard is published at once; anyone else's waits for a publish.
 */
export interface CreateDashboardRequestBody {
  title?: string;
  scope?: Partial<DashboardScope>;
  /** A template key (`work@1`) or name (`work`): GET …/builder/templates. */
  fromTemplate?: string;
  language?: 'en' | 'he';
  /**
   * false: the template binds only the caller's integrations that are already shared, so
   * creating shares nothing new ("Create without them"). Default: true. POST
   * …/builder/template-shares says what true would share.
   */
  shareIntegrations?: boolean;
}

export type CreateDashboardResponseData = DashboardView;

router.post('/workspaces/:wid/dashboards', requireWorkspace('editor'), DashboardsController.create);

// ─── GET /api/private/workspaces/:wid/dashboards/:id ────────────────────────

/** `?as=draft|published`. Viewers always get the published copy (404 before the first publish). */
export interface GetDashboardQuery {
  as?: 'draft' | 'published';
}

export type GetDashboardResponseData = DashboardView;

router.get('/workspaces/:wid/dashboards/:id', requireWorkspace('viewer'), DashboardsController.get);

// ─── PATCH /api/private/workspaces/:wid/dashboards/:id ──────────────────────

/** Editor. The title and/or the variables (`vars` replaces the whole map), applied as ops. */
export interface UpdateDashboardRequestBody extends VersionedRequest {
  title?: string;
  vars?: DashboardVars;
}

export type UpdateDashboardResponseData = DashboardWriteResult;

router.patch(
  '/workspaces/:wid/dashboards/:id',
  requireWorkspace('editor'),
  DashboardsController.update,
);

// ─── DELETE /api/private/workspaces/:wid/dashboards/:id ─────────────────────

/** Owner. 204, no body. */
router.delete(
  '/workspaces/:wid/dashboards/:id',
  requireWorkspace('owner'),
  DashboardsController.remove,
);

// ─── PUT /api/private/workspaces/:wid/dashboards/:id/layout ─────────────────

/** Editor. Block positions per breakpoint (one arrange op): blocks not listed keep theirs. */
export interface UpdateLayoutRequestBody extends VersionedRequest {
  layouts: Partial<Layouts>;
}

export type UpdateLayoutResponseData = DashboardWriteResult;

router.put(
  '/workspaces/:wid/dashboards/:id/layout',
  requireWorkspace('editor'),
  DashboardsController.layout,
);

// ─── POST /api/private/workspaces/:wid/dashboards/:id/ops ───────────────────

/**
 * Editor. Builder ops (`Op`, `@api-types/builder`), applied in order as one version. With
 * `dryRun`, nothing is written and the answer says whether it would be, with the diff and preview
 * rows per block. `language` picks apply_template's titles.
 */
export interface ApplyOpsRequestBody extends VersionedRequest {
  dryRun?: boolean;
  ops: unknown[];
  language?: 'en' | 'he';
  /** false: view templates bind only the integrations already shared ("Create without them"). */
  shareIntegrations?: boolean;
}

/** `{version, warnings}`, or the dry run's `{valid, errors, warnings, diff, preview}`. */
export type ApplyOpsResponseData = DashboardWriteResult | DashboardDryRunResult;

router.post(
  '/workspaces/:wid/dashboards/:id/ops',
  requireWorkspace('editor'),
  DashboardsController.ops,
);

// ─── GET /api/private/workspaces/:wid/dashboards/:id/versions ───────────────

/** Editor. `?limit=` (1–100, default 50). Newest first. */
export type ListDashboardVersionsResponseData = DashboardVersionView[];

router.get(
  '/workspaces/:wid/dashboards/:id/versions',
  requireWorkspace('editor'),
  DashboardsController.versions,
);

// ─── POST /api/private/workspaces/:wid/dashboards/:id/undo ──────────────────

/** Editor. Reverts the newest `steps` (1–20, default 1) changes as one new version. Nothing: 409. */
export interface UndoDashboardRequestBody extends VersionedRequest {
  steps?: number;
}

export type UndoDashboardResponseData = DashboardWriteResult;

router.post(
  '/workspaces/:wid/dashboards/:id/undo',
  requireWorkspace('editor'),
  DashboardsController.undo,
);

// ─── POST /api/private/workspaces/:wid/dashboards/:id/redo ──────────────────

/** Editor. Only right after an undo (else 409): re-applies what it reverted. */
export type RedoDashboardRequestBody = VersionedRequest;

export type RedoDashboardResponseData = DashboardWriteResult;

router.post(
  '/workspaces/:wid/dashboards/:id/redo',
  requireWorkspace('editor'),
  DashboardsController.redo,
);

// ─── POST /api/private/workspaces/:wid/dashboards/:id/revert ────────────────

/** Editor. Restores the state at `toVersion` as a new version; 404 once the history is pruned. */
export interface RevertDashboardRequestBody extends VersionedRequest {
  toVersion: number;
}

export type RevertDashboardResponseData = DashboardWriteResult;

router.post(
  '/workspaces/:wid/dashboards/:id/revert',
  requireWorkspace('editor'),
  DashboardsController.revert,
);

// ─── POST /api/private/workspaces/:wid/dashboards/:id/publish ───────────────

/**
 * Owner. Publishes the version the owner reviewed: viewers see it from now on. If the draft moved
 * on since (an agent or another editor wrote), nothing is published: 409 {message, currentVersion}.
 * The draft's version does not change.
 */
export type PublishDashboardRequestBody = VersionedRequest;

export type PublishDashboardResponseData = DashboardPublishResult;

router.post(
  '/workspaces/:wid/dashboards/:id/publish',
  requireWorkspace('owner'),
  DashboardsController.publish,
);

export { router as dashboardsRouter };
