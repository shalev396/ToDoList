/**
 * What the travel tools answer with. A place is its agent view (`Place#toAgentView`: id, name,
 * aliases, Home) and nothing more: an address goes in through travel_set_place and is never
 * returned, by any tool. A rule names its place by name.
 */
import { z } from 'zod';

import type { Place, TravelRule } from '../../../classes/travel/index.js';
import { TRAVEL_MODES, RULE_DIRECTIONS, TravelSettingsSchema } from '../../../types/travel.js';

/** Said by every travel tool: the privacy rule an agent can rely on. */
export const PRIVACY_NOTE =
  'Addresses are accepted but never returned: an agent sees places by name only.';

export const PlaceAgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  home: z.boolean().describe('The member’s Home, where every day of travel starts and ends'),
});

export const RuleViewSchema = z.object({
  id: z.string(),
  scope: z
    .looseObject({ kind: z.enum(['where', 'series', 'item']) })
    .describe(
      'What it applies to: a where-group, every occurrence of a series (itemId), or one item or occurrence (itemId, occurrence)',
    ),
  mode: z.enum(TRAVEL_MODES),
  direction: z.enum(RULE_DIRECTIONS),
  place: z
    .string()
    .nullable()
    .describe('The name of the place it sends the member to; null: the item’s own place'),
  createdAt: z.string(),
});
export type RuleViewOut = z.infer<typeof RuleViewSchema>;

export const SettingsViewSchema = z.object({
  settings: TravelSettingsSchema,
  containerPlaces: z
    .array(z.object({ containerId: z.string(), placeId: z.string() }))
    .describe('The default places of calendars and projects, by container and place id'),
});

/** A rule as an agent sees it: its place by name. */
export function toRuleView(rule: TravelRule, places: readonly Place[]): RuleViewOut {
  const view = rule.toView();
  const place = places.find((candidate) => candidate.id === view.placeId);
  return {
    id: view.id,
    scope: view.scope,
    mode: view.mode,
    direction: view.direction,
    place: place?.name ?? null,
    createdAt: view.createdAt,
  };
}
