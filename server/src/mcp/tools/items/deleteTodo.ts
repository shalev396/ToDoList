import { z } from 'zod';

import { Item, Todo } from '../../../classes/item/index.js';
import { MirroredItemError } from '../../../errors/MirroredItemError.js';
import { confirmField } from '../../middleware/confirm.js';
import { defineTool, type ToolContext } from '../../tool.js';
import { ItemId, ItemSummaryView, itemCaller, itemReads, toItemSummaryView } from '../itemViews.js';

/**
 * The to-do as it is, for the preview and the answer. A mirrored item is refused at once: it is
 * deleted at its source, never here.
 */
async function localItem(
  ctx: ToolContext,
  id: string,
): Promise<{ todo: Todo; view: ItemSummaryView }> {
  const item = await Item.find(itemCaller(ctx), id);
  if (!(item instanceof Todo)) throw new MirroredItemError(item.provider, item.sourceUrl);
  return {
    todo: item,
    view: toItemSummaryView(await (await itemReads(ctx)).detail(item, { live: true })),
  };
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
    const { view: item } = await localItem(ctx, input.id);
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
    const { todo, view: item } = await localItem(ctx, input.id);
    await todo.delete(itemCaller(ctx));
    return {
      output: { applied: true, item, summary: 'The to-do was deleted.' },
      target: { type: 'item', id: item.id },
    };
  },
});
