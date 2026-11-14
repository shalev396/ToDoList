/**
 * Request bodies and query strings of the dashboard, builder and view routes (zod 4). Strict
 * objects: an unknown key is a 400. They only shape the input: ops, drafts and queries are
 * validated by the Logic Bridge, which answers with JSON pointers. MCP tools can reuse them.
 */
import { z } from 'zod';

import { TEMPLATE_LANGUAGES } from '../builder/templates.js';
import { DashboardVarsSchema, LayoutsSchema, VarNameSchema } from '../types/builder.js';
import { DASHBOARD_PAGES, VISIBILITIES } from '../types/domain.js';
import { MAX_UNDO_STEPS } from './dashboards.js';

/** Ops in one request; each is parsed by the Logic Bridge. */
export const MAX_OPS_PER_REQUEST = 50;

const Version = z.int().min(1);
const Title = z.string().min(1).max(80);
const Language = z.enum(TEMPLATE_LANGUAGES);
const Viz = z.record(z.string(), z.unknown());

/** `?topic=<topic id>|main&page=topic|group`; `main` is the main dashboard. */
export const ListDashboardsQuery = z.strictObject({
  topic: z.string().min(1).max(100).optional(),
  page: z.enum(DASHBOARD_PAGES).optional(),
});

export const GetDashboardQuery = z.strictObject({
  as: z.enum(['draft', 'published']).optional(),
});

export const ListVersionsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** A scope override, field by field: a group page needs a topic and its route variable. */
const ScopeOverride = z.strictObject({
  /** A topic of the workspace (400 otherwise); null = the main dashboard. */
  topicId: z.string().min(1).max(100).nullable().optional(),
  containerId: z.string().min(1).max(100).nullable().optional(),
  page: z.enum(DASHBOARD_PAGES).optional(),
  /** A group page's route variable (`course` → `$page.course`): required on group pages. */
  groupVar: VarNameSchema.nullable().optional(),
});

/** false: a template binds only the integrations already shared ("Create without them"). */
const ShareIntegrations = z.boolean().optional();

export const CreateDashboardBody = z.strictObject({
  title: Title.optional(),
  scope: ScopeOverride.optional(),
  fromTemplate: z.string().min(1).max(80).optional(),
  language: Language.optional(),
  shareIntegrations: ShareIntegrations,
});

/** PATCH: the title and/or the variables (which replace the whole map), applied as ops. */
export const UpdateDashboardBody = z
  .strictObject({
    expectedVersion: Version,
    title: Title.optional(),
    vars: DashboardVarsSchema.optional(),
  })
  .refine((body) => body.title !== undefined || body.vars !== undefined, {
    message: 'send a title or vars',
  });

/** PUT …/layout: positions per breakpoint, applied as one arrange op. */
export const LayoutBody = z.strictObject({
  expectedVersion: Version,
  layouts: LayoutsSchema.partial(),
});

export const OpsBody = z.strictObject({
  expectedVersion: Version,
  dryRun: z.boolean().optional(),
  ops: z.array(z.unknown()).min(1).max(MAX_OPS_PER_REQUEST),
  /** The language apply_template uses for titles. */
  language: Language.optional(),
  /** false: view templates bind only the integrations already shared. */
  shareIntegrations: z.boolean().optional(),
});

export const UndoBody = z.strictObject({
  expectedVersion: Version,
  steps: z.int().min(1).max(MAX_UNDO_STEPS).optional(),
});

export const RedoBody = z.strictObject({ expectedVersion: Version });

export const RevertBody = z.strictObject({ expectedVersion: Version, toVersion: Version });

/** The version the owner reviewed: a newer draft (an agent wrote since) is a 409. */
export const PublishBody = z.strictObject({ expectedVersion: Version });

export const ValidateBody = z.strictObject({ draft: z.unknown() });

export const InstantiateBody = z.strictObject({
  templateKey: z.string().min(1).max(80),
  language: Language.optional(),
  /** A topic page or project@1 needs a topic: pass `{topicId}`. */
  scope: ScopeOverride.optional(),
  shareIntegrations: ShareIntegrations,
});

export const InstantiatePersonaBody = z.strictObject({
  language: Language.optional(),
  shareIntegrations: ShareIntegrations,
});

/** Templates about to be instantiated together (a page, or a persona's set of pages). */
export const TemplateSharesBody = z.strictObject({
  templateKeys: z.array(z.string().min(1).max(80)).min(1).max(20),
});

export const CreateViewBody = z.strictObject({
  title: Title,
  query: z.unknown(),
  viz: Viz,
  visibility: z.enum(VISIBILITIES).optional(),
});

export const UpdateViewBody = z
  .strictObject({
    title: Title.optional(),
    query: z.unknown().optional(),
    viz: Viz.optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'send at least one change',
  });
