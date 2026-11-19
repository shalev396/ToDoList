/**
 * Where an item is, by the text of its location (travel-time design, "Where an event is", step 1):
 * the saved place whose name or alias the location names. Shared with the client
 * (`@api-types/travelPlaceNames`), so the travel panel's "Its own place (Braude)" is the place the
 * server will find. Pure.
 *
 * A name is found as whole words, never inside a word ("Home" is not in "Homestead"), and never
 * as part of a longer name ("Home" is not "Nursing home", "בית" is not "בית קפה").
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

/** A Hebrew one-letter prefix (in, to, from, the, and, that, as): one may be glued to a name. */
const HEBREW_PREFIXES: ReadonlySet<string> = new Set(['ב', 'ל', 'מ', 'ה', 'ו', 'ש', 'כ']);

/** English words that may stand right before a name: "at home", "lecture at Braude". */
const ENGLISH_GLUE: ReadonlySet<string> = new Set(['at', 'in', 'to', 'from', 'near', 'the', 'my']);

const HEBREW = /\p{Script=Hebrew}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Where a location's parts end: a comma, a semicolon, a bracket, a slash, a line break, a spaced
 * dash ("Room 4 - Braude"). A dash inside a word ("Tel-Aviv") is no break.
 */
const SEGMENT_BREAK = /[,;|/\\()[\]{}\n\r•·]+|\s[-–—]+\s/u;

const wordsOf = (text: string): string[] => {
  const normalized = normalizePlaceName(text);
  return normalized === '' ? [] : normalized.split(' ');
};

/**
 * Whether the name's words stand at `index` of the segment's words, as whole words: the first
 * may carry ONE Hebrew one-letter prefix when the name starts with a Hebrew letter ("בבית",
 * "לבראודה").
 */
function wordsAt(words: readonly string[], index: number, name: readonly string[]): boolean {
  return name.every((part, offset) => {
    const word = words[index + offset];
    if (word === undefined) return false;
    if (word === part) return true;
    return (
      offset === 0 &&
      HEBREW.test(part.charAt(0)) &&
      word.length === part.length + 1 &&
      HEBREW_PREFIXES.has(word.charAt(0)) &&
      word.slice(1) === part
    );
  });
}

/**
 * Whether the name found at `index` names the place, not part of a longer name. Hebrew puts the
 * head first, so a Hebrew name followed by another Hebrew word is that word's ("בית קפה" is a
 * café, "בית חולים" a hospital). English puts it last, so an English name after another English
 * word is that word's ("Nursing home"), unless the word is a preposition ("at home").
 */
function standsAlone(words: readonly string[], index: number, name: readonly string[]): boolean {
  const label = name.join(' ');
  if (HEBREW.test(label)) {
    const next = words[index + name.length];
    return next === undefined || !HEBREW.test(next);
  }
  if (LATIN.test(label)) {
    const before = words[index - 1];
    return (
      before === undefined ||
      !LATIN.test(before) ||
      ENGLISH_GLUE.has(before) ||
      HEBREW_PREFIXES.has(before)
    );
  }
  return true;
}

/**
 * The place a location names: one whose normalized name or alias stands in it as whole words
 * (one Hebrew one-letter prefix allowed on its first word), within one part of the location (parts
 * end at a comma, a bracket, a line break...), and not as part of a longer name (`standsAlone`).
 * The longest name found wins.
 */
export function placeByName<T extends NamedPlace>(
  location: string,
  places: readonly T[],
): T | null {
  const segments = location
    .split(SEGMENT_BREAK)
    .map(wordsOf)
    .filter((words) => words.length > 0);
  let best: T | null = null;
  let bestLength = 0;
  for (const place of places) {
    for (const label of [place.name, ...place.aliases]) {
      const name = wordsOf(label);
      const length = name.join(' ').length;
      if (name.length === 0 || length <= bestLength) continue;
      const found = segments.some((words) =>
        words.some(
          (_word, index) => wordsAt(words, index, name) && standsAlone(words, index, name),
        ),
      );
      if (found) {
        best = place;
        bestLength = length;
      }
    }
  }
  return best;
}
