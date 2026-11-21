import { z } from 'zod';

import { Place, TravelRule } from '../../../classes/travel/index.js';
import { optionalTime } from '../../../services/timeBlockSchemas.js';
import {
  ARRIVE_EARLY_MAX,
  RULE_DIRECTIONS,
  TRAVEL_MODES,
  TRIP_MINUTES_MAX,
} from '../../../types/travel.js';
import { defineTool } from '../../tool.js';
import { ItemId, ItemSummaryView, itemCaller, itemReads, toItemSummaryView } from '../itemViews.js';
import { PRIVACY_NOTE, RuleViewSchema, toRuleView } from './travelViews.js';

export const travelMarkItem = defineTool({
  name: 'travel_mark_item',
  title: 'Travel to an item',
  description: `Marks one timed item (an event, a to-do with a start, a time block, or an area such as Studying 8-16; not a travel leg, or one with no start or all day) for travel: legs get the member there from Home (or the place before) and back. Inside a marked area, an item with a place of its own is travelled to for its own time (and back into the area after it, when there is time), and a marked area lends its place to one with none: it is spent in the area and adds no trips of its own (within names the area and the place). every: true marks every occurrence of a repeating item; occurrenceStart marks one occurrence (its original start); an item that does not repeat takes neither. place is the name (or an alias) of one of the member’s saved places; left out, the item’s own place. minutes is how long the trip takes, every time: it is set once for the trip the mark names (from Home to place, else to the item’s own place, by mode; the way back for direction back, both for both), whether or not the item has legs yet, and every repeat of that trip uses it, every occurrence and every day, but legs whose times were set by hand. A trip from another place (a leg between) is never set by it. The way back starts with the same length when it has none yet; it can be changed on its own. lengthStored says what became of minutes (false: the item’s own place isn’t known yet, so nothing was stored; give place). Without minutes, a trip with no length yet is drawn with a 30-minute placeholder (lengthUnset). arriveEarlyMinutes (0 to 240) makes the there leg arrive that many minutes before the item starts, and lengths ({there, back} in minutes) set how long this mark’s there and back legs take (they win over the trip’s own length, for this mark’s legs only; unlike minutes, they are not the trip’s length, so another item’s legs are unaffected); null clears either. Marking the same item again changes its mark. The member must have a Home (travel_home_missing otherwise). Answers the rule and the item’s legs in the next 14 days, as they are now; they are busy time. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({
    itemId: ItemId,
    occurrenceStart: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('One occurrence of a repeating item: its original start'),
    every: z.boolean().optional().describe('Every occurrence of a repeating item'),
    mode: z.enum(TRAVEL_MODES),
    direction: z.enum(RULE_DIRECTIONS),
    place: z.string().min(1).max(200).nullable().optional(),
    minutes: z
      .number()
      .positive()
      .max(TRIP_MINUTES_MAX)
      .optional()
      .describe('How long the trip takes, every time, for the trip (or trips) the direction names'),
    arriveEarlyMinutes: z.number().int().min(0).max(ARRIVE_EARLY_MAX).nullable().optional(),
    lengths: z
      .strictObject({
        there: z.number().int().positive().max(TRIP_MINUTES_MAX).nullable().optional(),
        back: z.number().int().positive().max(TRIP_MINUTES_MAX).nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  outputSchema: z.object({
    rule: RuleViewSchema,
    legs: z.array(ItemSummaryView).describe('The item’s travel legs, by start'),
    within: z
      .object({ area: z.string(), place: z.string() })
      .nullable()
      .describe(
        'With no legs: the marked area the item is spent in, at that place, when that is why; else null',
      ),
    lengthStored: z
      .boolean()
      .nullable()
      .describe(
        'minutes: true when set for the trip the mark names; false when not stored (the item’s own place isn’t known yet: give place); null when no minutes were given',
      ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const caller = itemCaller(ctx);
    const placeId =
      input.place === undefined || input.place === null
        ? null
        : (await Place.findNamed(caller, input.place)).id;
    const span = input.minutes === undefined ? undefined : { minutes: input.minutes };
    const { rule, legs, within, lengthStored } = await TravelRule.markItem(caller, {
      itemId: input.itemId,
      occurrence: optionalTime(input.occurrenceStart),
      every: input.every ?? false,
      mode: input.mode,
      direction: input.direction,
      placeId,
      arriveEarlyMinutes: input.arriveEarlyMinutes,
      lengths: input.lengths,
      there: input.direction === 'back' ? undefined : span,
      back: input.direction === 'there' ? undefined : span,
    });
    const reads = await itemReads(ctx);
    return {
      output: {
        rule: toRuleView(rule, await Place.listOwn(caller)),
        legs: await Promise.all(
          legs.map(async (leg) => toItemSummaryView(await reads.detail(leg))),
        ),
        within,
        lengthStored,
      },
      target: { type: 'travel_rule', id: rule.id },
    };
  },
});
