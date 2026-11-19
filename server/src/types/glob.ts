/**
 * Globs, shared by the topic rules (File under) and the Subject option patterns: matched against
 * the whole text, ignoring case; `*` matches any run of characters, `/` and line breaks
 * included; every other character is literal. Hebrew gershayim (U+05F4) and geresh (U+05F3) read
 * as the ASCII `"` and `'` on both sides, so a pattern typed with a keyboard quote matches a
 * title written with the Hebrew mark. Pure: no imports.
 */
/** The most `*` a pattern may hold, so a `$regex` built from it stays bounded. */
export const GLOB_WILDCARDS_MAX = 8;

const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\/]/g;

/** True when the pattern holds more `*` than a glob may. */
export function hasTooManyWildcards(pattern: string): boolean {
  return pattern.split('*').length - 1 > GLOB_WILDCARDS_MAX;
}

/** Hebrew quote marks as ASCII, and lower case: what both sides are compared as. */
function fold(text: string): string {
  return text.replaceAll('\u05F4', '"').replaceAll('\u05F3', "'").toLowerCase();
}

const SPECIAL = new RegExp(`["״'׳]|${REGEXP_SYNTAX.source}`, 'gu');

function literalSource(part: string): string {
  return part.replace(SPECIAL, (char) => {
    if (char === '"' || char === '״') return '["״]';
    if (char === "'" || char === '׳') return "['׳]";
    return `\\${char}`;
  });
}

/**
 * The regular expression source of a glob: `^` + the literal parts joined by `.*` + `$`, with the
 * quote marks as classes (use it with the `is` options).
 */
export function globSource(pattern: string): string {
  return `^${pattern.split('*').map(literalSource).join('.*')}$`;
}

/**
 * True when the glob `pattern` matches all of `text`, ignoring case. Linear: the parts between
 * the `*` are found in order with `indexOf`, so there is no backtracking.
 */
export function matchesGlob(pattern: string, text: string): boolean {
  const parts = fold(pattern).split('*');
  const subject = fold(text);
  const [first = ''] = parts;
  if (parts.length === 1) return subject === first;
  const last = parts[parts.length - 1] ?? '';
  if (subject.length < first.length + last.length) return false;
  if (!subject.startsWith(first) || !subject.endsWith(last)) return false;
  const end = subject.length - last.length;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    if (part === '') continue;
    const found = subject.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}
