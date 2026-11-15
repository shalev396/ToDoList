/** The builder's read tools: dashboards, the catalog, templates, validation, preview, history. */
import { z } from 'zod';

import { describeCatalog } from '../../../builder/catalog.js';
import { tryPatch } from '../../../builder/history.js';
import { listPersonas } from '../../../builder/personas.js';
import { listTemplates } from '../../../builder/templates.js';
import { listViewTemplates } from '../../../builder/viewTemplates.js';
import {
  applyDashboardOps,
  getDashboard,
  listDashboards,
  listDashboardVersions,
  validateDashboardDraft,
} from '../../../services/dashboards.js';
import { AttributeDefinitions } from '../../../classes/workspace/index.js';
import { providerFieldsOf } from '../../../services/providerFields.js';
import { OpSchema } from '../../../types/builder.js';
import { DASHBOARD_PAGES } from '../../../types/domain.js';
import { TopicRef, topicIdOf } from '../itemViews.js';
import { defineTool, type ToolAnnotations } from '../../tool.js';
import {
  actorOf,
  DashboardId,
  DashboardScope,
  DashboardView,
  Diff,
  dryRunChange,
  ExpectedVersion,
  Issue,
  json,
  JsonPatchOp,
  Language,
  MAX_OPS,
  MAX_PATCH_OPERATIONS,
  Preview,
  PREVIEW_TOOL,
  changeHash,
  type Change,
} from './common.js';

/** MCP.md §8.4: builder_preview's sampleRows, 0 to 20. */
const MAX_SAMPLE_ROWS = 20;
const Config = z.record(z.string(), z.unknown());

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const DashboardSummary = z.object({
  id: z.string(),
  title: z.string(),
  scope: DashboardScope,
  templateKey: z.string().nullable(),
  visibility: z.string(),
  version: z.number().int(),
  publishedVersion: z.number().int().nullable(),
  updatedAt: z.string(),
});

export const builderListDashboards = defineTool({
  name: 'builder_list_dashboards',
  title: 'List dashboards',
  description:
    'The dashboards and topic or group pages the member may see, oldest first: id, title, scope (topicId, page), template, version and published version. Viewers see published ones only.',
  toolset: 'builder',
  inputSchema: z.strictObject({
    topic: TopicRef.nullable()
      .optional()
      .describe('A topic slug (or id); null: the main dashboard'),
    page: z.enum(DASHBOARD_PAGES).optional(),
  }),
  outputSchema: z.object({ dashboards: z.array(DashboardSummary) }),
  annotations: READ,
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    const { topic, ...filter } = input;
    const dashboards = await listDashboards(ctx.workspace, actorOf(ctx), {
      ...filter,
      ...(topic === undefined ? {} : { topicId: await topicIdOf(ctx.workspace, topic) }),
    });
    return { output: { dashboards: json(z.array(DashboardSummary), dashboards) } };
  },
});

export const builderGetDashboard = defineTool({
  name: 'builder_get_dashboard',
  title: 'Get a dashboard',
  description:
    'One dashboard’s config: title, scope, variables, layouts and blocks, with its version (the next write’s expectedVersion) and published version. Editors get the draft unless they ask for the published copy; viewers always get the published one.',
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    as: z.enum(['draft', 'published']).optional().describe('Default: draft (editors)'),
  }),
  outputSchema: DashboardView,
  annotations: READ,
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    const view = await getDashboard(ctx.workspace, actorOf(ctx), input.dashboardId, {
      as: input.as,
    });
    return { output: json(DashboardView, view), target: { type: 'dashboard', id: view.id } };
  },
});

const FieldSummary = z.object({ field: z.string(), type: z.string() });
const BlockTypes = z.object({
  blockTypes: z.array(
    z.object({
      type: z.string(),
      allowedViz: z.array(z.string()),
      requiredQuery: z.boolean(),
      size: z.record(z.string(), z.number()),
    }),
  ),
  fields: z.object({ items: z.array(FieldSummary), containers: z.array(FieldSummary) }),
  operators: z.array(z.string()),
  datePresets: z.array(z.string()),
  aggregateOps: z.array(z.string()),
  caps: z.record(z.string(), z.unknown()),
  attributes: z
    .array(
      z.object({ field: z.string(), name: z.string(), type: z.string(), builtIn: z.boolean() }),
    )
    .describe('Custom attributes, usable as fields (attr.<key>)'),
  providerFields: z
    .array(
      z.object({ path: z.string(), provider: z.string(), label: z.string(), type: z.string() }),
    )
    .describe('Fields the workspace’s providers synced, usable as fields (props.<provider>.<key>)'),
});

const ViewTemplate = z.looseObject({
  key: z.string(),
  version: z.number().int(),
  titles: z.object({ en: z.string(), he: z.string() }),
  type: z.string(),
});

const Persona = z.looseObject({
  key: z.string(),
  version: z.number().int(),
  titles: z.object({ en: z.string(), he: z.string() }),
  descriptions: z.object({ en: z.string(), he: z.string() }),
});

const Template = z.looseObject({
  key: z.string(),
  version: z.number().int(),
  titles: z.object({ en: z.string(), he: z.string() }),
});

export const builderListBlockTypes = defineTool({
  name: 'builder_list_block_types',
  title: 'List block types',
  description:
    'The block types with the viz kinds each allows, whether it needs a query and its default size; the query fields, operators, date presets and aggregates; and the caps. Connectors: filter the query on integrationId. Full JSON Schemas: the todolist://schema/block/{type} and todolist://schema/query resources.',
  toolset: 'builder',
  inputSchema: z.strictObject({}),
  outputSchema: BlockTypes,
  annotations: READ,
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx) {
    const catalog = describeCatalog({
      attributes: AttributeDefinitions.of(ctx.workspace.settings).toJSON(),
      providerFields: await providerFieldsOf(ctx.workspace, ctx.principal.userId),
    });
    const field = (spec: { field: string; type: string }): { field: string; type: string } => ({
      field: spec.field,
      type: spec.type,
    });
    const output = json(BlockTypes, {
      blockTypes: catalog.blockTypes.map(({ type, allowedViz, requiredQuery, size }) => ({
        type,
        allowedViz,
        requiredQuery,
        size,
      })),
      fields: {
        items: catalog.fields.items.map(field),
        containers: catalog.fields.containers.map(field),
      },
      operators: catalog.operators,
      datePresets: catalog.datePresets,
      aggregateOps: catalog.aggregateOps,
      caps: catalog.caps,
      attributes: catalog.fields.attributes.map(({ field: name, name: label, type, builtIn }) => ({
        field: name,
        name: label,
        type,
        builtIn,
      })),
      providerFields: catalog.fields.provider.map(({ path, provider, label, type }) => ({
        path,
        provider,
        label,
        type,
      })),
    });
    return { output };
  },
});

export const builderListTemplates = defineTool({
  name: 'builder_list_templates',
  title: 'List templates',
  description:
    'The templates as data, each with a key (e.g. college@1) and titles. templates: dashboard templates (Dashboard, Work, Personal, College, a course, a project), for builder_create_dashboard (fromTemplate) or builder_apply_template. viewTemplates: views for builder_add_view (templateKey). personas: sets of topics, pages and views (Light student, Two jobs + studies + side project, Student + job), smallest first, for builder_instantiate_persona. Using any of them attaches the key user’s own matching integrations to the blocks, which shares their items with the workspace: a dry run’s shares names each.',
  toolset: 'builder',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    templates: z.array(Template),
    viewTemplates: z.array(ViewTemplate),
    personas: z.array(Persona),
  }),
  annotations: READ,
  scopes: ['read'],
  minRole: 'viewer',
  handler() {
    const templates = json(z.array(Template), listTemplates());
    const viewTemplates = json(z.array(ViewTemplate), listViewTemplates());
    const personas = json(z.array(Persona), listPersonas());
    return Promise.resolve({ output: { templates, viewTemplates, personas } });
  },
});

export const builderValidate = defineTool({
  name: 'builder_validate',
  title: 'Validate a dashboard',
  description:
    'Checks a whole config (draft: title, scope, vars, layouts, blocks), or ops against a dashboard’s current draft, as a write would: errors and warnings, each with a JSON pointer. Writes nothing and does not count as a preview.',
  toolset: 'builder',
  inputSchema: z
    .strictObject({
      draft: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A whole config: title, scope, vars, layouts, blocks'),
      dashboardId: DashboardId.optional().describe('With ops: the dashboard they are for'),
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(MAX_OPS)
        .optional()
        .describe('Builder ops, as builder_preview takes them'),
      language: Language.optional(),
    })
    .refine(
      (input) =>
        input.draft === undefined
          ? input.ops !== undefined && input.dashboardId !== undefined
          : input.ops === undefined,
      'Give either draft, or dashboardId with ops',
    ),
  outputSchema: z.object({
    valid: z.boolean(),
    errors: z.array(Issue),
    warnings: z.array(Issue),
  }),
  annotations: READ,
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    if (input.draft !== undefined) {
      return { output: await validateDashboardDraft(ctx.workspace, input.draft, 'mcp') };
    }
    const dashboardId = input.dashboardId ?? '';
    const actor = actorOf(ctx);
    const current = await getDashboard(ctx.workspace, actor, dashboardId, { as: 'draft' });
    const result = await applyDashboardOps(ctx.workspace, actor, dashboardId, {
      expectedVersion: current.version,
      ops: input.ops ?? [],
      dryRun: true,
      language: input.language,
    });
    if (!('valid' in result)) throw new Error('a dry run answered as a write');
    const { valid, errors, warnings } = result;
    return { output: { valid, errors, warnings }, target: { type: 'dashboard', id: dashboardId } };
  },
});

export const builderPreview = defineTool({
  name: 'builder_preview',
  title: 'Preview a change',
  description:
    'A dry run on a dashboard’s draft: with dashboardId alone, the draft as it is; with an RFC 6902 patch, builder ops (as the write tools make them) or a revert to a version, that change applied in memory. Answers whether it would be written, errors and warnings, the diff, the resulting config, and up to sampleRows rows per block. Writes nothing. A builder write is accepted only after this agent previewed the identical change on the same draft version within the last 10 minutes.',
  toolset: 'builder',
  inputSchema: z
    .strictObject({
      dashboardId: DashboardId,
      patch: z
        .array(JsonPatchOp)
        .max(MAX_PATCH_OPERATIONS)
        .optional()
        .describe('Optional RFC 6902 ops to apply in memory'),
      sampleRows: z
        .number()
        .int()
        .min(0)
        .max(MAX_SAMPLE_ROWS)
        .default(5)
        .describe('Preview rows per block, 0 to 20'),
      expectedVersion: ExpectedVersion.optional().describe(
        'The draft version to preview against; default: the current draft',
      ),
      ops: z
        .array(OpSchema)
        .min(1)
        .max(MAX_OPS)
        .optional()
        .describe('Builder ops instead of a patch'),
      revertTo: z.number().int().min(1).optional().describe('Preview restoring this version'),
      language: Language.optional(),
    })
    .refine(
      (input) =>
        [input.ops, input.patch, input.revertTo].filter((part) => part !== undefined).length <= 1,
      'Give at most one of patch, ops or revertTo',
    ),
  outputSchema: z.object({
    valid: z.boolean().describe('Whether the same change would be written'),
    errors: z.array(Issue),
    warnings: z.array(Issue),
    diff: Diff,
    config: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('The resulting draft: title, scope, vars, layouts, blocks; null when invalid'),
    preview: Preview,
  }),
  annotations: READ,
  scopes: ['read'],
  minRole: 'editor',
  async handler(ctx, input) {
    const view = await getDashboard(ctx.workspace, actorOf(ctx), input.dashboardId, {
      as: 'draft',
    });
    // The version previewed against, which D12 binds the preview to: the current draft's unless given.
    const base = {
      dashboardId: input.dashboardId,
      expectedVersion: input.expectedVersion ?? view.version,
    };
    const change: Change =
      input.ops !== undefined
        ? { ...base, kind: 'ops', ops: input.ops, language: input.language }
        : input.revertTo !== undefined
          ? { ...base, kind: 'revert', toVersion: input.revertTo }
          : { ...base, kind: 'patch', patch: input.patch ?? [] };
    const result = await dryRunChange(ctx, change, input.sampleRows);
    let config: Record<string, unknown> | null = null;
    if (result.valid) {
      const { title, scope, vars, layouts, blocks } = view;
      config = tryPatch(json(Config, { title, scope, vars, layouts, blocks }), result.diff);
    }
    return {
      output: {
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        diff: json(Diff, result.diff),
        config,
        preview: json(Preview, result.preview),
      },
      preview: true,
      target: { type: 'dashboard', id: input.dashboardId },
      audit: {
        action: PREVIEW_TOOL,
        meta: { opsHash: changeHash(change), dashboardId: input.dashboardId },
      },
    };
  },
});

const Version = z.object({
  version: z.number().int(),
  actorUserId: z.string(),
  actorAgentId: z.string().nullable(),
  summary: z.string().nullable(),
  at: z.string(),
  hasSnapshot: z.boolean(),
  published: z.boolean(),
});

export const builderListVersions = defineTool({
  name: 'builder_list_versions',
  title: 'List versions',
  description:
    'A dashboard’s history, newest first: version, who changed it (the user, and the agent key if an agent did), when, a summary (e.g. add_block clock, undo:v12, revert:v3), and which version is published.',
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  outputSchema: z.object({ versions: z.array(Version) }),
  annotations: READ,
  scopes: ['read'],
  minRole: 'editor',
  async handler(ctx, input) {
    const versions = await listDashboardVersions(ctx.workspace, actorOf(ctx), input.dashboardId, {
      limit: input.limit,
    });
    return {
      output: { versions: json(z.array(Version), versions) },
      target: { type: 'dashboard', id: input.dashboardId },
    };
  },
});
