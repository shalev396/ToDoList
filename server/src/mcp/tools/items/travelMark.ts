import { z } from 'zod';

import { Place, TravelRule } from '../../../classes/travel/index.js';
import { optionalTime } from '../../../services/timeBlockSchemas.js';
import { RULE_DIRECTIONS, TRAVEL_MODES } from '../../../types/travel.js';
import { defineTool } from '../../tool.js';
import { ItemId, ItemSummaryView, itemCaller, itemReads, toItemSummaryView } from '../itemViews.js';
import { PRIVACY_NOTE, RuleViewSchema, toRuleView } from './travelViews.js';

export const travelMarkItem = defineTool({
  name: 'travel_mark_item',
  title: 'Travel to an item',
  description: `Marks one timed item (an event, a to-do with a start, a time block; not an area, a travel leg, or one with no start or all day) for travel: legs get the member there from Home (or the place before) and back. every: true marks every occurrence of a repeating item; occurrenceStart marks one occurrence (its original start); an item that does not repeat takes neither. place is the name (or an alias) of one of the member’s saved places; left out, the item’s own place. minutes sets the leg’s length by hand, as an edit the member’s own (it is remembered for the same trip; with every, it applies to each occurrence). Marking the same item again changes its mark. The member must have a Home (travel_home_missing otherwise). Answers the rule and the item’s legs in the next 14 days, as they are now; they are busy time. ${PRIVACY_NOTE}`,
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
      .max(24 * 60)
      .optional()
      .describe('A rough length in minutes, for the leg (or legs) the direction names'),
  }),
  outputSchema: z.object({
    rule: RuleViewSchema,
    legs: z.array(ItemSummaryView).describe('The item’s travel legs, by start'),
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
    const { rule, legs } = await TravelRule.markItem(caller, {
      itemId: input.itemId,
      occurrence: optionalTime(input.occurrenceStart),
      every: input.every ?? false,
      mode: input.mode,
      direction: input.direction,
      placeId,
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
      },
      target: { type: 'travel_rule', id: rule.id },
    };
  },
});
