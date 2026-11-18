/** App links for a leg: Waze for driving, Moovit for transit, Google Maps as the common one. */
import type { TravelLink, TravelMode } from '../../types/travel.js';
import type { LatLon } from './geo.js';

export interface LinkLeg {
  mode: TravelMode;
  from: LatLon | null;
  to: LatLon | null;
  arriveBy: Date;
}

const GOOGLE_MODE: Record<TravelMode, string> = {
  walk: 'walking',
  drive: 'driving',
  transit: 'transit',
};

const MOOVIT_FALLBACK = 'https://moovitapp.com/';

const pair = (point: LatLon): string => `${String(point.lat)},${String(point.lon)}`;

export class TravelLinks {
  readonly #leg: LinkLeg;

  private constructor(leg: LinkLeg) {
    this.#leg = leg;
  }

  static for(leg: LinkLeg): TravelLink[] {
    return new TravelLinks(leg).#links();
  }

  #links(): TravelLink[] {
    const { mode, to } = this.#leg;
    if (to === null) return [];
    if (mode === 'walk') return [this.#google(to)];
    if (mode === 'drive')
      return [
        { app: 'waze', url: `https://waze.com/ul?ll=${pair(to)}&navigate=yes` },
        this.#google(to),
      ];
    return [this.#moovit(to), this.#google(to)];
  }

  #google(to: LatLon): TravelLink {
    const { from, mode } = this.#leg;
    const origin = from === null ? '' : `&origin=${pair(from)}`;
    return {
      app: 'google_maps',
      url: `https://www.google.com/maps/dir/?api=1${origin}&destination=${pair(to)}&travelmode=${GOOGLE_MODE[mode]}`,
    };
  }

  #moovit(to: LatLon): TravelLink {
    const { from, arriveBy } = this.#leg;
    const orig = from === null ? '' : `orig_lat=${String(from.lat)}&orig_lon=${String(from.lon)}&`;
    return {
      app: 'moovit',
      url: `moovit://directions?${orig}dest_lat=${String(to.lat)}&dest_lon=${String(to.lon)}&date=${arriveBy.toISOString()}&auto_run=true`,
      fallbackUrl: MOOVIT_FALLBACK,
    };
  }
}
