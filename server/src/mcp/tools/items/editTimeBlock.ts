import { z } from 'zod';

import { TimeBlock } from '../../../classes/item/index.js';
import {
  EditTimeBlockFields,
  checkTimeBlockEdit,
  optionalTime,
  requiredTime,
} from '../../../services/timeBlockSchemas.js';
import { defineTool } from '../../tool.js';
import {
  ItemDetailView,
  ItemId,
  TopicRef,
  itemCaller,
  itemReads,
  toItemDetailView,
  topicIdOf,
} from '../itemViews.js';

export const editTimeBlock = defineTool({
  name: 'edit_time_block',
  title: 'Change a time block or an area',
  description:
    'Changes a time block or an area (create_time_block made it; get_calendar and list_today list each occurrence with occurrence.seriesId, its id, and occurrence.originalStart). scope "this" changes one occurrence of a repeating one: give originalStart (as listed, its start before any move) and either its new startAt and endAt, or skip: true to leave that occurrence out; nothing else of the series changes, and an originalStart that is none of its occurrences is an error. scope "all" changes the series: title, note (null clears), subject (null clears; a new one is added to the workspace), topic (a slug; null: Unsorted), startAt and endAt of its first occurrence (a new start alone keeps its length), recurrence (one "RRULE:" line; null: it no longer repeats). A new start or rule drops the moved and skipped occurrences that are no longer part of the series. A block lasts 1 minute to 24 hours. Kept in TodoList only. Delete one with delete_todo.',
  toolset: 'items',
  inputSchema: EditTimeBlockFields.omit({ topicId: true })
    .extend({
      id: ItemId,
      topic: TopicRef.nullable().optional(),
      skip: z
        .boolean()
        .optional()
        .describe('With scope "this" and originalStart: leave that occurrence out'),
    })
    .superRefine(checkTimeBlockEdit),
  outputSchema: z.object({ item: ItemDetailView }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const { id, scope, originalStart, startAt, endAt, skip, topic, ...series } = input;
    const caller = itemCaller(ctx);
    const block = await TimeBlock.find(caller, id);
    let edited: TimeBlock;
    if (scope === 'all') {
      edited = await block.editSeries(caller, {
        ...series,
        startAt: optionalTime(startAt),
        endAt: optionalTime(endAt),
        topicId: await topicIdOf(ctx.workspace, topic),
      });
    } else if (skip === true) {
      edited = await block.skipOccurrence(caller, requiredTime(originalStart, 'originalStart'));
    } else {
      edited = await block.editOccurrence(caller, requiredTime(originalStart, 'originalStart'), {
        startAt: requiredTime(startAt, 'startAt'),
        endAt: requiredTime(endAt, 'endAt'),
      });
    }
    const view = await (await itemReads(ctx)).detail(edited);
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
