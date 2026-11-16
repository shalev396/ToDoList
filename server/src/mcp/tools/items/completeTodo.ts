import { z } from 'zod';

import { Item, Todo } from '../../../classes/item/index.js';
import { MirroredItemError } from '../../../errors/MirroredItemError.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, itemCaller, itemReads, toItemDetailView } from '../itemViews.js';

export const completeTodo = defineTool({
  name: 'complete_todo',
  title: 'Complete a to-do',
  description:
    'Marks a local to-do done, or open again with done: false. A mirrored item is completed at its source: the answer is an error with its Open in link.',
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
    const item = await Item.find(caller, input.id);
    if (!(item instanceof Todo)) throw new MirroredItemError(item.provider, item.sourceUrl);
    const view = await (await itemReads(ctx)).detail(await item.complete(caller, input.done));
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
