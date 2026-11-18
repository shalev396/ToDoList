/** The member's last length for the same trip (an edited or entered one), in minutes. */
import type { TravelMode } from '../../../types/travel.js';
import type { Estimate } from '../DayPlanner.js';
import type { RouteProvider, Trip } from './RouteProvider.js';

const ALL_MODES: readonly TravelMode[] = ['walk', 'drive', 'transit'];

export class RememberedLength implements RouteProvider {
  readonly modes = ALL_MODES;
  readonly #lookup: (fromId: string, toId: string, mode: TravelMode) => number | null;

  constructor(lookup: (fromId: string, toId: string, mode: TravelMode) => number | null) {
    this.#lookup = lookup;
  }

  estimate(trip: Trip): Promise<Estimate | null> {
    const minutes = this.#lookup(trip.from.id, trip.to.id, trip.mode);
    return Promise.resolve(minutes === null ? null : { minutes, source: 'remembered' });
  }
}
