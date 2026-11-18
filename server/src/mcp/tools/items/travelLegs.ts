import { z } from 'zod';

import { TravelLeg } from '../../../classes/item/index.js';
import { TravelSetup } from '../../../classes/travel/index.js';
import { optionalTime } from '../../../services/timeBlockSchemas.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, itemCaller, itemReads, toItemDetailView } from '../itemViews.js';
import { PRIVACY_NOTE } from './travelViews.js';

const LegId = z
  .string()
  .min(1)
  .max(100)
  .describe('A travel leg’s item id, as get_calendar lists it');

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const travelEditLeg = defineTool({
  name: 'travel_edit_leg',
  title: 'Edit a travel leg’s times',
  description: `Sets one of the member’s travel legs by hand: give one or two of startAt, endAt (ISO 8601 with an offset) and minutes (a length of more than 0 and at most a day), and the third is worked out. One alone keeps the length (a new start or end) or the arrival (a new length). The leg is then the member’s own until travel_reset_leg: regeneration keeps its times, and the length is remembered for the same trip. An edit after the event moved acknowledges the move. A skipped leg is reset before it is edited. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({
    legId: LegId,
    startAt: z.iso.datetime({ offset: true }).optional(),
    endAt: z.iso.datetime({ offset: true }).optional(),
    minutes: z
      .number()
      .positive()
      .max(24 * 60)
      .optional(),
  }),
  outputSchema: z.object({ leg: ItemDetailView }),
  annotations: ANNOTATIONS,
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const caller = itemCaller(ctx);
    const leg = await (
      await TravelLeg.findOwn(caller, input.legId)
    ).editTimes(caller, {
      startAt: optionalTime(input.startAt),
      endAt: optionalTime(input.endAt),
      minutes: input.minutes,
    });
    return {
      output: { leg: toItemDetailView(await (await itemReads(ctx)).detail(leg)) },
      target: { type: 'item', id: leg.id },
    };
  },
});

export const travelSkipLeg = defineTool({
  name: 'travel_skip_leg',
  title: 'Skip a travel leg',
  description: `Skips one of the member’s travel legs for its day: it leaves the calendar and no regeneration brings it back until travel_reset_leg. A leg is skipped, never deleted. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({ legId: LegId }),
  outputSchema: z.object({ legId: z.string(), skipped: z.boolean() }),
  annotations: ANNOTATIONS,
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const caller = itemCaller(ctx);
    const leg = await (await TravelLeg.findOwn(caller, input.legId)).skip(caller);
    return {
      output: { legId: leg.id, skipped: true },
      target: { type: 'item', id: leg.id },
    };
  },
});

export const travelResetLeg = defineTool({
  name: 'travel_reset_leg',
  title: 'Reset a travel leg',
  description: `Puts one of the member’s travel legs back to computed: a skip is undone and the member’s times and the "event moved" flag are cleared; the leg is then worked out again. Answers the leg as it is now. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({ legId: LegId }),
  outputSchema: z.object({ leg: ItemDetailView }),
  annotations: ANNOTATIONS,
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const leg = await TravelSetup.of(itemCaller(ctx)).resetLeg(input.legId);
    return {
      output: { leg: toItemDetailView(await (await itemReads(ctx)).detail(leg)) },
      target: { type: 'item', id: leg.id },
    };
  },
});
