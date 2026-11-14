import { z } from 'zod';

import { resolveDatePreset, type DateBounds } from '../../../builder/dates.js';
import { AppError } from '../../../errors/AppError.js';
import { defineTool, type ToolContext } from '../../tool.js';
import { ItemSummaryView, KindList, ProviderList, TopicList, topicIds } from '../itemViews.js';
import { filterRules, findItems, range, where } from './bridge.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_DAYS = 92;

interface CalendarInput {
  range: 'week' | 'month' | 'custom';
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * The week (from the workspace's week start) or month containing `date` (default today), in the
 * workspace's time zone; or the custom range given. `date` is read as noon UTC that day, which is
 * that same day everywhere from UTC−11 to UTC+11.
 */
function boundsOf(ctx: ToolContext, input: CalendarInput): DateBounds {
  const { timezone, weekStart } = ctx.workspace.settings;
  if (input.range === 'custom') {
    if (input.from === undefined || input.to === undefined) {
      throw new AppError(400, 'A custom range needs from and to');
    }
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (from >= to) throw new AppError(400, 'from must be before to');
    if (to.getTime() - from.getTime() > MAX_CUSTOM_DAYS * DAY_MS) {
      throw new AppError(400, `A custom range spans at most ${String(MAX_CUSTOM_DAYS)} days`);
    }
    return { from, to };
  }
  const anchor = input.date === undefined ? ctx.now() : new Date(`${input.date}T12:00:00Z`);
  return resolveDatePreset(
    input.range === 'week' ? 'this_week' : 'this_month',
    anchor,
    timezone,
    weekStart,
  );
}

export const getCalendar = defineTool({
  name: 'get_calendar',
  title: 'Get calendar',
  description:
    'Events and dated items in a week (from the workspace’s week start), a month, or a custom range, in the workspace’s time zone. An item counts on its start time, or on its due date when it has no start. Sorted by that time. Each item has source and openIn. Filter by topic, provider and kind.',
  toolset: 'read',
  inputSchema: z.strictObject({
    range: z.enum(['week', 'month', 'custom']).default('week'),
    date: z.iso.date().optional().describe('A day in the week or month to show; default today'),
    from: z.iso.datetime({ offset: true }).optional().describe('custom: the start, ISO 8601'),
    to: z.iso.datetime({ offset: true }).optional().describe('custom: the end (exclusive)'),
    topic: TopicList,
    provider: ProviderList,
    kind: KindList,
    limit: z.number().int().min(1).max(200).default(200),
  }),
  outputSchema: z.object({
    from: z.string().describe('ISO 8601'),
    to: z.string().describe('ISO 8601, exclusive'),
    timezone: z.string(),
    weekStart: z.enum(['sun', 'mon']),
    items: z.array(ItemSummaryView),
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
    const bounds = boundsOf(ctx, input);
    const { items, total } = await findItems(ctx, {
      source: 'items',
      ...where(filterRules({ ...input, topic: await topicIds(ctx.workspace, input.topic) })),
      dateField: 'any',
      dateRange: range(bounds.from, bounds.to),
      sort: [
        { field: 'startAt', dir: 'asc' },
        { field: 'dueAt', dir: 'asc' },
      ],
      limit: input.limit,
    });
    const when = (item: { startAt: string | null; dueAt: string | null }): string =>
      item.startAt ?? item.dueAt ?? '';
    return {
      output: {
        from: bounds.from.toISOString(),
        to: bounds.to.toISOString(),
        timezone: ctx.workspace.settings.timezone,
        weekStart: ctx.workspace.settings.weekStart,
        items: [...items].sort((a, b) => when(a).localeCompare(when(b))),
        total,
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
