import { z } from 'zod';

import { getFacets } from '../../../services/items.js';
import { Topic } from '../../../classes/workspace/index.js';
import { defineTool } from '../../tool.js';
import {
  ItemSummaryView,
  ProviderList,
  TopicList,
  topicIds,
  type ItemSummaryView as Summary,
} from '../itemViews.js';
import { EPOCH, filterRules, findItems, OPEN_STATUSES, range, where } from './bridge.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_BY = ['topic', 'container', 'provider'] as const;

const Group = z.object({
  key: z
    .string()
    .nullable()
    .describe('The topic id, container id or provider; null: Unsorted, or no container'),
  label: z.string().nullable().describe('The topic or container name, when grouped by one'),
  items: z.array(ItemSummaryView),
});
type Group = z.infer<typeof Group>;

function keyOf(item: Summary, groupBy: (typeof GROUP_BY)[number]): string | null {
  if (groupBy === 'topic') return item.topicId;
  if (groupBy === 'provider') return item.source.provider;
  return item.containerId;
}

export const listDeadlines = defineTool({
  name: 'list_deadlines',
  title: 'List deadlines',
  description:
    'Open items due within the next days (14 by default), overdue ones included unless includeOverdue is false, earliest first, grouped by topic, container (project or course) or provider. Each item has source and openIn. Filter by topic and provider.',
  toolset: 'read',
  inputSchema: z.strictObject({
    days: z.number().int().min(1).max(90).default(14).describe('How many days ahead'),
    includeOverdue: z.boolean().default(true),
    groupBy: z.enum(GROUP_BY).default('topic'),
    topic: TopicList,
    provider: ProviderList,
    limit: z.number().int().min(1).max(200).default(100),
  }),
  outputSchema: z.object({
    from: z.string().describe('ISO 8601'),
    to: z.string().describe('ISO 8601'),
    groupBy: z.enum(GROUP_BY),
    groups: z.array(Group).describe('In order of each group’s earliest deadline'),
    total: z.number().int().describe('Every matching item, even past the limit'),
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
    const now = ctx.now();
    const from = input.includeOverdue ? EPOCH : now;
    const to = new Date(now.getTime() + input.days * DAY_MS);
    const { items, total } = await findItems(
      ctx,
      {
        source: 'items',
        ...where([
          ...filterRules({ ...input, topic: await topicIds(ctx.workspace, input.topic) }),
          { field: 'status', operator: 'in', value: OPEN_STATUSES },
        ]),
        dateField: 'dueAt',
        dateRange: range(from, to),
        sort: [{ field: 'dueAt', dir: 'asc' }],
        limit: input.limit,
      },
      now,
    );
    const labels =
      input.groupBy === 'topic'
        ? new Map((await Topic.list(ctx.workspace.id)).map((topic) => [topic.id, topic.name]))
        : input.groupBy === 'container'
          ? new Map(
              (await getFacets(ctx.workspace, ctx.principal.userId)).containers.map((container) => [
                container.id,
                container.name,
              ]),
            )
          : new Map<string, string>();
    const groups = new Map<string | null, Group>();
    for (const item of items) {
      const key = keyOf(item, input.groupBy);
      const group = groups.get(key) ?? {
        key,
        label: key === null ? null : (labels.get(key) ?? null),
        items: [],
      };
      group.items.push(item);
      groups.set(key, group);
    }
    return {
      output: {
        from: from.toISOString(),
        to: to.toISOString(),
        groupBy: input.groupBy,
        groups: [...groups.values()],
        total,
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
