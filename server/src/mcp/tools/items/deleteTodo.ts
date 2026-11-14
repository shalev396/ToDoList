import { z } from 'zod';

import { MirroredItemError } from '../../../errors/MirroredItemError.js';
import { deleteItem, getItem } from '../../../services/items.js';
import { confirmField } from '../../middleware/confirm.js';
import { defineTool, type ToolContext } from '../../tool.js';
import { ItemId, ItemSummaryView, toItemSummaryView } from '../itemViews.js';

/**
 * The item as it is, for the preview and the answer. A mirrored one is refused at once, with the
 * answer deleteItem itself gives it: it is deleted at its source, never here.
 */
async function localItem(ctx: ToolContext, id: string): Promise<ItemSummaryView> {
  const item = await getItem(ctx.workspace, ctx.principal.userId, id);
  if (item.source.provider !== 'local') {
    throw new MirroredItemError(item.source.provider, item.source.url);
  }
  return toItemSummaryView(item);
}

export const deleteTodo = defineTool({
  name: 'delete_todo',
  title: 'Delete a to-do',
  description:
    'Deletes a local to-do (it is purged 30 days later). Without confirm: true it only previews the deletion and changes nothing. A mirrored item is deleted at its source: the answer is an error with its Open in link.',
  toolset: 'items',
  inputSchema: z.strictObject({ id: ItemId, confirm: confirmField }),
  outputSchema: z.object({
    applied: z.boolean().describe('false: a preview, nothing changed'),
    item: ItemSummaryView.describe('The to-do as it was'),
    summary: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async preview(ctx, input) {
    const item = await localItem(ctx, input.id);
    return {
      output: {
        applied: false,
        item,
        summary:
          'Preview: this to-do would be deleted. Nothing changed; call again with confirm: true to delete it.',
      },
      target: { type: 'item', id: item.id },
    };
  },
  async handler(ctx, input) {
    const item = await localItem(ctx, input.id);
    await deleteItem(ctx.workspace, ctx.principal.userId, item.id);
    return {
      output: { applied: true, item, summary: 'The to-do was deleted.' },
      target: { type: 'item', id: item.id },
    };
  },
});
