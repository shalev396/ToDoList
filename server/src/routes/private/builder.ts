import { Router } from 'express';
import { BuilderController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { CatalogDescription } from '../../builder/catalog.js';
import type { DashboardScope } from '../../types/builder.js';
import type {
  DashboardValidation,
  DashboardView,
  IntegrationShare,
  PersonaInstantiateResult,
  PersonaSummary,
  TemplateSummary,
  ViewTemplateSummary,
} from '../../types/dashboards.js';

/**
 * The Logic Bridge's catalog, validation and templates (BUILDER.md §9). Behind requireWorkspace
 * (non-members: 404). 400 `{message, pointer}` for a template the bridge refuses.
 */
const router = Router();

// ─── GET /api/private/workspaces/:wid/builder/catalog ───────────────────────

/**
 * Viewer. Block types (defaults, viz, size), fields with their operators, date presets, dynamic
 * values, caps and the JSON Schemas of queries, blocks, dashboards and ops.
 */
export type BuilderCatalogResponseData = CatalogDescription;

router.get(
  '/workspaces/:wid/builder/catalog',
  requireWorkspace('viewer'),
  BuilderController.catalog,
);

// ─── POST /api/private/workspaces/:wid/builder/validate ─────────────────────

/** Viewer. A whole dashboard draft, checked as a save would check it (UI lint mode); no write. */
export interface ValidateDraftRequestBody {
  draft: unknown;
}

export type ValidateDraftResponseData = DashboardValidation;

router.post(
  '/workspaces/:wid/builder/validate',
  requireWorkspace('viewer'),
  BuilderController.validate,
);

// ─── POST /api/private/workspaces/:wid/builder/instantiate ──────────────────

/** Editor. 201 with a new dashboard from the template (titles in `language`, default en). */
export interface InstantiateTemplateRequestBody {
  templateKey: string;
  language?: 'en' | 'he';
  /**
   * Overrides the template's scope field by field. A topic page belongs to a topic: pass
   * `{topicId}` (a topic of the workspace, 400 otherwise). A group page needs one: project@1 has
   * none, so it takes `{topicId}` (400 `/scope/topicId` without).
   */
  scope?: Partial<DashboardScope>;
  /**
   * false: the template binds only the caller's integrations that are already shared, so
   * creating shares nothing new ("Create without them"). Default: true. POST
   * …/builder/template-shares says what true would share.
   */
  shareIntegrations?: boolean;
}

export type InstantiateTemplateResponseData = DashboardView;

router.post(
  '/workspaces/:wid/builder/instantiate',
  requireWorkspace('editor'),
  BuilderController.instantiate,
);

// ─── POST /api/private/workspaces/:wid/builder/template-shares ──────────────

/**
 * Editor. What instantiating these templates (one page, or several at once) would share with the
 * whole workspace: the caller's own integrations a template block would be bound to that no
 * block holds yet (PERMISSIONS-V2: attaching shares). Empty: nothing to ask. Otherwise the UI
 * asks "Share and create" or "Create without them" (`shareIntegrations: false`). 400 for an
 * unknown template key.
 */
export interface TemplateSharesRequestBody {
  templateKeys: string[];
}

export interface TemplateSharesResponseData {
  shares: IntegrationShare[];
}

router.post(
  '/workspaces/:wid/builder/template-shares',
  requireWorkspace('editor'),
  BuilderController.templateShares,
);

// ─── GET /api/private/workspaces/:wid/builder/templates ─────────────────────

/** Viewer. The template gallery, as data. */
export type ListTemplatesResponseData = TemplateSummary[];

router.get(
  '/workspaces/:wid/builder/templates',
  requireWorkspace('viewer'),
  BuilderController.templates,
);

// ─── GET /api/private/workspaces/:wid/builder/view-templates ────────────────

/** Viewer. The view templates "+ Add view" offers (H3), as data. */
export type ListViewTemplatesResponseData = ViewTemplateSummary[];

router.get(
  '/workspaces/:wid/builder/view-templates',
  requireWorkspace('viewer'),
  BuilderController.viewTemplates,
);

// ─── GET /api/private/workspaces/:wid/builder/personas ──────────────────────

/** Viewer. The persona gallery (H6), smallest first. */
export type ListPersonasResponseData = PersonaSummary[];

router.get(
  '/workspaces/:wid/builder/personas',
  requireWorkspace('viewer'),
  BuilderController.personas,
);

// ─── POST /api/private/workspaces/:wid/builder/personas/:key/instantiate ────

/**
 * Editor. 201: makes the persona's topics, pages, views and blocks. Idempotent per topic slug (a
 * topic that exists is reused, a page keeps its blocks, a view is added only when the page has
 * none from the same template). Binds the caller's own integrations: ask first with
 * `template-shares` (a persona key works there), then pass `shareIntegrations: false` for "Create
 * without them". 404 for an unknown key.
 */
export interface InstantiatePersonaRequestBody {
  language?: 'en' | 'he';
  shareIntegrations?: boolean;
}

export type InstantiatePersonaResponseData = PersonaInstantiateResult;

router.post(
  '/workspaces/:wid/builder/personas/:key/instantiate',
  requireWorkspace('editor'),
  BuilderController.instantiatePersona,
);

export { router as builderRouter };
