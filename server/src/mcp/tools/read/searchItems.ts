import { z } from 'zod';

import { defineTool } from '../../tool.js';
import {
  TopicList,
  topicIds,
  ItemSummaryView,
  itemReads,
  KindList,
  ProviderList,
  StatusList,
  toItemSummaryView,
} from '../itemViews.js';

const IsoDateTime = z.iso.datetime({ offset: true });

export const searchItems = defineTool({
  name: 'search_items',
  title: 'Search items',
  description:
    'Searches every item the agent may see, mirrored and local: text in titles and previews, and filters by topic, provider, kind, status, container and due date. Time blocks, areas and travel legs (kinds block and travel) are not tasks: they come back only when kind names them. Sorted by due date (no date last), then id; page with cursor and nextCursor. Each item has source and openIn (where to open it).',
  toolset: 'read',
  inputSchema: z.strictObject({
    q: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Words to find in titles and previews'),
    topic: TopicList,
    provider: ProviderList,
    kind: KindList,
    status: StatusList,
    containerId: z.string().min(1).max(100).optional().describe('A container id from list_facets'),
    dueFrom: IsoDateTime.optional(),
    dueTo: IsoDateTime.optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(500).optional().describe('The nextCursor of the previous page'),
  }),
  outputSchema: z.object({
    items: z.array(ItemSummaryView),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass it as cursor for the next page; null at the end'),
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
    const { topic, ...filters } = input;
    const page = await (
      await itemReads(ctx)
    ).list({
      ...filters,
      topicId: await topicIds(ctx.workspace, topic),
    });
    return {
      output: { items: page.items.map(toItemSummaryView), nextCursor: page.nextCursor },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
