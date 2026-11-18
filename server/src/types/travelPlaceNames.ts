/**
 * Where an item is, by the text of its location (travel-time design, "Where an event is", step 1):
 * the saved place whose name or alias the location names. Shared with the client
 * (`@api-types/travelPlaceNames`), so the travel panel's "Its own place (Braude)" is the place the
 * server will find. Pure.
 */

/** What matching reads of a place: its name and its other names. */
export interface NamedPlace {
  name: string;
  aliases: readonly string[];
}

/**
 * Text as names are compared: NFKC, lower case, Hebrew gershayim and geresh as quotes,
 * punctuation (not quotes) out, spaces collapsed.
 */
export function normalizePlaceName(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('״', '"')
    .replaceAll('׳', "'")
    .replace(/[^\p{L}\p{N}\s"']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The place whose normalized name or alias the location contains; the longest match wins. */
export function placeByName<T extends NamedPlace>(
  location: string,
  places: readonly T[],
): T | null {
  const text = normalizePlaceName(location);
  let best: T | null = null;
  let bestLength = 0;
  for (const place of places) {
    for (const label of [place.name, ...place.aliases]) {
      const name = normalizePlaceName(label);
      if (name.length > bestLength && text.includes(name)) {
        best = place;
        bestLength = name.length;
      }
    }
  }
  return best;
}
