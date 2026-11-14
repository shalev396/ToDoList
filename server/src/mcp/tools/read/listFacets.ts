import { z } from 'zod';

import { getFacets } from '../../../services/items.js';
import { listTopics } from '../../../services/topics.js';
import { CONTAINER_TYPES, ITEM_KINDS, ITEM_STATUSES, PROVIDERS } from '../../../types/domain.js';
import { defineTool } from '../../tool.js';
import { TopicList, withinTopics } from '../itemViews.js';

export const listFacets = defineTool({
  name: 'list_facets',
  title: 'List facets',
  description:
    'What the agent can filter by, from the data itself: the providers, topics (pages), item kinds and statuses present, and the containers (projects, courses, lists, calendars, folders, repos) with their ids.',
  toolset: 'read',
  inputSchema: z.strictObject({ topic: TopicList }),
  outputSchema: z.object({
    providers: z.array(z.enum(PROVIDERS)),
    topics: z
      .array(z.object({ id: z.string(), slug: z.string(), name: z.string() }))
      .describe('The topics there are items or containers of (Unsorted ones are not listed)'),
    kinds: z.array(z.enum(ITEM_KINDS)),
    statuses: z.array(z.enum(ITEM_STATUSES)),
    containers: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.enum(CONTAINER_TYPES),
          topicId: z.string().nullable().describe('null: Unsorted'),
          provider: z.enum(PROVIDERS),
        }),
      )
      .describe('Up to 500, by name'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    const facets = await getFacets(
      await withinTopics(ctx.workspace, input.topic),
      ctx.principal.userId,
    );
    const present = new Set(facets.topics);
    const topics = (await listTopics(ctx.workspace))
      .filter((topic) => present.has(topic.id))
      .map(({ id, slug, name }) => ({ id, slug, name }));
    return {
      output: {
        providers: [...facets.providers],
        topics,
        kinds: [...facets.kinds],
        statuses: [...facets.statuses],
        containers: facets.containers.map(({ id, name, type, topicId, provider }) => ({
          id,
          name,
          type,
          topicId,
          provider,
        })),
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
