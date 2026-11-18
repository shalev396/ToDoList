/**
 * Page variables in the URL (FRONTEND.md §4): each `$page.<name>` variable is the search param
 * `<name>`, so a filtered page can be shared and survives a reload.
 *
 * - `edit`, `item`, `occurrence` and `as` belong to the page itself and are never variables, nor
 *   is anything that is not a variable name (`utm_source`).
 * - Values are strings. A list is comma-separated (`provider=jira,github`); a date range is a
 *   preset key (`range=this_week`) or `from..to` in ISO (`range=2026-11-01T00:00:00Z..…`).
 * - An empty value (`provider=`) unsets a variable whose dashboard default is set.
 * - A backslash escapes a comma, a backslash, or a dot that follows a dot, so any text survives a
 *   round trip, even text that reads like a list or a range.
 */
import type { DateRangeBounds, VarValue } from '@api-types/builder.ts';
import { VAR_NAME_PATTERN } from './names.ts';

/** Every page variable by bare name. Null-prototype, so `constructor` is a name like any other. */
export type PageVars = Readonly<Record<string, VarValue>>;

/**
 * Search params of the page itself: edit mode, the open item sheet (and the occurrence of a
 * repeating item it is on), the dashboard copy.
 */
export const RESERVED_PARAMS: ReadonlySet<string> = new Set([
  'edit',
  'item',
  'occurrence',
  'as',
  'dashboard',
  'view',
]);

const LIST_SEPARATOR = ',';
const RANGE_SEPARATOR = '..';
const ESCAPE = '\\';

/** What the server accepts as a range bound (`z.iso.datetime({ offset: true })`). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isReservedParam(name: string): boolean {
  return RESERVED_PARAMS.has(name);
}

/** A name a page variable can have in the URL. */
export function isUrlVarName(name: string): boolean {
  return !isReservedParam(name) && VAR_NAME_PATTERN.test(name);
}

export function isDateRange(value: unknown): value is DateRangeBounds {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { from?: unknown }).from === 'string' &&
    typeof (value as { to?: unknown }).to === 'string'
  );
}

/** Null, or a list without items: the server reads both as "not set". */
export function isUnsetValue(value: VarValue | undefined): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

export function sameVarValue(a: VarValue | undefined, b: VarValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => item === b[index])
    );
  }
  if (isDateRange(a) || isDateRange(b)) {
    return isDateRange(a) && isDateRange(b) && a.from === b.from && a.to === b.to;
  }
  return a === b;
}

/** Escapes the characters the decoder reads as structure. */
function escapeText(text: string): string {
  let out = '';
  let previous = '';
  for (const char of text) {
    if (char === ESCAPE || char === LIST_SEPARATOR || (char === '.' && previous === '.')) {
      out += ESCAPE;
    }
    out += char;
    previous = char;
  }
  return out;
}

function scalarText(value: string | number | boolean | null): string {
  return value === null ? '' : escapeText(String(value));
}

/** The URL text of a value: '' for "unset". */
export function encodeVarValue(value: VarValue): string {
  if (value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(scalarText).join(LIST_SEPARATOR);
  }
  if (isDateRange(value)) {
    return `${value.from}${RANGE_SEPARATOR}${value.to}`;
  }
  return scalarText(value);
}

interface Token {
  /** The text with escapes resolved. */
  text: string;
  /** Where an unescaped `..` starts in `text`, if one does. */
  rangeAt: number | null;
}

/**
 * Splits on unescaped commas and finds the first unescaped `..` of each item. It walks UTF-16
 * units: the structure characters are ASCII, never half of a pair, and an escaped half is copied
 * as it is, so text in any script comes through whole.
 */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let rangeAt: number | null = null;
  let previousWasPlainDot = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index);
    if (char === ESCAPE && index + 1 < raw.length) {
      text += raw.charAt(index + 1);
      index += 1;
      previousWasPlainDot = false;
      continue;
    }
    if (char === LIST_SEPARATOR) {
      tokens.push({ text, rangeAt });
      text = '';
      rangeAt = null;
      previousWasPlainDot = false;
      continue;
    }
    if (char === '.' && previousWasPlainDot && rangeAt === null) {
      rangeAt = text.length - 1;
    }
    previousWasPlainDot = char === '.';
    text += char;
  }
  tokens.push({ text, rangeAt });
  return tokens;
}

function asDateRange(token: Token): DateRangeBounds | null {
  if (token.rangeAt === null) {
    return null;
  }
  const from = token.text.slice(0, token.rangeAt);
  const to = token.text.slice(token.rangeAt + RANGE_SEPARATOR.length);
  if (!ISO_DATE_TIME.test(from) || !ISO_DATE_TIME.test(to)) {
    return null;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  return Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs ? { from, to } : null;
}

/** A value from its URL text: '' is null; a list is strings; a valid `from..to` is a range. */
export function decodeVarValue(raw: string): VarValue {
  if (raw === '') {
    return null;
  }
  const tokens = tokenize(raw);
  const [single] = tokens;
  if (tokens.length > 1 || single === undefined) {
    return tokens.map((token) => token.text);
  }
  return asDateRange(single) ?? single.text;
}

/** The page variables a URL sets (the first of repeated params wins). */
export function readUrlVars(search: URLSearchParams): PageVars {
  const vars = Object.create(null) as Record<string, VarValue>;
  for (const [name, raw] of search) {
    if (isUrlVarName(name) && !Object.hasOwn(vars, name)) {
      vars[name] = decodeVarValue(raw);
    }
  }
  return vars;
}

/**
 * The params with one variable set (`value`), or back to its default (`undefined`). A value equal
 * to the default needs no param, and neither does "unset" when the default is unset too. Every
 * other param stays; reserved and invalid names are never written.
 */
export function withUrlVar(
  search: URLSearchParams,
  name: string,
  value: VarValue | undefined,
  defaultValue: VarValue | undefined,
): URLSearchParams {
  const next = new URLSearchParams(search);
  if (!isUrlVarName(name)) {
    return next;
  }
  const isDefault =
    value === undefined ||
    sameVarValue(value, defaultValue) ||
    (isUnsetValue(value) && isUnsetValue(defaultValue));
  if (isDefault) {
    next.delete(name);
  } else {
    next.set(name, encodeVarValue(value));
  }
  return next;
}
