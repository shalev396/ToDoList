import { z } from 'zod';

import { UpdateItemBody } from '../../../services/itemSchemas.js';
import { updateItem } from '../../../services/items.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, TopicRef, toItemDetailView, topicIdOf } from '../itemViews.js';
import { toDate } from './createTodo.js';

const field = UpdateItemBody.shape;

export const updateTodo = defineTool({
  name: 'update_todo',
  title: 'Update a to-do',
  description:
    'Changes a local to-do: its title, note, due date, topic (a slug; null: Unsorted), container or priority (null clears a note, due date, container or priority). A mirrored item is edited at its source: the answer is an error with its Open in link. Use complete_todo to mark it done.',
  toolset: 'items',
  inputSchema: z
    .strictObject({
      id: ItemId,
      title: field.title,
      note: field.note,
      dueAt: field.dueAt,
      topic: TopicRef.nullable().optional(),
      containerId: field.containerId,
      priority: field.priority,
    })
    .refine(
      (input) => Object.entries(input).some(([key, value]) => key !== 'id' && value !== undefined),
      'Give at least one change',
    ),
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
    const { id, topic, ...change } = input;
    const item = await updateItem(ctx.workspace, ctx.principal.userId, id, {
      ...change,
      dueAt: toDate(change.dueAt),
      topicId: await topicIdOf(ctx.workspace, topic),
    });
    return { output: { item: toItemDetailView(item) }, target: { type: 'item', id: item.id } };
  },
});
