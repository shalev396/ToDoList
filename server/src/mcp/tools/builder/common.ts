/**
 * What the builder tools share (MCP.md §8): their input fields, the shapes they answer with, and
 * D12, preview before write.
 *
 * D12: every builder write (add, update, arrange, connect, patch, template, remove, revert) is
 * refused unless the same agent key previewed the identical change in the last 10 minutes. A
 * preview is any dry run: builder_preview, a write tool called with dryRun: true, or a destructive
 * tool called without confirm. Each is audited as `mcp.builder_preview` with the change's opsHash:
 * the canonical hash of what the change does and to which draft (dashboard, the draft version it
 * was previewed against, ops or patch or revert target, template language), not of how it was
 * asked, so builder_preview's ops and the write tool's own input hash the same. The version is
 * part of it: once anyone writes, earlier previews no longer match, and the change is previewed
 * again on the draft it will really apply to.
 */
import { z } from 'zod';

import type { TemplateLanguage } from '../../../builder/templates.js';
import { TEMPLATE_LANGUAGES } from '../../../builder/templates.js';
import { AppError } from '../../../errors/AppError.js';
import { getAuditLogRepository } from '../../../models/index.js';
import {
  applyDashboardOps,
  applyDashboardPatch,
  getDashboard,
  previewRevert,
  revertDashboard,
  type BuilderActor,
  type DashboardOpsResult,
} from '../../../services/dashboards.js';
import type { Op } from '../../../types/builder.js';
import type {
  DashboardDryRunResult,
  DashboardWriteResult,
  JsonPatchOperation,
} from '../../../types/dashboards.js';
import { DASHBOARD_PAGES } from '../../../types/domain.js';
import { argsHash } from '../../middleware/audit.js';
import type { ToolContext, ToolOutcome } from '../../tool.js';

export const PREVIEW_WINDOW_MS = 10 * 60 * 1000;
/** The tool name a dry run is audited under. */
export const PREVIEW_TOOL = 'builder_preview';
export const MAX_OPS = 50;
export const MAX_PATCH_OPERATIONS = 100;

// ─── Inputs ─────────────────────────────────────────────────────────────────

export const DashboardId = z
  .string()
  .min(1)
  .max(100)
  .describe('A dashboard id, from builder_list_dashboards');
export const ExpectedVersion = z
  .number()
  .int()
  .min(1)
  .describe(
    'The draft version you last read (builder_get_dashboard, or the last write’s answer); a stale one fails with the currentVersion',
  );
export const DryRun = z
  .boolean()
  .default(false)
  .describe(
    'true: only preview the change (valid, errors, diff, preview rows); nothing is written. Counts as builder_preview',
  );
export const Language = z
  .enum(TEMPLATE_LANGUAGES)
  .describe('The language of template titles (default en)');

const Pointer = z
  .string()
  .max(300)
  .regex(/^(\/[^/]*)*$/, 'must be a JSON pointer');
export const JsonPatchOp = z.union([
  z.strictObject({ op: z.enum(['add', 'replace', 'test']), path: Pointer, value: z.unknown() }),
  z.strictObject({ op: z.literal('remove'), path: Pointer }),
  z.strictObject({ op: z.enum(['move', 'copy']), from: Pointer, path: Pointer }),
]);

// ─── Outputs ────────────────────────────────────────────────────────────────

export const Issue = z.object({
  code: z.string().describe('invalid, op, or a lint rule (hardcoded_text, …)'),
  pointer: z.string().describe('JSON pointer to what is wrong'),
  message: z.string(),
});

const PatchOperation = z.object({
  op: z.string(),
  path: z.string(),
  from: z.string().optional(),
  value: z.unknown().optional(),
});

export const Diff = z
  .array(PatchOperation)
  .describe('RFC 6902 operations from the current draft to the result');
export const Preview = z
  .record(z.string(), z.unknown())
  .describe('Block id → its first rows or groups, or why it could not run');

/** What a change would share: the key user's own integrations it attaches for the first time. */
export const Shares = z
  .array(
    z.object({
      id: z.string().describe('The integration id (integrations_list)'),
      provider: z.string(),
      accountLabel: z.string(),
    }),
  )
  .describe(
    "The key user's own integrations this change attaches to a block for the first time: applying it shares their items with everyone in the workspace. Empty: it shares nothing new",
  );

/** The sentence a preview's summary adds when applying it would share something. */
export function sharesSentence(
  shares: readonly { provider: string; accountLabel: string }[],
): string {
  if (shares.length === 0) return '';
  const names = shares.map((share) => `${share.provider} (${share.accountLabel})`).join(', ');
  return ` Applying it shares the items of ${names} with everyone in this workspace (see shares).`;
}

export const WriteOutput = z.object({
  applied: z.boolean().describe('false: a dry run or preview, nothing was written'),
  version: z.number().int().describe('The draft version now: the next expectedVersion'),
  valid: z.boolean().describe('Whether the change passes validation and lint'),
  errors: z.array(Issue),
  warnings: z.array(Issue),
  diff: Diff,
  preview: Preview,
  shares: Shares,
  addedBlockIds: z.array(z.string()).describe('Written: the blocks the change added'),
  summary: z.string(),
});
export type WriteOutput = z.output<typeof WriteOutput>;

export const DashboardScope = z.looseObject({
  topicId: z.string().nullable().describe('Its topic (page) id; null: the main dashboard'),
  containerId: z.string().nullable(),
  page: z.enum(DASHBOARD_PAGES),
  groupVar: z.string().nullable(),
});

/** A dashboard as builder_get_dashboard (and builder_create_dashboard) answers it. */
export const DashboardView = z.object({
  id: z.string(),
  as: z.enum(['draft', 'published']),
  title: z.string(),
  scope: DashboardScope,
  templateKey: z.string().nullable(),
  visibility: z.string(),
  vars: z.record(z.string(), z.unknown()),
  layouts: z.record(z.string(), z.unknown()),
  blocks: z.array(z.record(z.string(), z.unknown())),
  views: z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'The page’s views after the Summary, in tab order: {id, type, title, blockIds, templateKey?}. The Summary is the blocks no view names; it is always first and cannot be removed.',
    ),
  version: z.number().int(),
  publishedVersion: z.number().int().nullable(),
  updatedBy: z.object({ userId: z.string().nullable(), agentId: z.string().nullable() }),
  updatedAt: z.string(),
});

/** Plain JSON (dates as ISO strings), the shape structuredContent carries, read as the schema. */
export function json<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

export function actorOf(ctx: ToolContext): BuilderActor {
  return { userId: ctx.principal.userId, agentId: ctx.principal.agentId };
}

// ─── D12 ────────────────────────────────────────────────────────────────────

interface ChangeBase {
  dashboardId: string;
  expectedVersion: number;
}

/** A change to a draft, as a write tool makes it. */
export type Change = ChangeBase &
  (
    | { kind: 'ops'; ops: Op[]; language?: TemplateLanguage | undefined }
    | { kind: 'patch'; patch: JsonPatchOperation[] }
    | { kind: 'revert'; toVersion: number }
  );

/**
 * D12's "identical": what the change does, on which draft version (a write's expectedVersion is
 * the version it applies to). The language only matters to apply_template.
 */
export function changeHash(change: Change): string {
  const base = { dashboardId: change.dashboardId, version: change.expectedVersion };
  if (change.kind === 'patch') return argsHash({ ...base, patch: change.patch });
  if (change.kind === 'revert') return argsHash({ ...base, revertTo: change.toVersion });
  const templated = change.ops.some(
    (op) => op.op === 'apply_template' || (op.op === 'add_view' && op.templateKey !== undefined),
  );
  return argsHash({
    ...base,
    ops: change.ops,
    ...(templated ? { language: change.language ?? 'en' } : {}),
  });
}

/** Refused (isError) unless this agent key previewed the identical change in the window. */
export async function requirePreview(ctx: ToolContext, change: Change): Promise<void> {
  const entry = await (
    await getAuditLogRepository()
  ).findRecent(ctx.principal.workspaceId, {
    action: `mcp.${PREVIEW_TOOL}`,
    actorAgentId: ctx.principal.agentId,
    metaEquals: { opsHash: changeHash(change) },
    since: new Date(ctx.now().getTime() - PREVIEW_WINDOW_MS),
  });
  if (entry === null) {
    throw new AppError(
      409,
      'Preview first: call builder_preview with this same change (or this tool with dryRun: true), check the result, then apply it unchanged within 10 minutes.',
    );
  }
}

function dryRunOf(result: DashboardOpsResult): DashboardDryRunResult {
  if ('valid' in result) return result;
  throw new Error('a dry run answered as a write');
}

function writeOf(result: DashboardOpsResult): DashboardWriteResult {
  if ('valid' in result) throw new Error('a write answered as a dry run');
  return result;
}

/** The change worked out without writing it. */
export async function dryRunChange(
  ctx: ToolContext,
  change: Change,
  previewRows?: number,
): Promise<DashboardDryRunResult> {
  const actor = actorOf(ctx);
  const { dashboardId, expectedVersion } = change;
  switch (change.kind) {
    case 'ops':
      return dryRunOf(
        await applyDashboardOps(ctx.workspace, actor, dashboardId, {
          expectedVersion,
          ops: change.ops,
          dryRun: true,
          language: change.language,
          previewRows,
        }),
      );
    case 'patch':
      return dryRunOf(
        await applyDashboardPatch(ctx.workspace, actor, dashboardId, {
          expectedVersion,
          patch: change.patch,
          dryRun: true,
          previewRows,
        }),
      );
    case 'revert':
      return previewRevert(ctx.workspace, actor, dashboardId, {
        expectedVersion,
        toVersion: change.toVersion,
        previewRows,
      });
  }
}

/** A dry run, audited as builder_preview with the change's opsHash (D12). */
export async function previewOutcome(
  ctx: ToolContext,
  change: Change,
): Promise<ToolOutcome<WriteOutput>> {
  const result = await dryRunChange(ctx, change);
  return {
    output: {
      applied: false,
      version: change.expectedVersion,
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      diff: json(Diff, result.diff),
      preview: json(Preview, result.preview),
      shares: result.shares,
      addedBlockIds: [],
      summary: result.valid
        ? `Preview: nothing was written. To apply it, call again unchanged, without dryRun (and with confirm: true where needed), within 10 minutes.${sharesSentence(result.shares)}`
        : 'Preview: this change would be refused; see errors. Nothing was written.',
    },
    preview: true,
    target: { type: 'dashboard', id: change.dashboardId },
    audit: {
      action: PREVIEW_TOOL,
      meta: { opsHash: changeHash(change), dashboardId: change.dashboardId },
    },
  };
}

async function blockIds(ctx: ToolContext, dashboardId: string): Promise<string[]> {
  const view = await getDashboard(ctx.workspace, actorOf(ctx), dashboardId, { as: 'draft' });
  return view.blocks.map((block) => block.id);
}

/** The write, after D12: refused unless previewed. */
export async function writeOutcome(
  ctx: ToolContext,
  change: Change,
): Promise<ToolOutcome<WriteOutput>> {
  await requirePreview(ctx, change);
  const actor = actorOf(ctx);
  const { dashboardId, expectedVersion } = change;
  const before = await blockIds(ctx, dashboardId);
  let result: DashboardWriteResult;
  switch (change.kind) {
    case 'ops':
      result = writeOf(
        await applyDashboardOps(ctx.workspace, actor, dashboardId, {
          expectedVersion,
          ops: change.ops,
          language: change.language,
        }),
      );
      break;
    case 'patch':
      result = writeOf(
        await applyDashboardPatch(ctx.workspace, actor, dashboardId, {
          expectedVersion,
          patch: change.patch,
        }),
      );
      break;
    case 'revert':
      result = await revertDashboard(ctx.workspace, actor, dashboardId, {
        expectedVersion,
        toVersion: change.toVersion,
      });
      break;
  }
  const after = await blockIds(ctx, dashboardId);
  return {
    output: {
      applied: true,
      version: result.version,
      valid: true,
      errors: [],
      warnings: result.warnings,
      diff: [],
      preview: {},
      shares: [],
      addedBlockIds: after.filter((id) => !before.includes(id)),
      summary: `Written: the draft is now version ${String(result.version)}. Viewers see it once an owner publishes it.`,
    },
    target: { type: 'dashboard', id: dashboardId },
  };
}

/** A write tool's handler: its dry run, or the write. */
export async function previewOrWrite(
  ctx: ToolContext,
  change: Change,
  dryRun: boolean,
): Promise<ToolOutcome<WriteOutput>> {
  return dryRun ? previewOutcome(ctx, change) : writeOutcome(ctx, change);
}

/**
 * How a block names its sources (PERMISSIONS-V2): its `connectors`, integration ids (many-to-one:
 * two Jira accounts have two ids) plus `local` for local to-dos. Attaching shares an integration's
 * items with the whole workspace, so only the key user's own integrations can be added.
 */
export const CONNECTORS_NOTE =
  "A block reads its sources from block.connectors: integration ids from integrations_list (only the member's own can be added; adding one shares its items with the whole workspace, and a preview's shares names what would become shared), plus 'local' for local to-dos. Without a connectors field a block reads everything its viewer may see; an empty list reads nothing (connectors: null in update_block takes the field off). Another member's connector already on a block may stay or be removed, never added.";
