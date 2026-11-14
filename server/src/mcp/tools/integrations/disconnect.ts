import { z } from 'zod';

import { findOwnIntegration } from '../../../services/integrationOwnership.js';
import { disconnectIntegration } from '../../../services/integrations.js';
import { ItemPolicy } from '../../../classes/policies/ItemPolicy.js';
import { toolCaller } from '../../auth/principal.js';
import { confirmField } from '../../middleware/confirm.js';
import { defineTool } from '../../tool.js';
import { IntegrationId } from '../sync/views.js';
import { IntegrationStatus, toIntegrationStatusView } from './views.js';

export const integrationsDisconnect = defineTool({
  name: 'integrations_disconnect',
  title: 'Disconnect an integration',
  description:
    'Disconnects one of the member’s own integrations, whatever their role: syncing stops, what it stored to connect is wiped, and its items and containers are deleted (purged 30 days later); blocks it was on show that a source was removed. Another member’s integration is not found. Without confirm: true it only previews the disconnect and changes nothing.',
  toolset: 'integrations',
  inputSchema: z.strictObject({ integrationId: IntegrationId, confirm: confirmField }),
  outputSchema: z.object({
    applied: z.boolean().describe('false: a preview, nothing changed'),
    integration: IntegrationStatus.describe('The integration as it was'),
    shared: z
      .boolean()
      .describe('It was on a block: those blocks now show that a source was removed'),
    summary: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['integrations:connect'],
  // Its owner at any role, as in the UI (ruling 10): a viewer keeps control of their own.
  minRole: 'viewer',
  async preview(ctx, input) {
    const integration = await findOwnIntegration(
      ctx.workspace,
      ctx.principal.userId,
      input.integrationId,
    );
    return {
      output: {
        applied: false,
        integration: toIntegrationStatusView(integration),
        shared: await ItemPolicy.isShared(integration),
        summary:
          'Preview: this integration would be disconnected and its items deleted. Nothing changed; call again with confirm: true to disconnect it.',
      },
      target: { type: 'integration', id: integration.id },
    };
  },
  async handler(ctx, input) {
    const integration = await findOwnIntegration(
      ctx.workspace,
      ctx.principal.userId,
      input.integrationId,
    );
    const shared = await ItemPolicy.isShared(integration);
    await disconnectIntegration(ctx.workspace, toolCaller(ctx).actor, integration.id);
    return {
      output: {
        applied: true,
        integration: toIntegrationStatusView(integration),
        shared,
        summary: 'The integration was disconnected.',
      },
      target: { type: 'integration', id: integration.id },
    };
  },
});
