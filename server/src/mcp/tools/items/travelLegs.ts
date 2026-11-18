import { z } from 'zod';

import { TravelLeg } from '../../../classes/item/index.js';
import { TravelSetup } from '../../../classes/travel/index.js';
import { TRIP_MINUTES_MAX } from '../../../types/travel.js';
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
  title: 'Set a trip’s length or move a travel leg',
  description: `Changes one of the member’s travel legs, two ways. minutes (more than 0, at most a day) is how long the trip takes EVERY time: it is set once for the trip (from place, to place and mode; each direction is its own trip), and every leg of that trip, every day and every occurrence, takes it, but legs whose times were set by hand; this leg keeps its arrival (a leg back: its departure). startAt and endAt (ISO 8601 with an offset) move THIS leg only: one alone keeps its length, both are its span; the leg then keeps those times until travel_reset_leg. A leg whose trip has no length yet has lengthUnset true and is drawn with a 30-minute placeholder: set its minutes once. An edit after the event moved acknowledges the move. A skipped leg is reset before it is edited. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({
    legId: LegId,
    startAt: z.iso.datetime({ offset: true }).optional(),
    endAt: z.iso.datetime({ offset: true }).optional(),
    minutes: z
      .number()
      .positive()
      .max(TRIP_MINUTES_MAX)
      .optional()
      .describe('How long this trip takes, every time'),
  }),
  outputSchema: z.object({ leg: ItemDetailView }),
  annotations: ANNOTATIONS,
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const leg = await TravelSetup.of(itemCaller(ctx)).editLeg(input.legId, {
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
