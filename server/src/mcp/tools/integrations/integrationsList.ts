import { z } from 'zod';

import { listOwnIntegrations } from '../../../services/integrationOwnership.js';
import { ItemPolicy } from '../../../classes/policies/ItemPolicy.js';
import { defineTool } from '../../tool.js';
import { IntegrationStatus, toIntegrationStatusView } from './views.js';

export const integrationsList = defineTool({
  name: 'integrations_list',
  title: 'List integrations',
  description:
    'The member’s own connected providers in this workspace, oldest first: id, provider, account label, status (connected, expired or error), when the connection expires and when it last synced; shared lists the ids of those on a block (so the whole workspace sees their items). Other members’ integrations are never listed. Nothing else of an integration is ever shown.',
  toolset: 'integrations',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    integrations: z.array(IntegrationStatus),
    shared: z
      .array(z.string())
      .describe('The ids of these integrations that are on a block of some dashboard: shared'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['integrations:read'],
  minRole: 'viewer',
  async handler(ctx) {
    const integrations = await listOwnIntegrations(ctx.workspace, ctx.principal.userId);
    const shared = await ItemPolicy.sharedConnectorIds(ctx.workspace.id);
    return {
      output: {
        integrations: integrations.map(toIntegrationStatusView),
        shared: integrations.flatMap(({ id }) => (shared.has(id) ? [id] : [])),
      },
    };
  },
});
