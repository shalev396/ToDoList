import { z } from 'zod';

import { Item } from '../../../classes/item/index.js';
import { UpdateOverlayBody } from '../../../services/itemSchemas.js';
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

const field = UpdateOverlayBody.shape;

export const setOverlay = defineTool({
  name: 'set_overlay',
  title: 'Set an item’s overlay',
  description:
    'Pins, hides or annotates any item, mirrored ones included, or files it under another topic (a slug) for this workspace: fields kept in TodoList only and never written to the provider (null clears one). The item itself, as the provider sent it, does not change.',
  toolset: 'items',
  inputSchema: z
    .strictObject({
      id: ItemId,
      pinned: field.pinned,
      note: field.note,
      hidden: field.hidden,
      topicOverride: TopicRef.nullable().optional(),
      calendarSync: field.calendarSync,
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
    const { id, topicOverride, ...overlay } = input;
    const caller = itemCaller(ctx);
    const item = await (
      await Item.find(caller, id)
    ).setOverlay(caller, {
      ...overlay,
      topicOverride: await topicIdOf(ctx.workspace, topicOverride),
    });
    const view = await (await itemReads(ctx)).detail(item);
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
