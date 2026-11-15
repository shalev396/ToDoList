import { z } from 'zod';

import { Item, ItemEdit } from '../../../classes/item/index.js';
import { AppError } from '../../../errors/AppError.js';
import { UpdateItemBody } from '../../../services/itemSchemas.js';
import { PROVIDERS_CREATE_SCOPE } from '../../../types/providerCreate.js';
import { confirmField } from '../../middleware/confirm.js';
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
import { toDate } from './createTodo.js';

const field = UpdateItemBody.shape;

export const updateTodo = defineTool({
  name: 'update_todo',
  title: 'Update an item',
  description:
    'Changes an item, by its id. A local to-do: its title, note, due date (allDay: no time of day), start, end, topic (a slug; null: Unsorted), container, priority or status (null clears a note, a date, a container or a priority). A mirrored item: the fields its provider takes for its kind are written there (only by the owner of its integration, and only while that integration is read & write); the fields its provider lacks (title, status, due date, start, priority) are kept in TodoList as local overrides (null clears one); anything else (note, topic, container) is edited at its source: the answer is an error with its Open in link. A change written to the provider needs the providers:create scope and confirm: true (nothing is sent without them); local changes need neither. An event with other guests needs notifyGuests. Use complete_todo to mark a to-do done.',
  toolset: 'items',
  inputSchema: z
    .strictObject({
      id: ItemId,
      title: field.title.unwrap().unwrap().optional(),
      note: field.note,
      dueAt: field.dueAt,
      allDay: field.allDay,
      startAt: field.startAt,
      endAt: field.endAt,
      topic: TopicRef.nullable().optional(),
      containerId: field.containerId,
      priority: field.priority,
      status: field.status.unwrap().unwrap().optional(),
      notifyGuests: field.notifyGuests,
      confirm: confirmField.describe(
        'true writes the provider fields to the provider; without it, an edit that would is refused',
      ),
    })
    .refine(
      (input) =>
        Object.entries(input).some(
          ([key, value]) =>
            key !== 'id' && key !== 'notifyGuests' && key !== 'confirm' && value !== undefined,
        ),
      'Give at least one change',
    ),
  outputSchema: z.object({ item: ItemDetailView }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    // A mirrored item's provider fields are written to its provider (confirmed, scoped).
    openWorldHint: true,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const { id, topic, confirm, ...change } = input;
    const caller = itemCaller(ctx);
    const item = await Item.find(caller, id);
    const edit = ItemEdit.of({
      ...change,
      dueAt: toDate(change.dueAt),
      startAt: toDate(change.startAt),
      endAt: toDate(change.endAt),
      topicId: await topicIdOf(ctx.workspace, topic),
    });
    // Writing to a provider takes what creating there takes: the scope and a confirmation, both
    // checked before anything is sent. Local changes (overrides) need neither.
    if (Object.keys(await item.providerChanges(caller, edit)).length > 0) {
      if (!ctx.principal.scopes.includes(PROVIDERS_CREATE_SCOPE)) {
        throw new AppError(403, 'Writing to providers needs the providers:create scope');
      }
      if (confirm !== true) {
        throw new AppError(
          400,
          'This changes the item at its provider: call again with confirm: true',
        );
      }
    }
    const edited = await item.edit(caller, edit);
    const view = await (await itemReads(ctx)).detail(edited);
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
