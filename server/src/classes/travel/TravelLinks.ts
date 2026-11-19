/**
 * App links for a leg, from the places' text (the owner's decision of 2026-11-18: nothing is looked
 * up, and no coordinate is kept): each end is its place's address as he typed it, or its name when
 * it has none. Waze for driving, and Google Maps directions in the leg's mode for every trip.
 */
import type { TravelLink, TravelMode } from '../../types/travel.js';

export interface LinkLeg {
  mode: TravelMode;
  /** Where the trip starts, as text (an address, else a name); null: unknown (it went). */
  from: string | null;
  /** Where it goes, as text; null: unknown (no link then). */
  to: string | null;
}

const GOOGLE_MODE: Record<TravelMode, string> = {
  walk: 'walking',
  drive: 'driving',
  transit: 'transit',
};

const text = (value: string): string => encodeURIComponent(value);

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
    if (to === null || to.trim() === '') return [];
    const google = this.#google(to);
    return mode === 'drive' ? [this.#waze(to), google] : [google];
  }

  #waze(to: string): TravelLink {
    return { app: 'waze', url: `https://waze.com/ul?q=${text(to)}&navigate=yes` };
  }

  #google(to: string): TravelLink {
    const { from, mode } = this.#leg;
    const origin = from === null || from.trim() === '' ? '' : `&origin=${text(from)}`;
    return {
      app: 'google_maps',
      url: `https://www.google.com/maps/dir/?api=1${origin}&destination=${text(to)}&travelmode=${GOOGLE_MODE[mode]}`,
    };
  }
}
