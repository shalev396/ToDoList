/** A source of trip lengths. The chain asks each in turn; null means "I can't tell". */
import type { TravelMode } from '../../../types/travel.js';
import type { Estimate } from '../DayPlanner.js';
import type { LatLon } from '../geo.js';

export type { LatLon };

export interface RoutePlace extends LatLon {
  id: string;
}

export interface Trip {
  from: RoutePlace;
  to: RoutePlace;
  mode: TravelMode;
}

export interface RouteProvider {
  readonly modes: readonly TravelMode[];
  estimate(trip: Trip): Promise<Estimate | null>;
}

/**
 * The shared free quota and its cache (implemented by the workspace's routing quota). A cache key
 * names the trip and where its ends are (OpenRouteService.cacheKey), so a moved place is fetched
 * again.
 */
export interface RoutingBudget {
  /** The length already fetched today for this trip, in seconds. */
  cachedSeconds(key: string): Promise<number | null>;
  rememberSeconds(key: string, seconds: number): Promise<void>;
  /** Takes one call from today's quota; false when it is spent. */
  reserve(): Promise<boolean>;
}
