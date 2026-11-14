import { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import { listOwnIntegrations } from '../../../services/integrationOwnership.js';
import { requestIntegrationSync } from '../../../services/syncRuns.js';
import { defineTool } from '../../tool.js';
import { IntegrationId } from './views.js';

const MAX_INTEGRATIONS = 50;

const Skipped = z.object({
  integrationId: z.string(),
  reason: z.string(),
  retryAfterMs: z
    .number()
    .nullable()
    .describe('Synced manually moments ago: how long until it may be synced again'),
});
type Skipped = z.output<typeof Skipped>;

export const syncNow = defineTool({
  name: 'sync_now',
  title: 'Sync now',
  description:
    'Queues a pull from the providers: of the given integrations, or of every one the member owns here (only an integration’s owner syncs it). Returns a run id per queued sync at once (poll get_sync_status with it) and, for each integration left out, why: it waits for its owner (paused, expired, needs reconnecting), was synced manually moments ago (with the wait), or was not found.',
  toolset: 'sync',
  inputSchema: z.strictObject({
    integrationIds: z
      .array(IntegrationId)
      .min(1)
      .max(MAX_INTEGRATIONS)
      .optional()
      .describe('Default: every integration the member owns here'),
  }),
  outputSchema: z.object({ runIds: z.array(z.string()), skipped: z.array(Skipped) }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  scopes: ['sync'],
  minRole: 'editor',
  async handler(ctx, input) {
    const ids =
      input.integrationIds === undefined
        ? (await listOwnIntegrations(ctx.workspace, ctx.principal.userId)).map(
            (integration) => integration.id,
          )
        : [...new Set(input.integrationIds)];
    const runIds: string[] = [];
    const skipped: Skipped[] = [];
    for (const integrationId of ids) {
      try {
        const outcome = await requestIntegrationSync(
          ctx.workspace,
          ctx.principal.userId,
          integrationId,
        );
        if ('runId' in outcome) runIds.push(outcome.runId);
        else {
          skipped.push({
            integrationId,
            reason: 'It was synced manually moments ago',
            retryAfterMs: outcome.retryAfterMs,
          });
        }
      } catch (error) {
        // Not found, waiting for its owner, or the queue failed: said per integration.
        if (!(error instanceof AppError)) throw error;
        skipped.push({ integrationId, reason: error.message, retryAfterMs: null });
      }
    }
    return {
      output: { runIds, skipped },
      audit: { meta: { queued: String(runIds.length), skipped: String(skipped.length) } },
    };
  },
});
