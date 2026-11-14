import { z } from 'zod';

import { AttrValues } from '../../../services/itemSchemas.js';
import { updateOverlay } from '../../../services/items.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, toItemDetailView } from '../itemViews.js';

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
    const item = await updateOverlay(ctx.workspace, ctx.principal.userId, input.id, {
      attrs: input.attrs,
    });
    return { output: { item: toItemDetailView(item) }, target: { type: 'item', id: item.id } };
  },
});
