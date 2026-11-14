import { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import type { PlanNarrowing } from '../../../gcal/plan.js';
import { gcalSync } from '../../../services/gcalSync.js';
import { listOwnIntegrations } from '../../../services/integrationOwnership.js';
import { RuleGroupSchema } from '../../../types/builder.js';
import { defineTool } from '../../tool.js';

/**
 * The one agent-triggered provider write (MCP.md §5.7): to the personal Google Calendar through
 * the member's OAuth grant, via services/gcalSync.ts. A dry run (the default) returns the diff and
 * writes nothing.
 */
const ItemRef = z.object({ id: z.string(), title: z.string() });

export const syncToGoogleCalendar = defineTool({
  name: 'sync_to_google_calendar',
  title: 'Push to Google Calendar',
  description:
    'Pushes the filtered items (with a due date in range) to the personal Google Calendar set on the Google Calendar integration; the agent does not choose the calendar. dryRun defaults to true: only the create/update/skip diff, nothing written. With dryRun false it queues the push and returns its run id (poll get_sync_status). Writes are idempotent per item.',
  toolset: 'sync',
  inputSchema: z.strictObject({
    itemFilter: RuleGroupSchema.optional().describe(
      'Which items: a where group, as in query_items. Default: every item with a due date in range',
    ),
    range: z
      .strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional() })
      .optional()
      .describe('Due dates from and to (YYYY-MM-DD, in the workspace time zone)'),
    dryRun: z.boolean().default(true).describe('true (the default): the diff only'),
  }),
  outputSchema: z.object({
    dryRun: z.boolean(),
    runId: z.string().nullable().describe('The queued push, when dryRun was false'),
    diff: z.object({
      create: z.array(ItemRef),
      update: z.array(ItemRef),
      skip: z.array(ItemRef.extend({ reason: z.string() })),
    }),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  scopes: ['gcal:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    // The member's own calendar only, with their own items only (ruling 12).
    const integrations = await listOwnIntegrations(ctx.workspace, ctx.principal.userId);
    const integration = integrations.find(
      (candidate) =>
        candidate.provider === 'google_calendar' &&
        candidate.authMethod === 'oauth' &&
        candidate.status !== 'paused' &&
        candidate.status !== 'expired',
    );
    if (integration === undefined) {
      throw new AppError(409, 'No Google Calendar integration is connected.');
    }
    const range: NonNullable<PlanNarrowing['range']> = {
      ...(input.range?.from === undefined ? {} : { from: input.range.from }),
      ...(input.range?.to === undefined ? {} : { to: input.range.to }),
    };
    const narrowing: PlanNarrowing = {
      ...(input.itemFilter === undefined ? {} : { where: input.itemFilter }),
      ...(input.range === undefined ? {} : { range }),
    };
    const narrowed = input.itemFilter !== undefined || input.range !== undefined;
    if (input.dryRun || narrowed) {
      if (!input.dryRun) {
        throw new AppError(
          400,
          'itemFilter and range apply to a dry run only: the push follows the integration filter.',
        );
      }
      const plan = await gcalSync(ctx.workspace, ctx.principal.userId, {
        integrationId: integration.id,
        confirm: false,
        ...(narrowed ? { narrowing } : {}),
      });
      if (!plan.dryRun) throw new AppError(500, 'Unexpected result');
      const refs = (type: 'create' | 'update'): { id: string; title: string }[] =>
        plan.entries
          .filter((entry) => entry.type === type)
          .map((entry) => ({ id: entry.itemId, title: entry.title }));
      return {
        output: {
          dryRun: true,
          runId: null,
          diff: {
            create: refs('create'),
            update: refs('update'),
            skip: plan.skipped.map((s) => ({ id: s.itemId, title: s.title, reason: s.reason })),
          },
        },
        preview: true,
      };
    }
    const queued = await gcalSync(ctx.workspace, ctx.principal.userId, {
      integrationId: integration.id,
      confirm: true,
    });
    if (queued.dryRun) throw new AppError(500, 'Unexpected result');
    return {
      output: { dryRun: false, runId: queued.runId, diff: { create: [], update: [], skip: [] } },
      target: { type: 'integration', id: integration.id },
    };
  },
});
