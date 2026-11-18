/**
 * OpenRouteService's geocoder (free, shares the key). Nothing found is null; a failed request or an
 * answer it can't read throws, so an outage is never taken for "not found".
 */
import type { ReadOnlyClient } from '../../../sync/http.js';
import { GeocodingUnavailableError, type Geocoder, type LatLon } from './Geocoder.js';

interface SearchBody {
  features?: { geometry?: { coordinates?: unknown } }[];
}

export class OrsGeocoder implements Geocoder {
  readonly #apiKey: string;
  readonly #client: ReadOnlyClient;

  constructor(deps: { apiKey: string; client: ReadOnlyClient }) {
    this.#apiKey = deps.apiKey;
    this.#client = deps.client;
  }

  async geocode(text: string): Promise<LatLon | null> {
    const url = `https://api.openrouteservice.org/geocode/search?text=${encodeURIComponent(text)}&size=1`;
    const { data } = await this.#client.getJson<SearchBody | null>(url, {
      Authorization: this.#apiKey,
    });
    const features: unknown = data?.features;
    if (!Array.isArray(features)) throw new GeocodingUnavailableError();
    const [first] = features as NonNullable<SearchBody['features']>;
    if (first === undefined) return null;
    const coordinates = first.geometry?.coordinates;
    const [lon, lat] = Array.isArray(coordinates) ? (coordinates as unknown[]) : [];
    if (typeof lat !== 'number' || typeof lon !== 'number') throw new GeocodingUnavailableError();
    return { lat, lon };
  }
}
