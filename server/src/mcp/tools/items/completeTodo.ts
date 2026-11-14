import { z } from 'zod';

import { completeItem } from '../../../services/items.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, toItemDetailView } from '../itemViews.js';

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
    const item = await completeItem(ctx.workspace, ctx.principal.userId, input.id, input.done);
    return { output: { item: toItemDetailView(item) }, target: { type: 'item', id: item.id } };
  },
});
