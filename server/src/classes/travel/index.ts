/**
 * Travel time (docs/superpowers/specs/2026-11-17-travel-time-design.md): the pure core (the day
 * plan, the leg reconciler, links, place matching) and the storage classes (a member's places,
 * rules and profile with the length of each trip, and what a member's leaving or a workspace's
 * deletion removes), generation (the anchors, the 14-day plan and its triggers), and the setup as
 * the API changes it (TravelSetup: every change regenerates the member's legs). Nothing here calls
 * out: trip lengths are the member's own (the owner's decision of 2026-11-18).
 * The legs themselves are items: TravelLeg, in classes/item.
 *
 * Loading this module subscribes travel to item writes (ItemChanges): a member with travel gets
 * their legs made again when they write a to-do or a time block.
 */
import { ItemChanges } from '../item/ItemChanges.js';
import { TravelPlanner } from './TravelPlanner.js';

ItemChanges.subscribe(TravelPlanner.onItemChange);

export {
  DayPlanner,
  type Anchor,
  type DayPlanInput,
  type Estimate,
  type PlannedLeg,
  type TripKey,
} from './DayPlanner.js';
export { LegKey } from './LegKey.js';
export {
  LegReconciler,
  type AnchorFate,
  type Reconciliation,
  type StoredLegFacts,
} from './LegReconciler.js';
export { PlaceMatcher } from './PlaceMatcher.js';
export { TravelLinks, type LinkLeg } from './TravelLinks.js';
export { Place, type NewPlace, type PlaceChange } from './Place.js';
export {
  TravelRule,
  type MarkItemInput,
  type NewTravelRule,
  type SpanChange,
  type TravelRuleChange,
  type UnmarkItemInput,
} from './TravelRule.js';
export { TravelSetup } from './TravelSetup.js';
export { TravelProfile } from './TravelProfile.js';
export { TravelData } from './TravelData.js';
export {
  ANCHOR_ROWS_MAX,
  TravelAnchors,
  type GatherInput,
  type Gathered,
  type RuledAnchor,
} from './TravelAnchors.js';
export { AFTER_SYNC_BUDGET_MS, TravelPlanner, type PreviewInput } from './TravelPlanner.js';
