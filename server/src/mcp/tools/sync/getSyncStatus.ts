import { z } from 'zod';

import {
  getSyncRun,
  listSyncRuns,
  SYNC_RUNS_DEFAULT_LIMIT,
  SYNC_RUNS_MAX_LIMIT,
} from '../../../services/syncRuns.js';
import { userCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';
import { IntegrationId, RunId, RunView, toRunView } from './views.js';

export const getSyncStatus = defineTool({
  name: 'get_sync_status',
  title: 'Sync status',
  description:
    'With a runId (from sync_now): that run, to poll until its status is succeeded, partial or failed. Without: the newest runs of the member’s own integrations, or of one of them, newest first. Each run has its counts and, when it failed, an error code with its fixed message. Another member’s integration or run is not found.',
  toolset: 'sync',
  inputSchema: z.strictObject({
    runId: RunId.optional(),
    integrationId: IntegrationId.optional().describe('Without runId: this integration’s runs only'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SYNC_RUNS_MAX_LIMIT)
      .default(SYNC_RUNS_DEFAULT_LIMIT)
      .describe('Without runId: how many runs'),
  }),
  outputSchema: z.object({ runs: z.array(RunView) }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    if (input.runId !== undefined) {
      const run = await getSyncRun(userCaller(ctx), input.runId);
      return { output: { runs: [toRunView(run)] }, target: { type: 'sync_run', id: run.id } };
    }
    const runs = await listSyncRuns(userCaller(ctx), {
      integrationId: input.integrationId,
      limit: input.limit,
    });
    return { output: { runs: runs.map(toRunView) } };
  },
});
