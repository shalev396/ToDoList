import { z } from 'zod';

import { resolveDatePreset } from '../../../builder/dates.js';
import { CAPS } from '../../../types/builder.js';
import { SCHEDULED_KINDS } from '../../../types/domain.js';
import { defineTool } from '../../tool.js';
import { ItemSummaryView, ProviderList, TopicList, topicIds } from '../itemViews.js';
import {
  EPOCH,
  filterRules,
  findItems,
  occurrencesOf,
  OPEN_STATUSES,
  range,
  where,
} from './bridge.js';

const LIMIT = 100;

export const listToday = defineTool({
  name: 'list_today',
  title: 'List today',
  description:
    'Today in the workspace’s time zone: the events that happen today (one entry per occurrence, repeating events included), the open items due today, the open items already overdue (due before today), and scheduled: the time TodoList keeps today, i.e. time blocks, areas (layer area) and travel legs, each occurrence once. Time blocks and travel are busy time (busy true); areas are not (a plan to put blocks in). None of the scheduled entries is a task: they are never due, overdue or completed. Each item has source and openIn. Filter by topic and provider.',
  toolset: 'read',
  inputSchema: z.strictObject({ topic: TopicList, provider: ProviderList }),
  outputSchema: z.object({
    timezone: z.string(),
    from: z.string().describe('Start of today, ISO 8601'),
    to: z.string().describe('Start of tomorrow, ISO 8601'),
    events: z.array(ItemSummaryView),
    dueToday: z.array(ItemSummaryView),
    overdue: z.array(ItemSummaryView),
    scheduled: z
      .array(ItemSummaryView)
      .describe(
        'Time blocks, areas and travel today, one entry per occurrence, with layer and busy',
      ),
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
    /** Today's occurrences of the items of these kinds (a series that began earlier included). */
    const timed = async (kinds: readonly string[]): Promise<ItemSummaryView[]> =>
      occurrencesOf(
        await findItems(
          ctx,
          {
            source: 'items',
            ...where([...filters, { field: 'kind', operator: 'in', value: [...kinds] }]),
            dateField: 'startAt',
            dateRange: range(today.from, today.to),
            sort: [{ field: 'startAt', dir: 'asc' }],
            limit: CAPS.maxLimit,
          },
          now,
          { blockType: 'agenda' },
        ),
        today,
        timezone,
      ).slice(0, LIMIT);
    const [events, dueToday, overdue, scheduled] = await Promise.all([
      timed(['event']),
      // Task-shaped, like overdue: `kind != event` asks for no reserved time, so none comes back.
      findItems(
        ctx,
        {
          source: 'items',
          ...where([...filters, { field: 'kind', operator: '!=', value: 'event' }, open]),
          dateField: 'dueAt',
          dateRange: range(today.from, today.to),
          sort: [{ field: 'dueAt', dir: 'asc' }],
          limit: LIMIT,
        },
        now,
      ),
      // Task-shaped: no block type, no rule on kind, so reserved time stays out.
      findItems(
        ctx,
        {
          source: 'items',
          ...where([...filters, open]),
          dateField: 'dueAt',
          dateRange: range(EPOCH, today.from),
          sort: [{ field: 'dueAt', dir: 'asc' }],
          limit: LIMIT,
        },
        now,
      ),
      timed(SCHEDULED_KINDS),
    ]);
    return {
      output: {
        timezone,
        from: today.from.toISOString(),
        to: today.to.toISOString(),
        events,
        dueToday: dueToday.items,
        overdue: overdue.items,
        scheduled,
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
