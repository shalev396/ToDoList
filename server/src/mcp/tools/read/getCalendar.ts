import { z } from 'zod';

import { resolveDatePreset, type DateBounds } from '../../../builder/dates.js';
import { AppError } from '../../../errors/AppError.js';
import { CAPS } from '../../../types/builder.js';
import { defineTool, type ToolContext } from '../../tool.js';
import { ItemSummaryView, KindList, ProviderList, TopicList, topicIds } from '../itemViews.js';
import { filterRules, findItems, occurrencesOf, range, where } from './bridge.js';

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
    'Events, dated items and the time TodoList keeps (time blocks, areas with layer area, travel legs) in a week (from the workspace’s week start), a month, or a custom range, in the workspace’s time zone. One entry per occurrence: a repeating event or time block appears once for each time it happens in the range, even when the series began earlier, with occurrence {seriesId, originalStart}. An item counts on its start time, or on its due date when it has no start. Sorted by that time. busy says whether an entry takes the time: events (unless shown as free), time blocks and travel are busy; areas, to-dos and tasks are not. Cancelled and declined events are left out, as on the calendar. Each item has source and openIn. Filter by topic, provider and kind.',
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
    items: z.array(ItemSummaryView).describe('One entry per occurrence, with occurrence and busy'),
    total: z.number().int().describe('Every entry found, even past the limit'),
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
    const { timezone, weekStart } = ctx.workspace.settings;
    // Time-shaped: blocks, areas and travel are read with everything else. The rows are read up
    // to the cap (one series row may give many entries), then the entries are cut to the limit.
    const found = await findItems(
      ctx,
      {
        source: 'items',
        ...where(filterRules({ ...input, topic: await topicIds(ctx.workspace, input.topic) })),
        dateField: 'any',
        dateRange: range(bounds.from, bounds.to),
        sort: [
          { field: 'startAt', dir: 'asc' },
          { field: 'dueAt', dir: 'asc' },
        ],
        limit: CAPS.maxLimit,
      },
      ctx.now(),
      { blockType: 'calendar' },
    );
    const entries = occurrencesOf(found, bounds, timezone);
    return {
      output: {
        from: bounds.from.toISOString(),
        to: bounds.to.toISOString(),
        timezone,
        weekStart,
        items: entries.slice(0, input.limit),
        // Rows past the cap were not expanded: each counts once.
        total: entries.length + Math.max(0, found.total - found.rows.length),
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
