/** The last resort: the straight-line distance at a typical speed for the mode. */
import { STRAIGHT_LINE, type TravelMode, type TravelSettings } from '../../../types/travel.js';
import type { Estimate } from '../DayPlanner.js';
import { distanceMeters } from '../geo.js';
import type { RouteProvider, Trip } from './RouteProvider.js';

const ALL_MODES: readonly TravelMode[] = ['walk', 'drive', 'transit'];

export class StraightLine implements RouteProvider {
  readonly modes = ALL_MODES;
  readonly #settings: TravelSettings;

  constructor(settings: TravelSettings) {
    this.#settings = settings;
  }

  estimate(trip: Trip): Promise<Estimate | null> {
    const { kmh, detour } = STRAIGHT_LINE[trip.mode];
    const km = distanceMeters(trip.from, trip.to) / 1000;
    const minutes =
      Math.ceil(((km * detour) / kmh) * 60 * this.#settings.factors[trip.mode]) +
      this.#settings.buffers[trip.mode];
    return Promise.resolve({ minutes, source: 'estimate' });
  }
}
