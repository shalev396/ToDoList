/**
 * The free geocoders in turn (plan Ruling 14): coordinates typed as text need no lookup; then
 * OpenRouteService's geocoder when the stage has its key; then Nominatim, through the process's one
 * client (one request a second). Nothing found, or every provider down, is null: the caller
 * decides (a new place answers 400 `place_not_found`; an event's location has no place).
 */
import { openRouteServiceKey, sharedNominatimClient, travelClient } from '../travelHttp.js';
import { ChainGeocoder, parseCoordinates, type Geocoder, type LatLon } from './Geocoder.js';
import { NominatimGeocoder } from './NominatimGeocoder.js';
import { OrsGeocoder } from './OrsGeocoder.js';

export class FreeGeocoder implements Geocoder {
  async geocode(text: string): Promise<LatLon | null> {
    // Typed coordinates first: no secret read, no lookup.
    const typed = parseCoordinates(text);
    if (typed !== null) return typed;
    const apiKey = await openRouteServiceKey();
    const nominatim = new NominatimGeocoder(sharedNominatimClient());
    const geocoders: Geocoder[] =
      apiKey === null
        ? [nominatim]
        : [new OrsGeocoder({ apiKey, client: travelClient('openrouteservice') }), nominatim];
    return new ChainGeocoder(geocoders).geocode(text);
  }
}
