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
    'Pins, hides or annotates any item, mirrored ones included, or files it under another topic (a slug) for this workspace: fields kept in TodoList only and never written to the provider (null clears one). The item itself, as the provider sent it, does not change. disabled: true disables a calendar item (an event, a to-do, a time block or an area; a travel leg is skipped instead), false enables it again: it stays on the calendar, faded and struck through, and its time counts as free (not busy, no travel to it, not pushed to the workspace calendar); a cancelled event shows the same way. For something that repeats, scope says which occurrences: series (every occurrence; on a Google series its master and its moved and cancelled occurrences too, from any of them) or occurrence (one: occurrenceStart, its original start as get_calendar’s occurrence.originalStart gives it; an occurrence row of a series needs neither). Left out: occurrence when occurrenceStart is given or the item is one occurrence, else series. Enabling one occurrence of a series disabled as a whole is refused: enable the series.',
  toolset: 'items',
  inputSchema: z
    .strictObject({
      id: ItemId,
      pinned: field.pinned,
      note: field.note,
      hidden: field.hidden,
      topicOverride: TopicRef.nullable().optional(),
      calendarSync: field.calendarSync,
      disabled: field.disabled.describe(
        'true disables the item (or occurrences of it, by scope), false enables it again',
      ),
      scope: field.scope.describe(
        'With disabled, for a repeating item: series (every occurrence) or occurrence (one)',
      ),
      occurrenceStart: field.occurrenceStart.describe(
        'With disabled: the occurrence’s original start, ISO 8601 (occurrence.originalStart)',
      ),
    })
    .refine(
      (input) => Object.entries(input).some(([key, value]) => key !== 'id' && value !== undefined),
      'Give at least one change',
    )
    .refine(
      (input) =>
        input.disabled !== undefined ||
        (input.scope === undefined && input.occurrenceStart === undefined),
      { message: 'scope and occurrenceStart go with disabled', path: ['disabled'] },
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
    const { id, topicOverride, disabled, scope, occurrenceStart, ...overlay } = input;
    const caller = itemCaller(ctx);
    let item = await Item.find(caller, id);
    const fields = { ...overlay, topicOverride: await topicIdOf(ctx.workspace, topicOverride) };
    if (Object.values(fields).some((value) => value !== undefined)) {
      item = await item.setOverlay(caller, fields);
    }
    if (disabled !== undefined) {
      item = await item.setDisabled(
        caller,
        {
          disabled,
          scope,
          occurrenceStart: occurrenceStart === undefined ? undefined : new Date(occurrenceStart),
        },
        ctx.now(),
      );
    }
    const view = await (await itemReads(ctx)).detail(item);
    return { output: { item: toItemDetailView(view) }, target: { type: 'item', id: view.id } };
  },
});
