/**
 * OpenRouteService directions for walking and driving (free, shared quota). Today's cache first,
 * then one reserved call. Any failure is null: the chain falls back. Nothing it throws or returns
 * carries a URL or coordinates.
 */
import type { ReadOnlyClient } from '../../../sync/http.js';
import type { TravelMode, TravelSettings } from '../../../types/travel.js';
import { DayPlanner, type Estimate } from '../DayPlanner.js';
import type { RouteProvider, RoutingBudget, Trip } from './RouteProvider.js';

const PROFILES: Partial<Record<TravelMode, string>> = {
  walk: 'foot-walking',
  drive: 'driving-car',
};

export interface OpenRouteServiceDeps {
  apiKey: string;
  client: ReadOnlyClient;
  budget: RoutingBudget;
  settings: TravelSettings;
}

interface DirectionsBody {
  features?: { properties?: { summary?: { duration?: unknown } } }[];
}

export class OpenRouteService implements RouteProvider {
  readonly modes: readonly TravelMode[] = ['walk', 'drive'];
  readonly #deps: OpenRouteServiceDeps;

  constructor(deps: OpenRouteServiceDeps) {
    this.#deps = deps;
  }

  async estimate(trip: Trip): Promise<Estimate | null> {
    const profile = PROFILES[trip.mode];
    if (profile === undefined) return null;
    const { budget, settings } = this.#deps;
    try {
      const key = DayPlanner.tripKey(trip.from.id, trip.to.id, trip.mode);
      let seconds = await budget.cachedSeconds(key);
      if (seconds === null) {
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
    const { client, apiKey } = this.#deps;
    const url =
      `https://api.openrouteservice.org/v2/directions/${profile}` +
      `?start=${String(trip.from.lon)},${String(trip.from.lat)}` +
      `&end=${String(trip.to.lon)},${String(trip.to.lat)}`;
    const { data } = await client.getJson<DirectionsBody>(url, { Authorization: apiKey });
    const duration = data.features?.[0]?.properties?.summary?.duration;
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
      ? duration
      : null;
  }
}
