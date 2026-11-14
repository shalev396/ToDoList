/**
 * A static view of server/src's import graph, for the tests that guard who may import what
 * (services/crypto/vaultImports.test.ts, classes/classBoundary.test.ts).
 *
 * The scanner is string-, template- and regex-aware: a comment marker inside a literal is text,
 * and code that only looks like code (inside a literal) doesn't count. Specifiers may use single
 * quotes, double quotes or backticks, and their escapes are decoded. Static imports, re-exports,
 * side-effect imports and dynamic `import()` / `require()` calls are all edges; a dynamic import
 * whose argument is not one string literal has a null specifier.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server/src, with a trailing separator. */
export const SRC = fileURLToPath(new URL('../', import.meta.url));

// ─── The scanner ────────────────────────────────────────────────────────────

export interface Scan {
  /** The source with every comment blanked out (same length and offsets as the source). */
  code: string;
  /** `code` with the insides of strings, template text and regex literals blanked as well. */
  masked: string;
  /** Every string literal and piece of template text, escapes decoded. */
  literals: string[];
  /** False when the source ended inside a string, template or comment: the scan lost track. */
  complete: boolean;
}

const IDENTIFIER = /[\w$]/;
/** After these words a `/` starts a regex literal, not a division. */
const BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
const ESCAPE = /\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|(\r\n|[\s\S]))/gi;
const SINGLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/** A literal's text as JavaScript reads it (escapes decoded; a line continuation is nothing). */
export function decodeEscapes(raw: string): string {
  return raw.replace(
    ESCAPE,
    (_all: string, braced?: string, four?: string, two?: string, other?: string): string => {
      const hex = braced ?? four ?? two;
      if (hex !== undefined) {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
      }
      if (other === undefined || /^[\r\n]/.test(other)) return '';
      return SINGLE_ESCAPES[other] ?? other;
    },
  );
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf('\n', from);
  return end === -1 ? source.length : end;
}

/** The closing quote of the string starting at `start`, or -1 when the line or file ends first. */
function closingQuote(source: string, start: number): number {
  const quote = source.charAt(start);
  for (let k = start + 1; k < source.length; k += 1) {
    const c = source.charAt(k);
    if (c === '\\') k += 1;
    else if (c === quote) return k;
    else if (c === '\n') return -1;
  }
  return -1;
}

/** The closing slash of the regex literal starting at `start`, or -1 (then it was a division). */
function closingSlash(source: string, start: number): number {
  let inClass = false;
  for (let k = start + 1; k < source.length; k += 1) {
    const c = source.charAt(k);
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') k += 1;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return k;
  }
  return -1;
}

/** Whether a `/` after this code starts a regex literal (or else divides). */
function regexAllowed(previous: string, word: string): boolean {
  if (IDENTIFIER.test(previous)) return BEFORE_EXPRESSION.has(word);
  return previous !== ')' && previous !== ']' && previous !== '}';
}

/** Splits a TypeScript source into code, literals and comments. */
export function scan(source: string): Scan {
  const code = source.split('');
  const masked = source.split('');
  const literals: string[] = [];
  let complete = true;

  const blank = (from: number, to: number, isComment: boolean): void => {
    for (let k = from; k < Math.min(to, source.length); k += 1) {
      if (source.charAt(k) === '\n') continue;
      masked[k] = ' ';
      if (isComment) code[k] = ' ';
    }
  };
  const literal = (from: number, to: number): void => {
    literals.push(decodeEscapes(source.slice(from, to)));
    blank(from, to, false);
  };

  /** The brace depth of the code around each open `${`. */
  const outerBraces: number[] = [];
  let braces = 0;
  /** The last code character that isn't white space, where it is, and the word it ends. */
  let previous = '';
  let previousAt = -1;
  let word = '';
  const afterOperand = (at: number): void => {
    previous = ')';
    previousAt = at;
    word = '';
  };

  /** Template text from `start`: returns where code resumes (after the backtick, or in a `${`). */
  const templateText = (start: number): number => {
    for (let k = start; k < source.length; k += 1) {
      const c = source.charAt(k);
      if (c === '\\') {
        k += 1;
      } else if (c === '`') {
        literal(start, k);
        afterOperand(k);
        return k + 1;
      } else if (c === '$' && source.charAt(k + 1) === '{') {
        literal(start, k);
        outerBraces.push(braces);
        braces = 0;
        previous = '{';
        previousAt = k + 1;
        word = '';
        return k + 2;
      }
    }
    complete = false;
    literal(start, source.length);
    return source.length;
  };

  let i = 0;
  if (source.startsWith('#!')) {
    i = lineEnd(source, 0);
    blank(0, i, true);
  }
  while (i < source.length) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (c === '/' && next === '/') {
      const end = lineEnd(source, i);
      blank(i, end, true);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) complete = false;
      const end = close === -1 ? source.length : close + 2;
      blank(i, end, true);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const close = closingQuote(source, i);
      if (close === -1) complete = false;
      const end = close === -1 ? lineEnd(source, i) : close;
      literal(i + 1, end);
      afterOperand(end);
      i = close === -1 ? end : close + 1;
      continue;
    }
    if (c === '`') {
      i = templateText(i + 1);
      continue;
    }
    if (c === '/' && regexAllowed(previous, word)) {
      const close = closingSlash(source, i);
      if (close !== -1) {
        blank(i + 1, close, false);
        let end = close + 1;
        while (/[a-z]/i.test(source.charAt(end))) end += 1;
        afterOperand(end - 1);
        i = end;
        continue;
      }
    }
    if (c === '}' && braces === 0 && outerBraces.length > 0) {
      braces = outerBraces.pop() ?? 0;
      i = templateText(i + 1);
      continue;
    }
    if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    if (!/\s/.test(c)) {
      const adjacent = previousAt === i - 1;
      word = IDENTIFIER.test(c) ? (adjacent && IDENTIFIER.test(previous) ? word + c : c) : '';
      // `value!` (TypeScript) and `count++` end an operand: a `/` after them divides.
      const ofOperand = /[\w$)\]]/;
      const postfix =
        (c === '!' && next !== '=' && adjacent && ofOperand.test(previous)) ||
        ((c === '+' || c === '-') &&
          previous === c &&
          adjacent &&
          ofOperand.test(source.charAt(i - 2)));
      previous = postfix ? ')' : c;
      previousAt = i;
    }
    i += 1;
  }
  if (outerBraces.length > 0) complete = false;
  return { code: code.join(''), masked: masked.join(''), literals, complete };
}

/** The source without its comments; string, template and regex literals are left as they are. */
export function stripComments(source: string): string {
  return scan(source).code;
}

// ─── Imports ────────────────────────────────────────────────────────────────

export interface ImportRef {
  kind: 'import' | 'export' | 'side-effect' | 'dynamic';
  /** The module specifier; null for a dynamic import whose argument is not one string literal. */
  specifier: string | null;
  /** What a static import or re-export names: `{ a, b }`, `* as x`, `*`, `x`; '' otherwise. */
  clause: string;
  /**
   * Erased when compiled, so never loaded at run time: `import type …`, `export type …`, or a
   * clause whose every name is marked `type` (`{ type A, type B }`).
   */
  typeOnly: boolean;
}

export interface Edge extends ImportRef {
  from: string;
  /** The imported file under src/, or null for packages and unresolvable specifiers. */
  target: string | null;
}

// Matched against the masked code, so text inside a literal never looks like an import.
const FROM_CLAUSE = /\b(import|export)(?:\s+|(?=[{*]))(type\s+)?([^'"`;]*?)\s*\bfrom\s*(?=['"`])/g;
const SIDE_EFFECT = /\bimport\s*(?=['"`])/g;
const CALL = /(?<![\w$.])(?:import|require)\s*\(/g;
const CALL_ENDS = /\s*[,)]/y;

/** The string literal at `at` (after white space) in `code`: its value and end, or null. */
function literalAt(code: string, at: number): { value: string; end: number } | null {
  let start = at;
  while (/\s/.test(code.charAt(start))) start += 1;
  const quote = code.charAt(start);
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  for (let k = start + 1; k < code.length; k += 1) {
    const c = code.charAt(k);
    if (c === '\\') k += 1;
    else if (c === quote) return { value: decodeEscapes(code.slice(start + 1, k)), end: k + 1 };
    else if (quote === '`' ? c === '$' && code.charAt(k + 1) === '{' : c === '\n') return null;
  }
  return null;
}

/** `{ type A, type B as C }`: a named clause whose every name is marked `type`. */
function namesOnlyTypes(clause: string): boolean {
  if (!clause.startsWith('{') || !clause.endsWith('}')) return false;
  const names = clause
    .slice(1, -1)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

/** Class member modifiers that may stand before a method's name. */
const MEMBER_PREFIX = /^[ \t]*(?:(?:public|private|protected|static|override|async)[ \t]+)*$/;

/** The index just past the parenthesis that closes the one at `open` (in masked code), or -1. */
function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k += 1) {
    const c = masked.charAt(k);
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/**
 * A class method named `require` or `import` (`require(minRole: Role): void {`) is a declaration,
 * not a call: it starts its line (after modifiers) and its parameter list is followed by a return
 * type or a body. A call is followed by anything else (`;`, `)`, `.`, an operator, a new line).
 */
function isMethodDeclaration(masked: string, at: number, open: number): boolean {
  const lineStart = masked.lastIndexOf('\n', at - 1) + 1;
  if (!MEMBER_PREFIX.test(masked.slice(lineStart, at))) return false;
  const close = closingParen(masked, open);
  return close !== -1 && /^\s*[:{]/.test(masked.slice(close));
}

export function importsIn({ code, masked }: Scan): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of masked.matchAll(FROM_CLAUSE)) {
    const literal = literalAt(code, match.index + match[0].length);
    if (literal === null) continue;
    const clause = (match[3] ?? '').trim();
    refs.push({
      kind: match[1] === 'export' ? 'export' : 'import',
      specifier: literal.value,
      clause,
      typeOnly: match[2] !== undefined || namesOnlyTypes(clause),
    });
  }
  for (const match of masked.matchAll(SIDE_EFFECT)) {
    const literal = literalAt(code, match.index + match[0].length);
    if (literal !== null) {
      refs.push({ kind: 'side-effect', specifier: literal.value, clause: '', typeOnly: false });
    }
  }
  for (const match of masked.matchAll(CALL)) {
    if (isMethodDeclaration(masked, match.index, match.index + match[0].length - 1)) continue;
    const literal = literalAt(code, match.index + match[0].length);
    CALL_ENDS.lastIndex = literal?.end ?? 0;
    const single = literal !== null && CALL_ENDS.test(code);
    refs.push({
      kind: 'dynamic',
      specifier: single ? literal.value : null,
      clause: '',
      typeOnly: false,
    });
  }
  return refs;
}

export function importsOf(source: string): ImportRef[] {
  return importsIn(scan(source));
}

/** `./x.js` from `a/b.ts` → `a/x.ts` (ESM TypeScript writes .js for .ts), or null. */
function resolveSpecifier(
  from: string,
  specifier: string,
  exists: (file: string) => boolean,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [joined.replace(/\.js$/, '.ts'), joined, `${joined}.ts`, `${joined}/index.ts`];
  return candidates.find(exists) ?? null;
}

export function edgesOf(
  from: string,
  refs: readonly ImportRef[],
  exists: (file: string) => boolean,
): Edge[] {
  return refs.map((ref) => ({
    ...ref,
    from,
    target: ref.specifier === null ? null : resolveSpecifier(from, ref.specifier, exists),
  }));
}

export function importGraph(files: ReadonlyMap<string, string>): Edge[] {
  const exists = (file: string): boolean => files.has(file);
  return [...files].flatMap(([from, source]) => edgesOf(from, importsOf(source), exists));
}

// ─── Reading the tree ───────────────────────────────────────────────────────

/** Code and literal text together, escapes decoded: what a name check reads. */
export function nameText(scanned: Scan): string {
  return [decodeEscapes(scanned.masked), ...scanned.literals].join('\n');
}

/** Every .ts file under src/, keyed by its path relative to src/ with forward slashes. */
export function sourceTree(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const relative = entry.split(path.sep).join('/');
    files.set(relative, readFileSync(path.join(SRC, entry), 'utf8'));
  }
  return files;
}
