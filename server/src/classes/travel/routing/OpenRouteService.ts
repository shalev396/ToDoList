/**
 * OpenRouteService directions for walking and driving (free, shared quota). Today's cache first,
 * then one reserved call. Any failure is null: the chain falls back. Nothing it throws or returns
 * carries a URL or coordinates.
 *
 * The day's cache is keyed by the trip AND both ends' coordinates (`cacheKey`), so a place whose
 * address or pin was corrected is asked again at once, not after the day is over. A provider
 * found unreachable (`Reachability`) is not asked again for a while, nor is a call reserved for
 * it: an outage costs one wait, not one per write.
 */
import type { ReadOnlyClient } from '../../../sync/http.js';
import type { TravelMode, TravelSettings } from '../../../types/travel.js';
import { DayPlanner, type Estimate } from '../DayPlanner.js';
import type { Reachability } from './Reachability.js';
import type { RouteProvider, RoutePlace, RoutingBudget, Trip } from './RouteProvider.js';

const PROFILES: Partial<Record<TravelMode, string>> = {
  walk: 'foot-walking',
  drive: 'driving-car',
};

/** Coordinates in the cache key, in units of 1e-5° (about a metre). */
const COORDINATE_SCALE = 1e5;

export interface OpenRouteServiceDeps {
  apiKey: string;
  client: ReadOnlyClient;
  budget: RoutingBudget;
  settings: TravelSettings;
  /** Whether it answered lately (absent: always asked). */
  reachability?: Reachability | undefined;
}

interface DirectionsBody {
  features?: { properties?: { summary?: { duration?: unknown } } }[];
}

/** One end as the cache key reads it: `lat:lon` in 1e-5°, whole numbers (a field key has no dot). */
function spot(place: RoutePlace): string {
  return `${String(Math.round(place.lat * COORDINATE_SCALE))}:${String(Math.round(place.lon * COORDINATE_SCALE))}`;
}

export class OpenRouteService implements RouteProvider {
  readonly modes: readonly TravelMode[] = ['walk', 'drive'];
  readonly #deps: OpenRouteServiceDeps;

  constructor(deps: OpenRouteServiceDeps) {
    this.#deps = deps;
  }

  /** The day cache's key: `from|to|mode|fromLat:fromLon|toLat:toLon` (place ids, 1e-5°). */
  static cacheKey(trip: Trip): string {
    return [
      DayPlanner.tripKey(trip.from.id, trip.to.id, trip.mode),
      spot(trip.from),
      spot(trip.to),
    ].join('|');
  }

  async estimate(trip: Trip): Promise<Estimate | null> {
    const profile = PROFILES[trip.mode];
    if (profile === undefined) return null;
    const { budget, settings, reachability } = this.#deps;
    try {
      const key = OpenRouteService.cacheKey(trip);
      let seconds = await budget.cachedSeconds(key);
      if (seconds === null) {
        if (reachability?.down === true) return null;
        if (!(await budget.reserve())) return null;
        seconds = await this.#fetchSeconds(profile, trip);
        if (seconds === null) return null;
        await budget.rememberSeconds(key, seconds);
      }
      const minutes =
        Math.ceil((seconds / 60) * settings.factors[trip.mode]) + settings.buffers[trip.mode];
      return { minutes, source: 'ors' };
    } catch {
      return null;
    }
  }

  async #fetchSeconds(profile: string, trip: Trip): Promise<number | null> {
    const { client, apiKey, reachability } = this.#deps;
    const url =
      `https://api.openrouteservice.org/v2/directions/${profile}` +
      `?start=${String(trip.from.lon)},${String(trip.from.lat)}` +
      `&end=${String(trip.to.lon)},${String(trip.to.lat)}`;
    let data: DirectionsBody;
    try {
      ({ data } = await client.getJson<DirectionsBody>(url, { Authorization: apiKey }));
    } catch (error) {
      reachability?.failed(error);
      throw error;
    }
    const duration = data.features?.[0]?.properties?.summary?.duration;
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
      ? duration
      : null;
  }
}
