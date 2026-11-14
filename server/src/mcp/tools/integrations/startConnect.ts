import { z } from 'zod';

import { createConnectLink } from '../../../services/connectLinks.js';
import { CONNECTABLE_PROVIDERS } from '../../../types/integrations.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';

export const integrationsStartConnect = defineTool({
  name: 'integrations_start_connect',
  title: 'Start connecting a provider',
  description:
    'Gives a link for the user to open, signed in: the Integrations page, on the provider’s connect form, where the user connects it (Moodle is coming soon and is refused). The link works once, for 10 minutes, and only for the user this agent acts for. There is no tool to set, read, test or rotate what a provider needs to connect, by design: show the link to the user.',
  toolset: 'integrations',
  inputSchema: z.strictObject({ provider: z.enum(CONNECTABLE_PROVIDERS) }),
  outputSchema: z.strictObject({
    provider: z.enum(CONNECTABLE_PROVIDERS),
    connectUrl: z.string().describe('For the user to open, signed in; single use'),
    expiresAt: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['integrations:connect'],
  minRole: 'editor',
  async handler(ctx, input) {
    const link = await createConnectLink(
      ctx.workspace,
      toolCaller(ctx).actor,
      input.provider,
      ctx.now(),
    );
    return {
      output: {
        provider: link.provider,
        connectUrl: link.connectUrl,
        expiresAt: link.expiresAt.toISOString(),
      },
      audit: { meta: { provider: link.provider } },
    };
  },
});
