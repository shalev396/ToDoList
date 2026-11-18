/**
 * Matching an item's location text to a saved place by name or alias. The matching itself is the
 * shared, pure `types/travelPlaceNames.ts`, so the client names the place the server will find.
 */
import { normalizePlaceName, placeByName, type NamedPlace } from '../../types/travelPlaceNames.js';

export class PlaceMatcher<T extends NamedPlace> {
  readonly #places: readonly T[];

  private constructor(places: readonly T[]) {
    this.#places = places;
  }

  /** NFKC, lower case, Hebrew gershayim/geresh to quotes, punctuation (not quotes) out, spaces collapsed. */
  static normalize(text: string): string {
    return normalizePlaceName(text);
  }

  /** The place whose normalized name or alias the location contains; the longest match wins. */
  static byName<T extends NamedPlace>(location: string, places: readonly T[]): T | null {
    return new PlaceMatcher(places).#find(location);
  }

  #find(location: string): T | null {
    return placeByName(location, this.#places);
  }
}
