import { z } from 'zod';

import { Integration } from '../../../classes/integration/index.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';
import { TopicRef, topicIdOf } from '../itemViews.js';
import { IntegrationId } from '../sync/views.js';

export const setFileUnder = defineTool({
  name: 'set_file_under',
  title: 'File an integration or one of its calendars under a topic',
  description:
    'Files one of the member’s own integrations under a topic (topic null: Unsorted), or, with containerId, one of its calendars or projects (topic null: back to the connection’s topic). What is already stored moves at once, with no call to the provider; a topic set by hand on an item is kept. Returns the topic filed under, the name rule a container got (null when none) and how many containers and items moved. Another member’s integration is not found. Owner only.',
  toolset: 'workspace',
  inputSchema: z.strictObject({
    integrationId: IntegrationId,
    containerId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('A calendar or project of that integration, as facets list them'),
    topic: TopicRef.nullable(),
  }),
  outputSchema: z.object({
    integrationId: z.string(),
    containerId: z.string().nullable(),
    topicId: z.string().nullable().describe('The topic filed under; null: Unsorted or no rule'),
    rule: z.object({ match: z.string(), topicId: z.string() }).nullable(),
    refiled: z.object({ containers: z.number(), items: z.number() }),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['workspace:share'],
  minRole: 'owner',
  async handler(ctx, input) {
    const caller = toolCaller(ctx);
    const integration = await Integration.findOwn(caller, input.integrationId);
    const topicId = (await topicIdOf(ctx.workspace, input.topic)) ?? null;
    const target = { type: 'integration', id: integration.id };
    if (input.containerId !== undefined) {
      const result = await integration.fileContainerUnder(caller, input.containerId, topicId);
      return {
        output: {
          integrationId: integration.id,
          containerId: input.containerId,
          topicId: result.rule?.topicId ?? null,
          rule:
            result.rule === null
              ? null
              : { match: result.rule.match, topicId: result.rule.topicId },
          refiled: result.refiled,
        },
        target,
      };
    }
    const result = await integration.fileUnder(caller, topicId);
    return {
      output: {
        integrationId: integration.id,
        containerId: null,
        topicId: result.integration.topicId,
        rule: null,
        refiled: result.refiled,
      },
      target,
    };
  },
});
