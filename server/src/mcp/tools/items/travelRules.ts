import { z } from 'zod';

import { Place, TravelRule, TravelSetup } from '../../../classes/travel/index.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import { RuleGroupSchema } from '../../../types/builder.js';
import {
  ARRIVE_EARLY_MAX,
  RULE_DIRECTIONS,
  TRAVEL_MODES,
  TRIP_MINUTES_MAX,
  type TravelRuleScope,
} from '../../../types/travel.js';
import { confirmField } from '../../middleware/confirm.js';
import { defineTool } from '../../tool.js';
import { itemCaller } from '../itemViews.js';
import { PRIVACY_NOTE, RuleViewSchema, toRuleView } from './travelViews.js';

const RuleId = z.string().min(1).max(100).describe('A rule id, as travel_list_rules lists it');

export const travelListRules = defineTool({
  name: 'travel_list_rules',
  title: 'List the member’s travel rules',
  description: `The key’s own member’s travel rules, oldest first (where-rules apply in this order; a rule for an item beats one for its series, which beats a repeats rule, which beats a where-rule; a repeats rule is made by travel_edit_leg with mode and every, and removed here). Each rule names its place by name. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({ rules: z.array(RuleViewSchema) }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'editor',
  async handler(ctx) {
    const caller = itemCaller(ctx);
    const [rules, places] = await Promise.all([TravelRule.listOwn(caller), Place.listOwn(caller)]);
    return {
      output: { rules: rules.map((rule) => toRuleView(rule, places)) },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});

/** The scope the input names: exactly one of where, seriesItemId and itemId (none: undefined). */
function scopeOf(input: {
  where?: z.output<typeof RuleGroupSchema> | undefined;
  seriesItemId?: string | undefined;
  itemId?: string | undefined;
  occurrenceStart?: string | undefined;
}): TravelRuleScope | undefined {
  const named = [input.where, input.seriesItemId, input.itemId].filter((one) => one !== undefined);
  if (named.length > 1) {
    throw new ValidationError('where: give one of where, seriesItemId and itemId');
  }
  if (input.occurrenceStart !== undefined && input.itemId === undefined) {
    throw new ValidationError('occurrenceStart: only with itemId');
  }
  if (input.where !== undefined) return { kind: 'where', where: input.where };
  if (input.seriesItemId !== undefined) return { kind: 'series', itemId: input.seriesItemId };
  if (input.itemId !== undefined) {
    return { kind: 'item', itemId: input.itemId, occurrence: input.occurrenceStart ?? 'single' };
  }
  return undefined;
}

export const travelSetRule = defineTool({
  name: 'travel_set_rule',
  title: 'Add or change a travel rule',
  description: `A rule says which items the member travels to and how: scope it with exactly one of where (a rule group over items, as the dashboards’ queries take, e.g. containerId = a calendar), seriesItemId (every occurrence of a repeating item) or itemId (one item; with occurrenceStart, one occurrence of a repeating one). mode is walk, drive or transit; direction there (to it from Home or the place before), back (the trip after it: home, or on to the next place, or back into the area around it) or both. place is the name (or an alias) of one of the member’s saved places the rule sends them to; left out, the item’s own place applies; null removes it. Give id to change a rule (anything left out stays; a new scope replaces the old). It applies to areas too (painted time such as Studying 8-16): the items inside one with a place of their own are travelled to for their own time (back into the area after them when there is time, else straight on), and a marked area lends its place to the items inside it with none, which then add no trips of their own. arriveEarlyMinutes (0 to 240) makes the there leg this rule draws arrive that many minutes before the item starts; lengths ({there, back} in minutes) set how long the there leg (from Home) and the way back take, winning over the trip’s own length, for the legs this rule draws only (so Sunday’s bus can take 95 minutes and Monday’s 100); null clears either, and an empty or absent side takes the trip’s own length. They work on every scope. The member’s legs are made again before it answers. At most 50 rules. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({
    id: RuleId.optional().describe('Change this rule; left out: a new rule'),
    where: RuleGroupSchema.optional(),
    seriesItemId: z.string().min(1).max(200).optional(),
    itemId: z.string().min(1).max(200).optional(),
    occurrenceStart: z
      .union([z.literal('single'), z.iso.datetime({ offset: true })])
      .optional()
      .describe('With itemId: the occurrence’s original start, or "single" (the default)'),
    mode: z.enum(TRAVEL_MODES).optional(),
    direction: z.enum(RULE_DIRECTIONS).optional(),
    place: z.string().min(1).max(200).nullable().optional(),
    arriveEarlyMinutes: z.number().int().min(0).max(ARRIVE_EARLY_MAX).nullable().optional(),
    lengths: z
      .strictObject({
        there: z.number().int().positive().max(TRIP_MINUTES_MAX).nullable().optional(),
        back: z.number().int().positive().max(TRIP_MINUTES_MAX).nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  outputSchema: z.object({ rule: RuleViewSchema }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const caller = itemCaller(ctx);
    const scope = scopeOf(input);
    const placeId =
      input.place === undefined || input.place === null
        ? input.place
        : (await Place.findNamed(caller, input.place)).id;
    const setup = TravelSetup.of(caller);
    let rule: TravelRule;
    if (input.id !== undefined) {
      rule = await setup.changeRule(input.id, {
        scope,
        mode: input.mode,
        direction: input.direction,
        placeId,
        arriveEarlyMinutes: input.arriveEarlyMinutes,
        lengths: input.lengths,
      });
    } else {
      if (scope === undefined) {
        throw new ValidationError('where: give one of where, seriesItemId and itemId');
      }
      if (input.mode === undefined || input.direction === undefined) {
        throw new ValidationError('mode: mode and direction are required for a new rule');
      }
      rule = await setup.addRule({
        scope,
        mode: input.mode,
        direction: input.direction,
        placeId,
        arriveEarlyMinutes: input.arriveEarlyMinutes,
        lengths: input.lengths,
      });
    }
    return {
      output: { rule: toRuleView(rule, await Place.listOwn(caller)) },
      target: { type: 'travel_rule', id: rule.id },
    };
  },
});

export const travelRemoveRule = defineTool({
  name: 'travel_remove_rule',
  title: 'Remove a travel rule',
  description: `Removes one of the member’s travel rules: the legs it made go, as no longer matching. Without confirm: true it only previews and changes nothing. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({ id: RuleId, confirm: confirmField }),
  outputSchema: z.object({
    applied: z.boolean().describe('false: a preview, nothing changed'),
    rule: RuleViewSchema,
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
    const caller = itemCaller(ctx);
    const rule = await TravelRule.findOwn(caller, input.id);
    return {
      output: {
        applied: false,
        rule: toRuleView(rule, await Place.listOwn(caller)),
        summary:
          'Preview: this rule would be removed, and its legs with it. Nothing changed; call again with confirm: true.',
      },
      target: { type: 'travel_rule', id: rule.id },
    };
  },
  async handler(ctx, input) {
    const caller = itemCaller(ctx);
    const rule = await TravelRule.findOwn(caller, input.id);
    const view = toRuleView(rule, await Place.listOwn(caller));
    await TravelSetup.of(caller).removeRule(rule.id);
    return {
      output: { applied: true, rule: view, summary: 'The rule was removed.' },
      target: { type: 'travel_rule', id: rule.id },
    };
  },
});
