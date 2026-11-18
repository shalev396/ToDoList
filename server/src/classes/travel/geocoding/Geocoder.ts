/**
 * Turning a place's text into coordinates, free providers only. Three answers: a point; null, the
 * provider looked and found nothing (worth remembering); or a throw, the provider couldn't tell
 * (down, refused, rate-limited, timed out, an answer it couldn't read), which is never remembered
 * as "not found".
 */
import type { LatLon } from '../geo.js';

export type { LatLon };

export interface Geocoder {
  /** The point; null when nothing was found; throws when no answer could be had. */
  geocode(text: string): Promise<LatLon | null>;
}

/** A geocoder couldn't tell where a text is: it failed, or (a chain) every one asked failed. */
export class GeocodingUnavailableError extends Error {
  constructor() {
    super('No geocoder could tell where this is');
    this.name = 'GeocodingUnavailableError';
  }
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

/**
 * Typed coordinates need no lookup; otherwise each geocoder in turn, the first hit wins. Null when
 * at least one of them looked and found nothing; GeocodingUnavailableError when every one failed.
 */
export class ChainGeocoder implements Geocoder {
  readonly #geocoders: readonly Geocoder[];

  constructor(geocoders: readonly Geocoder[]) {
    this.#geocoders = geocoders;
  }

  async geocode(text: string): Promise<LatLon | null> {
    const typed = parseCoordinates(text);
    if (typed !== null) return typed;
    if (text.trim() === '') return null;
    let answered = this.#geocoders.length === 0;
    for (const geocoder of this.#geocoders) {
      try {
        const found = await geocoder.geocode(text);
        if (found !== null) return found;
        answered = true;
      } catch {
        // This one couldn't tell: the next one is asked.
      }
    }
    if (answered) return null;
    throw new GeocodingUnavailableError();
  }
}
