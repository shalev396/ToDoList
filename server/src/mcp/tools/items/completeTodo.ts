import { z } from 'zod';

import { Item } from '../../../classes/item/index.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, itemCaller, itemReads, toItemDetailView } from '../itemViews.js';

export const completeTodo = defineTool({
  name: 'complete_todo',
  title: 'Complete a to-do',
  description:
    'Marks a local to-do done, or open again with done: false. A mirrored item is completed at its source: the answer is an error with its Open in link. A time block, an area or a travel leg is reserved time with no status: it cannot be completed.',
  toolset: 'items',
  inputSchema: z.strictObject({
    id: ItemId,
    done: z.boolean().default(true).describe('false reopens it'),
  }),
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
    const caller = itemCaller(ctx);
    const item = (await Item.find(caller, input.id)).completable();
    const view = await (await itemReads(ctx)).detail(await item.complete(caller, input.done));
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
