/** Turning a place's text into coordinates, free providers only. */
import type { LatLon } from '../geo.js';

export type { LatLon };

export interface Geocoder {
  geocode(text: string): Promise<LatLon | null>;
}

const COORDINATES = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** `"lat, lon"` typed as coordinates (Ruling 14), or null. */
export function parseCoordinates(text: string): LatLon | null {
  const match = COORDINATES.exec(text);
  if (match === null) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Typed coordinates need no lookup; otherwise each geocoder in turn, the first hit wins. */
export class ChainGeocoder implements Geocoder {
  readonly #geocoders: readonly Geocoder[];

  constructor(geocoders: readonly Geocoder[]) {
    this.#geocoders = geocoders;
  }

  async geocode(text: string): Promise<LatLon | null> {
    const typed = parseCoordinates(text);
    if (typed !== null) return typed;
    if (text.trim() === '') return null;
    for (const geocoder of this.#geocoders) {
      const found = await geocoder.geocode(text);
      if (found !== null) return found;
    }
    return null;
  }
}
