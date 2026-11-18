/**
 * Travel time (docs/superpowers/specs/2026-11-17-travel-time-design.md): the pure core (the day
 * plan, the leg reconciler, lengths, links, place matching, geocoding) and the storage classes (a
 * member's places, rules and profile, a workspace's routing quota, and what a member's leaving or
 * a workspace's deletion removes), and generation (the anchors, the 14-day plan and its triggers).
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
export { distanceMeters, nearestWithin, type LatLon } from './geo.js';
export { ChainGeocoder, parseCoordinates, type Geocoder } from './geocoding/Geocoder.js';
export { FreeGeocoder } from './geocoding/FreeGeocoder.js';
export { RouteChain, type StandardChainDeps } from './routing/RouteChain.js';
export type { RoutePlace, RouteProvider, RoutingBudget, Trip } from './routing/RouteProvider.js';
export { openRouteServiceKey, travelClient } from './travelHttp.js';
export { Place, type NewPlace } from './Place.js';
export { TravelRule, type NewTravelRule } from './TravelRule.js';
export { TravelProfile } from './TravelProfile.js';
export { RoutingQuota } from './RoutingQuota.js';
export { TravelData } from './TravelData.js';
export {
  ANCHOR_ROWS_MAX,
  NEW_GEOCODES_MAX,
  TravelAnchors,
  type GatherInput,
  type Gathered,
} from './TravelAnchors.js';
export { TravelPlanner };
