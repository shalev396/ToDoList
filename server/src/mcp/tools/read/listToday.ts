import { z } from 'zod';

import { resolveDatePreset } from '../../../builder/dates.js';
import { defineTool } from '../../tool.js';
import { ItemSummaryView, ProviderList, TopicList, topicIds } from '../itemViews.js';
import { EPOCH, filterRules, findItems, OPEN_STATUSES, range, where } from './bridge.js';

const LIMIT = 100;

export const listToday = defineTool({
  name: 'list_today',
  title: 'List today',
  description:
    'Today in the workspace’s time zone: the events that start today, the open items due today, and the open items already overdue (due before today). Each item has source and openIn. Filter by topic and provider.',
  toolset: 'read',
  inputSchema: z.strictObject({ topic: TopicList, provider: ProviderList }),
  outputSchema: z.object({
    timezone: z.string(),
    from: z.string().describe('Start of today, ISO 8601'),
    to: z.string().describe('Start of tomorrow, ISO 8601'),
    events: z.array(ItemSummaryView),
    dueToday: z.array(ItemSummaryView),
    overdue: z.array(ItemSummaryView),
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
    const { timezone, weekStart } = ctx.workspace.settings;
    const now = ctx.now();
    const today = resolveDatePreset('today', now, timezone, weekStart);
    const filters = filterRules({ ...input, topic: await topicIds(ctx.workspace, input.topic) });
    const open = { field: 'status', operator: 'in' as const, value: OPEN_STATUSES };
    const [events, dueToday, overdue] = await Promise.all([
      findItems(ctx, {
        source: 'items',
        ...where([...filters, { field: 'kind', operator: '=', value: 'event' }]),
        dateField: 'startAt',
        dateRange: range(today.from, today.to),
        sort: [{ field: 'startAt', dir: 'asc' }],
        limit: LIMIT,
      }),
      findItems(ctx, {
        source: 'items',
        ...where([...filters, { field: 'kind', operator: '!=', value: 'event' }, open]),
        dateField: 'dueAt',
        dateRange: range(today.from, today.to),
        sort: [{ field: 'dueAt', dir: 'asc' }],
        limit: LIMIT,
      }),
      findItems(ctx, {
        source: 'items',
        ...where([...filters, open]),
        dateField: 'dueAt',
        dateRange: range(EPOCH, today.from),
        sort: [{ field: 'dueAt', dir: 'asc' }],
        limit: LIMIT,
      }),
    ]);
    return {
      output: {
        timezone,
        from: today.from.toISOString(),
        to: today.to.toISOString(),
        events: events.items,
        dueToday: dueToday.items,
        overdue: overdue.items,
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
