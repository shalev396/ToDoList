/** Matching an item's location text to a saved place by name or alias. */
interface Named {
  name: string;
  aliases: readonly string[];
}

export class PlaceMatcher<T extends Named> {
  readonly #places: readonly T[];

  private constructor(places: readonly T[]) {
    this.#places = places;
  }

  /** NFKC, lower case, Hebrew gershayim/geresh to quotes, punctuation (not quotes) out, spaces collapsed. */
  static normalize(text: string): string {
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
  static byName<T extends Named>(location: string, places: readonly T[]): T | null {
    return new PlaceMatcher(places).#find(PlaceMatcher.normalize(location));
  }

  #find(location: string): T | null {
    let best: T | null = null;
    let bestLength = 0;
    for (const place of this.#places) {
      for (const label of [place.name, ...place.aliases]) {
        const normalized = PlaceMatcher.normalize(label);
        if (normalized.length > bestLength && location.includes(normalized)) {
          best = place;
          bestLength = normalized.length;
        }
      }
    }
    return best;
  }
}
