/**
 * Globs, shared by the topic rules (File under) and the Subject option patterns: matched against
 * the whole text, ignoring case; `*` matches any run of characters, `/` and line breaks
 * included; every other character is literal. Pure: no imports.
 */
const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\/]/g;

/** The regular expression source of a glob: `^` + the literal parts joined by `.*` + `$`. */
export function globSource(pattern: string): string {
  return `^${pattern
    .split('*')
    .map((part) => part.replace(REGEXP_SYNTAX, '\\$&'))
    .join('.*')}$`;
}

/** True when the glob `pattern` matches all of `text`, ignoring case. */
export function matchesGlob(pattern: string, text: string): boolean {
  return new RegExp(globSource(pattern), 'isu').test(text);
}
