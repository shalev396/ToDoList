import { z } from 'zod';

import { UpdateOverlayBody } from '../../../services/itemSchemas.js';
import { updateOverlay } from '../../../services/items.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, ItemId, TopicRef, toItemDetailView, topicIdOf } from '../itemViews.js';

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
    const item = await updateOverlay(ctx.workspace, ctx.principal.userId, id, {
      ...overlay,
      topicOverride: await topicIdOf(ctx.workspace, topicOverride),
    });
    return { output: { item: toItemDetailView(item) }, target: { type: 'item', id: item.id } };
  },
});
