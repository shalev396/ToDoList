import { z } from 'zod';

import { Item } from '../../../classes/item/index.js';
import { AttrValues } from '../../../services/itemSchemas.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, itemCaller, itemReads, toItemDetailView } from '../itemViews.js';

export const setItemAttributes = defineTool({
  name: 'set_item_attributes',
  title: 'Set an item’s attribute values',
  description:
    'Sets custom attribute values (list_attributes) on any item, mirrored ones included: for example {"importance": 5}. null clears a value. The values are kept in TodoList only and never written to the provider; a value that does not fit its attribute (a rating outside 1 to 5, an option that is not listed) is refused.',
  toolset: 'items',
  inputSchema: z.strictObject({
    id: ItemId,
    attrs: AttrValues.refine((values) => Object.keys(values).length > 0, 'Give at least one value'),
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
    const item = await (
      await Item.find(caller, input.id)
    ).setOverlay(caller, { attrs: input.attrs });
    const view = await (await itemReads(ctx)).detail(item);
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
