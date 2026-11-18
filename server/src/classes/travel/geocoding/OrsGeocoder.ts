/** OpenRouteService's geocoder (free, shares the key). Any failure is null. */
import type { ReadOnlyClient } from '../../../sync/http.js';
import type { Geocoder, LatLon } from './Geocoder.js';

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
    try {
      const url = `https://api.openrouteservice.org/geocode/search?text=${encodeURIComponent(text)}&size=1`;
      const { data } = await this.#client.getJson<SearchBody>(url, {
        Authorization: this.#apiKey,
      });
      const coordinates = data.features?.[0]?.geometry?.coordinates;
      if (!Array.isArray(coordinates)) return null;
      const [lon, lat] = coordinates as unknown[];
      return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null;
    } catch {
      return null;
    }
  }
}
