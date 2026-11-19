import { z } from 'zod';

import { TimeBlock } from '../../../classes/item/index.js';
import { CreateTimeBlockBody, requiredTime } from '../../../services/timeBlockSchemas.js';
import { defineTool } from '../../tool.js';
import {
  ItemDetailView,
  TopicRef,
  itemCaller,
  itemReads,
  toItemDetailView,
  topicIdOf,
} from '../itemViews.js';

export const createTimeBlock = defineTool({
  name: 'create_time_block',
  title: 'Create a time block or an area',
  description:
    'Reserves time in TodoList (a time block: "Study: Math, Sundays 13:00–17:00"), or paints time for a part of life (layer "area": "Studying", "Work 9–17"; it needs a title). Not a to-do: it has no status, is never completed, and is left out of task lists and counts; get_calendar and list_today show it (blocks are busy, areas are not). Give its first occurrence (startAt and endAt, ISO 8601 with an offset; 1 minute to 24 hours) and, to repeat, recurrence: one "RRULE:" line (FREQ DAILY, WEEKLY, MONTHLY or YEARLY; INTERVAL, BYDAY, BYMONTHDAY, WKST (SU or MO, weekly only: the day the weeks an INTERVAL counts start on; give the workspace’s), COUNT, or UNTIL as a UTC time like 20270301T000000Z), expanded on the workspace’s wall clock. One record holds the whole series. subject names what the time is for (Math, History): an option of the workspace’s Subject attribute, matched whatever its case; a new one is added. The title defaults to the subject. The topic (a slug; null: Unsorted) defaults to the topic last used with that subject, else none. To lay out a week, create the areas first and the blocks inside them. With an idempotencyKey, a retry gives back the block the first call made. Kept in TodoList only: nothing is written to a provider.',
  toolset: 'items',
  inputSchema: CreateTimeBlockBody.omit({ topicId: true }).extend({
    topic: TopicRef.nullable().optional(),
    idempotencyKey: CreateTimeBlockBody.shape.idempotencyKey.describe(
      'Makes retries safe: the same key gives back the same block',
    ),
  }),
  outputSchema: z.object({
    item: ItemDetailView,
    created: z
      .boolean()
      .describe('false: a retry with an idempotencyKey already used; nothing new was made'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const { topic, layer, startAt, endAt, ...rest } = input;
    const { block, created } = await TimeBlock.create(itemCaller(ctx), {
      ...rest,
      layer: layer ?? 'block',
      startAt: requiredTime(startAt, 'startAt'),
      endAt: requiredTime(endAt, 'endAt'),
      topicId: await topicIdOf(ctx.workspace, topic),
    });
    const view = await (await itemReads(ctx)).detail(block);
    return {
      output: { item: toItemDetailView(view), created },
      target: { type: 'item', id: view.id },
    };
  },
});
