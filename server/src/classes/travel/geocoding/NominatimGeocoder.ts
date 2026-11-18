/**
 * Nominatim (OpenStreetMap), free at one request a second: the client it is given spaces calls
 * (travelClient('nominatim')). The usage policy asks for an identifying User-Agent.
 */
import { environment } from '../../../config/environment.js';
import type { ReadOnlyClient } from '../../../sync/http.js';
import type { Geocoder, LatLon } from './Geocoder.js';

type SearchBody = { lat?: unknown; lon?: unknown }[];

export class NominatimGeocoder implements Geocoder {
  readonly #client: ReadOnlyClient;

  constructor(client: ReadOnlyClient) {
    this.#client = client;
  }

  async geocode(text: string): Promise<LatLon | null> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=jsonv2&limit=1`;
      const { data } = await this.#client.getJson<SearchBody>(url, {
        'User-Agent': `TodoList/1.0 (+https://${environment.domainName})`,
      });
      const first = Array.isArray(data) ? data[0] : undefined;
      if (first === undefined) return null;
      const lat = Number(first.lat);
      const lon = Number(first.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    } catch {
      return null;
    }
  }
}
