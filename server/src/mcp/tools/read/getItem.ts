import { z } from 'zod';

import { getItem as getItemDetail } from '../../../services/items.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, toItemDetailView } from '../itemViews.js';

export const getItem = defineTool({
  name: 'get_item',
  title: 'Get item',
  description:
    'One item in full: its fields, props, labels, assignees, source and openIn (where to open it). An item the agent may not see is not found.',
  toolset: 'read',
  inputSchema: z.strictObject({ id: ItemId }),
  outputSchema: ItemDetailView,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    const item = await getItemDetail(ctx.workspace, ctx.principal.userId, input.id);
    return { output: toItemDetailView(item), target: { type: 'item', id: item.id } };
  },
});
