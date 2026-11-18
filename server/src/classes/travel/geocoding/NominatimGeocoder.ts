/**
 * Nominatim (OpenStreetMap), free at one request a second: the client it is given spaces calls
 * (travelClient('nominatim')). The usage policy asks for an identifying User-Agent. Nothing found
 * is null; a failed request (its error carries the provider and a status, never the URL) or an
 * answer it can't read throws, so an outage is never taken for "not found".
 */
import { environment } from '../../../config/environment.js';
import type { ReadOnlyClient } from '../../../sync/http.js';
import { GeocodingUnavailableError, type Geocoder, type LatLon } from './Geocoder.js';

type SearchBody = { lat?: unknown; lon?: unknown }[];

export class NominatimGeocoder implements Geocoder {
  readonly #client: ReadOnlyClient;

  constructor(client: ReadOnlyClient) {
    this.#client = client;
  }

  async geocode(text: string): Promise<LatLon | null> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=jsonv2&limit=1`;
    const { data } = await this.#client.getJson<unknown>(url, {
      'User-Agent': `TodoList/1.0 (+https://${environment.domainName})`,
    });
    if (!Array.isArray(data)) throw new GeocodingUnavailableError();
    const [first] = data as SearchBody;
    if (first === undefined) return null;
    const lat = Number(first.lat);
    const lon = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new GeocodingUnavailableError();
    return { lat, lon };
  }
}
