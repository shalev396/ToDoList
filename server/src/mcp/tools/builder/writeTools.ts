/**
 * The builder writes under D12 (common.ts): each takes expectedVersion and dryRun, and writes only
 * a change this agent key previewed in the last 10 minutes. The destructive ones (remove, revert,
 * apply_template with mode replace) preview without confirm: true.
 */
import { z } from 'zod';

import {
  BlockIdSchema,
  BlockPatchSchema,
  FieldPathSchema,
  GridPosSchema,
  LayoutsSchema,
  NewBlockSchema,
  VarRefSchema,
  ViewConfigSchema,
  ViewIdSchema,
  VIEW_TYPES,
} from '../../../types/builder.js';
import { confirmField } from '../../middleware/confirm.js';
import { defineTool, type ToolAnnotations } from '../../tool.js';
import {
  CONNECTORS_NOTE,
  DashboardId,
  DryRun,
  ExpectedVersion,
  JsonPatchOp,
  Language,
  MAX_PATCH_OPERATIONS,
  previewOrWrite,
  previewOutcome,
  WriteOutput,
  type Change,
} from './common.js';

const EDIT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const IDEMPOTENT_EDIT: ToolAnnotations = { ...EDIT, idempotentHint: true };
const DESTRUCTIVE: ToolAnnotations = { ...EDIT, destructiveHint: true };

const D12_NOTE =
  'Preview first (builder_preview, or dryRun: true), then call again unchanged within 10 minutes to write it.';

export const builderAddBlock = defineTool({
  name: 'builder_add_block',
  title: 'Add a block',
  description: `Adds one block to a dashboard's draft. Without a layout it is placed automatically. title and viz may be left out (catalog defaults). The answer's addedBlockIds names the new block. ${CONNECTORS_NOTE} ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    block: NewBlockSchema,
    viewId: ViewIdSchema.optional().describe(
      'A dashboard view’s id (builder_get_dashboard views): the block joins that view’s grid instead of the Summary’s. Rigid views are one block and take none.',
    ),
    layout: z
      .strictObject({
        lg: GridPosSchema.optional(),
        md: GridPosSchema.optional(),
        sm: GridPosSchema.optional(),
      })
      .optional()
      .describe('Its place per breakpoint; default: the first free spot'),
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const op = {
      op: 'add_block' as const,
      block: input.block,
      ...(input.viewId === undefined ? {} : { viewId: input.viewId }),
      ...(input.layout === undefined ? {} : { layout: input.layout }),
    };
    return previewOrWrite(
      ctx,
      {
        kind: 'ops',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        ops: [op],
      },
      input.dryRun,
    );
  },
});

const VIEWS_NOTE =
  'A page has views after its always-first, fixed Summary (the blocks no view names; at most 20 views with the Summary, 40 blocks per grid). A rigid view (list, board, timeline, calendar, table, agenda, workload, timesheet) is one full-page block: edit it with builder_update_block on its blockIds[0] (query = sources’ filter, sort and group; viz = visible fields). A dashboard view is its own grid: builder_add_block with its viewId.';

export const builderAddView = defineTool({
  name: 'builder_add_view',
  title: 'Add a view',
  description: `Adds a view (a tab) to a page's draft: a rigid type (list, board, timeline, calendar, table, agenda, workload, timesheet: one block with that type's defaults, then config on top), a blank dashboard view, or a view template by templateKey (builder_list_templates viewTemplates, e.g. my-open-work@1). On a topic page the view reads that topic. A template's data blocks read the key user's own integrations that match them; attaching one for the first time shares its items with everyone in the workspace, and the preview's shares names each. ${VIEWS_NOTE} ${CONNECTORS_NOTE} ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z
    .strictObject({
      dashboardId: DashboardId,
      expectedVersion: ExpectedVersion,
      type: z.enum(VIEW_TYPES).optional(),
      templateKey: z.string().min(1).max(80).optional().describe('e.g. this-week@1'),
      title: z.string().min(1).max(80).optional(),
      config: ViewConfigSchema.optional().describe(
        'A rigid view only: query, viz, rules, connectors for its block',
      ),
      language: Language.optional(),
      dryRun: DryRun,
    })
    .refine((input) => (input.type === undefined) !== (input.templateKey === undefined), {
      message: 'Give a type or a templateKey, not both',
      path: ['type'],
    }),
  outputSchema: WriteOutput,
  annotations: EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const op = {
      op: 'add_view' as const,
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.config === undefined ? {} : { config: input.config }),
    };
    return previewOrWrite(
      ctx,
      {
        kind: 'ops',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        ops: [op],
        language: input.language,
      },
      input.dryRun,
    );
  },
});

export const builderUpdateView = defineTool({
  name: 'builder_update_view',
  title: 'Rename or move a view',
  description: `Renames a view and/or moves it among the views after the Summary (index 0 = first). The Summary cannot be renamed or moved. ${VIEWS_NOTE} ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z
    .strictObject({
      dashboardId: DashboardId,
      expectedVersion: ExpectedVersion,
      viewId: ViewIdSchema,
      title: z.string().min(1).max(80).optional(),
      index: z.number().int().min(0).max(20).optional(),
      dryRun: DryRun,
    })
    .refine((input) => input.title !== undefined || input.index !== undefined, {
      message: 'Give a title, an index, or both',
      path: ['title'],
    }),
  outputSchema: WriteOutput,
  annotations: IDEMPOTENT_EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const ops = [
      ...(input.title === undefined
        ? []
        : [{ op: 'update_view' as const, viewId: input.viewId, title: input.title }]),
      ...(input.index === undefined
        ? []
        : [{ op: 'move_view' as const, viewId: input.viewId, index: input.index }]),
    ];
    return previewOrWrite(
      ctx,
      {
        kind: 'ops',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        ops,
      },
      input.dryRun,
    );
  },
});

export const builderRemoveView = defineTool({
  name: 'builder_remove_view',
  title: 'Remove a view',
  description: `Removes a view and its blocks from the draft. The Summary cannot be removed. Without confirm: true it only previews. ${VIEWS_NOTE} ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    viewId: ViewIdSchema,
    confirm: confirmField,
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: DESTRUCTIVE,
  scopes: ['builder:write'],
  minRole: 'editor',
  async preview(ctx, input) {
    return previewOutcome(ctx, removeViewChange(input));
  },
  async handler(ctx, input) {
    return previewOrWrite(ctx, removeViewChange(input), input.dryRun);
  },
});

function removeViewChange(input: {
  dashboardId: string;
  expectedVersion: number;
  viewId: string;
}): Change {
  return {
    kind: 'ops',
    dashboardId: input.dashboardId,
    expectedVersion: input.expectedVersion,
    ops: [{ op: 'remove_view', viewId: input.viewId }],
  };
}

export const builderUpdateBlock = defineTool({
  name: 'builder_update_block',
  title: 'Update a block',
  description: `Patches one block of the draft: its title, query, connectors, rules, viz, listen or sets (any field but id and type). ${CONNECTORS_NOTE} ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    blockId: BlockIdSchema,
    patch: BlockPatchSchema,
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: IDEMPOTENT_EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    return previewOrWrite(
      ctx,
      {
        kind: 'ops',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        ops: [{ op: 'update_block', blockId: input.blockId, patch: input.patch }],
      },
      input.dryRun,
    );
  },
});

export const builderArrange = defineTool({
  name: 'builder_arrange',
  title: 'Arrange blocks',
  description: `Sets where blocks sit: gridPos {x, y, w, h} per block, per breakpoint (lg, md, sm) on the 12-column grid. ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    layouts: LayoutsSchema.partial(),
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: IDEMPOTENT_EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    return previewOrWrite(
      ctx,
      {
        kind: 'ops',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        ops: [{ op: 'arrange', layouts: input.layouts }],
      },
      input.dryRun,
    );
  },
});

export const builderConnectBlocks = defineTool({
  name: 'builder_connect_blocks',
  title: 'Connect blocks',
  description: `Wires a cross-filter: the source block (a filter, or a chart click) sets a $page variable, and the target blocks listen to it, filtering on field. ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    fromBlockId: BlockIdSchema,
    variable: VarRefSchema,
    field: FieldPathSchema.optional().describe('The field the variable filters on the targets'),
    toBlockIds: z.array(BlockIdSchema).min(1).max(40),
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: IDEMPOTENT_EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const op = {
      op: 'connect_blocks' as const,
      fromBlockId: input.fromBlockId,
      variable: input.variable,
      ...(input.field === undefined ? {} : { field: input.field }),
      toBlockIds: input.toBlockIds,
    };
    return previewOrWrite(
      ctx,
      {
        kind: 'ops',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        ops: [op],
      },
      input.dryRun,
    );
  },
});

export const builderApplyPatch = defineTool({
  name: 'builder_apply_patch',
  title: 'Apply a JSON Patch',
  description: `The power tool: an RFC 6902 JSON Patch on the draft's /title, /vars, /layouts and /blocks (never its scope). The result is validated and linted like any change. ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    patch: z.array(JsonPatchOp).min(1).max(MAX_PATCH_OPERATIONS),
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: EDIT,
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    return previewOrWrite(
      ctx,
      {
        kind: 'patch',
        dashboardId: input.dashboardId,
        expectedVersion: input.expectedVersion,
        patch: input.patch,
      },
      input.dryRun,
    );
  },
});

export const builderApplyTemplate = defineTool({
  name: 'builder_apply_template',
  title: 'Apply a template',
  description: `Applies a template (builder_list_templates) to the draft: mode merge adds its blocks; mode replace replaces the draft's blocks with the template's and needs confirm: true (without it, it only previews). Its data blocks read the key user's own integrations that match them; attaching one for the first time shares its items with everyone in the workspace, and the preview's shares names each. ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    templateKey: z.string().min(1).max(80).describe('e.g. college@1, or college'),
    mode: z.enum(['merge', 'replace']),
    language: Language.optional(),
    confirm: confirmField,
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: DESTRUCTIVE,
  scopes: ['builder:write'],
  minRole: 'editor',
  needsConfirm: (input) => input.mode === 'replace',
  async preview(ctx, input) {
    return previewOutcome(ctx, templateChange(input));
  },
  async handler(ctx, input) {
    return previewOrWrite(ctx, templateChange(input), input.dryRun);
  },
});

function templateChange(input: {
  dashboardId: string;
  expectedVersion: number;
  templateKey: string;
  mode: 'merge' | 'replace';
  language?: 'en' | 'he' | undefined;
}): Change {
  return {
    kind: 'ops',
    dashboardId: input.dashboardId,
    expectedVersion: input.expectedVersion,
    ops: [{ op: 'apply_template', templateKey: input.templateKey, mode: input.mode }],
    language: input.language,
  };
}

export const builderRemoveBlock = defineTool({
  name: 'builder_remove_block',
  title: 'Remove a block',
  description: `Removes a block from the draft, and the cross-filters wired to it. Without confirm: true it only previews. ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    blockId: BlockIdSchema,
    confirm: confirmField,
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: DESTRUCTIVE,
  scopes: ['builder:write'],
  minRole: 'editor',
  async preview(ctx, input) {
    return previewOutcome(ctx, removeChange(input));
  },
  async handler(ctx, input) {
    return previewOrWrite(ctx, removeChange(input), input.dryRun);
  },
});

function removeChange(input: {
  dashboardId: string;
  expectedVersion: number;
  blockId: string;
}): Change {
  return {
    kind: 'ops',
    dashboardId: input.dashboardId,
    expectedVersion: input.expectedVersion,
    ops: [{ op: 'remove_block', blockId: input.blockId }],
  };
}

export const builderRevert = defineTool({
  name: 'builder_revert',
  title: 'Revert to a version',
  description: `Restores the draft as it was at a version (builder_list_versions), as a new version: nothing in the history is lost. Without confirm: true it only previews. ${D12_NOTE}`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    toVersion: z.number().int().min(1),
    confirm: confirmField,
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: DESTRUCTIVE,
  scopes: ['builder:write'],
  minRole: 'editor',
  async preview(ctx, input) {
    return previewOutcome(ctx, revertChange(input));
  },
  async handler(ctx, input) {
    return previewOrWrite(ctx, revertChange(input), input.dryRun);
  },
});

function revertChange(input: {
  dashboardId: string;
  expectedVersion: number;
  toVersion: number;
}): Change {
  return {
    kind: 'revert',
    dashboardId: input.dashboardId,
    expectedVersion: input.expectedVersion,
    toVersion: input.toVersion,
  };
}
