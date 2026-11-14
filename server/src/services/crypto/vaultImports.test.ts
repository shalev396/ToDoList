/**
 * DATA.md §3.5 / DECISIONS D14, as a test over the import graph of server/src:
 * - only the allow-listed modules (and tests) import the credential vault, and no file re-exports
 *   it; outside the allow-list, non-test code may not even name it;
 * - sync/secrets.ts, the sync's one door to the vault, is imported only by sync/runSync.ts (and
 *   tests), and only they name its exports;
 * - nothing under src/mcp/ names the vault, the credential writer or the Credential repository,
 *   anywhere in its source (an import clause alone misses namespace imports, destructured dynamic
 *   imports and re-exports);
 * - every dynamic import in non-test code takes one string literal, so this graph sees every edge
 *   and esbuild bundles every module (a variable specifier is resolved at run time, next to the
 *   Lambda bundle, where the file does not exist).
 *
 * The scanner is string-, template- and regex-aware: a comment marker inside a literal is text,
 * and code that only looks like code (inside a literal) doesn't count. Specifiers may use single
 * quotes, double quotes or backticks, and their escapes are decoded. Allow-listed files that don't
 * exist yet are simply absent from the graph.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

const VAULT = 'services/crypto/credentialVault.ts';
const WRITER = 'services/crypto/credentialWriter.ts';
const SECRETS = 'sync/secrets.ts';
const RUN_SYNC = 'sync/runSync.ts';
const MODELS = 'models/index.ts';
const ENVELOPE = 'services/crypto/envelope.ts';
const KEY_PROVIDERS = 'services/crypto/keyProviders.ts';
const STAGE_KEY_PROVIDER = 'services/crypto/stageKeyProvider.ts';
/** Seals a workspace's join-link token with the stage key (A2); it never touches credentials. */
const JOIN_LINK_VAULT = 'services/crypto/joinLinkVault.ts';
const CREDENTIAL_MODULES = new Set([
  'models/mongoose/Credential.ts',
  'models/definitions/Credential.ts',
]);

/** The modules that may decrypt (besides tests): sync, "test connection", the Calendar push. */
const VAULT_IMPORTERS = new Set([
  SECRETS, // withProviderSecret: the sync's only way to a secret
  'sync/worker.ts',
  RUN_SYNC,
  'services/integrationTest.ts', // "test connection" for the integrations routes (to come)
  'gcal/oauthCalendar.ts', // Google Calendar OAuth: calendar picker, Calendar API push, revoke
  'services/oauth/grants.ts', // GitHub/Jira/ClickUp/Linear OAuth: the grant's resources, revoke
  'services/providerCreate/session.ts', // H5: the funnel's reads and the one create, per user action
]);

/** Besides tests, only these import services/crypto/envelope.ts (its `open` decrypts). */
const ENVELOPE_IMPORTERS = new Set([
  VAULT,
  WRITER,
  KEY_PROVIDERS,
  STAGE_KEY_PROVIDER,
  JOIN_LINK_VAULT,
]);

/** Besides tests, only these name `findSealed` (the one read that returns the ciphertext). */
const FIND_SEALED_USERS = new Set([VAULT, ...CREDENTIAL_MODULES]);

/** Besides tests, only these name `stageKeyProvider` (the key that opens every credential). */
const STAGE_KEY_PROVIDER_USERS = new Set([VAULT, WRITER, STAGE_KEY_PROVIDER, JOIN_LINK_VAULT]);

/** secrets.ts hands out decrypted secrets: besides tests, only runSync.ts imports it. */
const SECRETS_IMPORTERS = new Set([RUN_SYNC]);

/** secrets.ts's exports, and the files (besides tests) whose code may name them. */
const SECRETS_EXPORTS: readonly { name: string; pattern: RegExp; allowed: ReadonlySet<string> }[] =
  [
    {
      name: 'withProviderSecret',
      pattern: /\bwithProviderSecret\b/,
      allowed: new Set([SECRETS, RUN_SYNC]),
    },
    {
      name: 'setVaultLoaderForTests',
      pattern: /\bsetVaultLoaderForTests\b/,
      allowed: new Set([SECRETS]),
    },
  ];

const NAMES_VAULT = /credentialVault/i;

/** What MCP code may not name: matched against its whole source, comments left out. */
const MCP_FORBIDDEN =
  /credentialVault|credentialWriter|getCredentialRepository|CredentialRepository|CredentialMongoModel|models\/mongoose\/Credential|CREDENTIAL_TABLE_NAME/i;
/** The Credential model or collection by name, e.g. mongoose.model('Credential'). */
const CREDENTIAL_MODEL_NAME = /^Credentials?$/;

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
function decodeEscapes(raw: string): string {
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
}

interface Edge extends ImportRef {
  from: string;
  /** The imported file under src/, or null for packages and unresolvable specifiers. */
  target: string | null;
}

// Matched against the masked code, so text inside a literal never looks like an import.
const FROM_CLAUSE =
  /\b(import|export)(?:\s+|(?=[{*]))(?:type\s+)?([^'"`;]*?)\s*\bfrom\s*(?=['"`])/g;
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

function importsIn({ code, masked }: Scan): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of masked.matchAll(FROM_CLAUSE)) {
    const literal = literalAt(code, match.index + match[0].length);
    if (literal === null) continue;
    refs.push({
      kind: match[1] === 'export' ? 'export' : 'import',
      specifier: literal.value,
      clause: (match[2] ?? '').trim(),
    });
  }
  for (const match of masked.matchAll(SIDE_EFFECT)) {
    const literal = literalAt(code, match.index + match[0].length);
    if (literal !== null) refs.push({ kind: 'side-effect', specifier: literal.value, clause: '' });
  }
  for (const match of masked.matchAll(CALL)) {
    const literal = literalAt(code, match.index + match[0].length);
    CALL_ENDS.lastIndex = literal?.end ?? 0;
    const single = literal !== null && CALL_ENDS.test(code);
    refs.push({ kind: 'dynamic', specifier: single ? literal.value : null, clause: '' });
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

function edgesOf(
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

// ─── The rules ──────────────────────────────────────────────────────────────

const isTest = (file: string): boolean => file.endsWith('.test.ts');

/** Code and literal text together, escapes decoded: what a name check reads. */
function nameText(scanned: Scan): string {
  return [decodeEscapes(scanned.masked), ...scanned.literals].join('\n');
}

/** Every broken rule, as `<file>: <why>`. */
export function violations(files: ReadonlyMap<string, string>): string[] {
  const exists = (file: string): boolean => files.has(file);
  const found = new Set<string>();
  for (const [file, source] of files) {
    const scanned = scan(source);
    const edges = edgesOf(file, importsIn(scanned), exists);
    const text = nameText(scanned);
    const report = (why: string): void => {
      found.add(`${file}: ${why}`);
    };

    if (!isTest(file)) {
      if (edges.some((edge) => edge.kind === 'dynamic' && edge.specifier === null)) {
        report(
          'a dynamic import without one string literal: neither this graph nor esbuild sees it',
        );
      }
      const reachesVault = edges.some((edge) => edge.target === VAULT) || NAMES_VAULT.test(text);
      if (file !== VAULT && !VAULT_IMPORTERS.has(file) && reachesVault) {
        report(`only ${[...VAULT_IMPORTERS].join(', ')} may import the vault`);
      }
      for (const edge of edges) {
        const vaultDoor =
          edge.target === VAULT ||
          edge.target === SECRETS ||
          NAMES_VAULT.test(edge.specifier ?? '');
        if (edge.kind === 'export' && vaultDoor) {
          report(`re-exports ${edge.specifier ?? ''}: the vault is never handed on`);
        }
        if (edge.target === SECRETS && file !== SECRETS && !SECRETS_IMPORTERS.has(file)) {
          report(`only ${[...SECRETS_IMPORTERS].join(', ')} may import ${SECRETS}`);
        }
      }
      if (file !== ENVELOPE && !ENVELOPE_IMPORTERS.has(file)) {
        if (edges.some((edge) => edge.target === ENVELOPE)) {
          report(`only ${[...ENVELOPE_IMPORTERS].join(', ')} may import ${ENVELOPE}`);
        }
      }
      if (!FIND_SEALED_USERS.has(file) && /\bfindSealed\b/.test(text)) {
        report(`names findSealed, which only ${[...FIND_SEALED_USERS].join(', ')} may use`);
      }
      if (!STAGE_KEY_PROVIDER_USERS.has(file) && /\bstageKeyProvider\b/.test(text)) {
        report(
          `names stageKeyProvider, which only ${[...STAGE_KEY_PROVIDER_USERS].join(', ')} may use`,
        );
      }
      for (const { name, pattern, allowed } of SECRETS_EXPORTS) {
        if (!allowed.has(file) && pattern.test(text)) {
          report(`names ${name}, which only ${[...allowed].join(', ')} may use`);
        }
      }
    }

    if (file.startsWith('mcp/')) {
      const touchesCredentials =
        MCP_FORBIDDEN.test(text) ||
        scanned.literals.some((value) => CREDENTIAL_MODEL_NAME.test(value)) ||
        edges.some(
          (edge) =>
            edge.target === VAULT ||
            edge.target === WRITER ||
            (edge.target !== null && CREDENTIAL_MODULES.has(edge.target)) ||
            // `export *` of the models barrel hands on getCredentialRepository without naming it.
            (edge.kind === 'export' && edge.clause.startsWith('*') && edge.target === MODELS),
        );
      if (touchesCredentials) report('MCP code never touches credentials');
    }
  }
  return [...found].sort();
}

/** Every .ts file under src/, keyed by its path relative to src/ with forward slashes. */
function sourceTree(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const relative = entry.split(path.sep).join('/');
    files.set(relative, readFileSync(path.join(SRC, entry), 'utf8'));
  }
  return files;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/** Stand-ins for the modules the synthetic trees point at, so their specifiers resolve. */
const STUBS: Record<string, string> = {
  [VAULT]: '',
  [WRITER]: '',
  [SECRETS]: '',
  [RUN_SYNC]: '',
  [MODELS]: '',
  [ENVELOPE]: '',
  [STAGE_KEY_PROVIDER]: '',
  'models/mongoose/Credential.ts': '',
  'models/definitions/Credential.ts': '',
};

/** The files of a synthetic tree (on top of STUBS) that break a rule. */
function flagged(files: Record<string, string>): string[] {
  const tree = new Map(Object.entries({ ...STUBS, ...files }));
  return [...new Set(violations(tree).map((found) => found.slice(0, found.indexOf(':'))))].sort();
}

const BACKTICK = '`';

describe('the comment stripper (string, template and regex aware)', () => {
  it('keeps the code between comment markers that sit inside string literals', () => {
    const code = stripComments(
      [
        `const open = '/*';`,
        `import { decryptForSync } from '../services/crypto/credentialVault.js';`,
        `const close = "*/";`,
        `const tpl = ${BACKTICK}/* still template text */${BACKTICK};`,
        `const url = 'https://example.invalid//path'; // a real comment`,
      ].join('\n'),
    );
    assert.ok(
      code.includes(`import { decryptForSync } from '../services/crypto/credentialVault.js';`),
    );
    assert.ok(code.includes(`${BACKTICK}/* still template text */${BACKTICK}`));
    assert.ok(code.includes(`'https://example.invalid//path';`));
    assert.ok(!code.includes('a real comment'));
  });

  it('drops real comments, inside template expressions too, and keeps offsets', () => {
    const source = `const a = ${BACKTICK}x \${ /* gone */ b } y${BACKTICK}; /* gone too */ const c = 1; // gone`;
    const code = stripComments(source);
    assert.equal(code.length, source.length);
    assert.ok(!code.includes('gone'));
    assert.ok(code.includes('const c = 1;'));
    assert.ok(code.includes(`${BACKTICK}x \${`) && code.includes(`b } y${BACKTICK}`));
  });

  it('is not fooled by quotes, backticks or comment markers inside regex literals', () => {
    const source = [
      `const quotes = /['"${BACKTICK}]/g;`,
      String.raw`const markers = /\/\*|\/\//;`,
      `const half = total / 2; const nonNull = value! / 2; const after = (a) / b;`,
      `import { kept } from './kept.js';`,
    ].join('\n');
    const scanned = scan(source);
    assert.ok(scanned.complete);
    assert.ok(scanned.code.includes(`import { kept } from './kept.js';`));
    assert.deepEqual(
      importsOf(source).map((ref) => ref.specifier),
      ['./kept.js'],
    );
  });

  it('notices when it loses track (an unterminated string, template or comment)', () => {
    for (const broken of [
      `const s = 'never closed;\nimport x from './x.js';`,
      `const t = ${BACKTICK}never closed;`,
      `/* never closed`,
      `const t = ${BACKTICK}\${ open`,
    ]) {
      assert.equal(scan(broken).complete, false, broken);
    }
  });
});

describe('the import scanner', () => {
  it('finds static, type-only, re-exported, multi-line, side-effect and dynamic imports, in any quotes', () => {
    const refs = importsOf(`
      import { decryptForSync } from '../services/crypto/credentialVault.js';
      import type * as Vault from "./credentialVault.js";
      export { storeCredential } from './credentialWriter.js';
      export * from './everything.js';
      import {
        getItemRepository,
        getCredentialRepository,
      } from '../../models/index.js';
      import './side-effect.js';
      const later = await import('./lazy.js');
      const viaDouble = await import("./double.js");
      const viaBacktick = await import(${BACKTICK}./backtick.js${BACKTICK});
      const json = await import('./data.json', { with: { type: 'json' } });
      const split = await import(
        './split.js'
      );
      // import { nope } from './commented-out.js';
      /* import { nope } from './block-commented.js'; */
      const text = "import { nope } from './in-a-string.js'; import('./in-a-string-too.js')";
      tool.import('./a-method-call.js');
      const url = 'https://example.invalid/path'; import fs from 'node:fs';
    `);
    assert.deepEqual(
      refs.map((ref) => [ref.kind, ref.specifier]),
      [
        ['import', '../services/crypto/credentialVault.js'],
        ['import', './credentialVault.js'],
        ['export', './credentialWriter.js'],
        ['export', './everything.js'],
        ['import', '../../models/index.js'],
        ['import', 'node:fs'],
        ['side-effect', './side-effect.js'],
        ['dynamic', './lazy.js'],
        ['dynamic', './double.js'],
        ['dynamic', './backtick.js'],
        ['dynamic', './data.json'],
        ['dynamic', './split.js'],
      ],
    );
    assert.equal(refs[3]?.clause, '*');
    assert.match(refs[4]?.clause ?? '', /getCredentialRepository/);
  });

  it('marks a dynamic import whose argument is not a single string literal (specifier null)', () => {
    for (const call of [
      'import(name)',
      `import('./a' + b)`,
      `import('./a.js' + '')`,
      `import(${BACKTICK}./plugins/\${name}.js${BACKTICK})`,
      'import(pick())',
      'import()',
      'require(name)',
    ]) {
      assert.deepEqual(
        importsOf(`const m = await ${call};`).map((ref) => [ref.kind, ref.specifier]),
        [['dynamic', null]],
        call,
      );
    }
  });

  it('decodes escapes in specifiers', () => {
    assert.deepEqual(
      importsOf(String.raw`const v = await import('./credential\u0056ault.js');`).map(
        (ref) => ref.specifier,
      ),
      ['./credentialVault.js'],
    );
  });
});

describe('the import rules, on synthetic trees (one per known bypass)', () => {
  it('a namespace import: MCP code may not name credential access anywhere in its source', () => {
    assert.deepEqual(
      flagged({
        'mcp/tools/namespace.ts': `import * as models from '../../models/index.js';\nexport const leak = async () => (await models.getCredentialRepository()).findMeta('w', 'i');`,
        'mcp/tools/fine.ts': `import * as models from '../../models/index.js';\nexport const items = () => models.getItemRepository();`,
      }),
      ['mcp/tools/namespace.ts'],
    );
  });

  it('a destructured dynamic import', () => {
    assert.deepEqual(
      flagged({
        'mcp/tools/dynamic.ts': `export async function leak() {\n  const { getCredentialRepository } = await import('../../models/index.js');\n  return getCredentialRepository();\n}`,
      }),
      ['mcp/tools/dynamic.ts'],
    );
  });

  it('export *: nothing re-exports the vault or secrets.ts, and MCP code never re-exports the models barrel', () => {
    assert.deepEqual(
      flagged({
        // Allow-listed files may import the vault, but never hand it on.
        'sync/worker.ts': `export * from '../services/crypto/credentialVault.js';`,
        'sync/runSync.ts': `export { withProviderSecret } from './secrets.js';`,
        'routes/types.ts': `export type { HmacKeyring } from '../services/crypto/credentialVault.js';`,
        'mcp/tools/barrel.ts': `export * from '../../models/index.js';`,
        'mcp/tools/index.ts': `export * from './fine.js';`,
        'mcp/tools/fine.ts': '',
        'routes/models.ts': `export * from '../models/index.js';`,
      }),
      ['mcp/tools/barrel.ts', 'routes/types.ts', 'sync/runSync.ts', 'sync/worker.ts'],
    );
  });

  it('a template literal specifier', () => {
    assert.deepEqual(
      flagged({
        'routes/private/leak.ts': `const vault = await import(${BACKTICK}../../services/crypto/credentialVault.js${BACKTICK});`,
        'mcp/tools/template.ts': `const model = await import(${BACKTICK}../../models/mongoose/Credential.js${BACKTICK});`,
      }),
      ['mcp/tools/template.ts', 'routes/private/leak.ts'],
    );
  });

  it('a comment marker inside a string', () => {
    assert.deepEqual(
      flagged({
        'routes/private/sneaky.ts': `const open = '/*';\nimport { decryptForSync } from '../../services/crypto/credentialVault.js';\nconst close = '*/';`,
        'mcp/tools/sneaky.ts': `const open = "/*";\nimport { storeCredential } from '../../services/crypto/credentialWriter.js';\nconst close = "*/";`,
      }),
      ['mcp/tools/sneaky.ts', 'routes/private/sneaky.ts'],
    );
  });

  it('secrets.ts: only runSync.ts (and tests) import it or name its exports', () => {
    assert.deepEqual(
      flagged({
        'sync/runSync.ts': `import { withProviderSecret } from './secrets.js';`,
        'sync/secrets.test.ts': `import { setVaultLoaderForTests, withProviderSecret } from './secrets.js';`,
        'sync/worker.test.ts': `import { setVaultLoaderForTests } from './secrets.js';`,
        'sync/worker.ts': `import { withProviderSecret } from './secrets.js';`,
        'jobs/relay.ts': `import { withProviderSecret } from '../sync/runSync.js';`,
        'devtools/stub.ts': `const { setVaultLoaderForTests } = await import('../sync/secrets.js');`,
      }),
      ['devtools/stub.ts', 'jobs/relay.ts', 'sync/worker.ts'],
    );
  });

  it('a dynamic import takes one string literal in every non-test file, allow-listed or not', () => {
    assert.deepEqual(
      flagged({
        // The old secrets.ts pattern: invisible to the graph, and left unbundled by esbuild.
        'sync/secrets.ts': `const VAULT_MODULE = '../services/crypto/credentialVault.js';\nexport const load = () => import(VAULT_MODULE);`,
        'services/plugins.ts': `export const load = (name: string) => import(${BACKTICK}./plugins/\${name}.js${BACKTICK});`,
        'services/concat.ts': `export const load = (b: string) => import('./a' + b);`,
        'services/required.ts': `export const load = (name: string) => require(name);`,
        'services/literal.ts': `await import('./a.js'); await import("./b.js"); await import(${BACKTICK}./c.js${BACKTICK});\nawait import('./d.json', { with: { type: 'json' } });\nconst text = 'import(notCode)';`,
        'sync/registry.test.ts': `export const load = (name: string) => import(name);`,
      }),
      ['services/concat.ts', 'services/plugins.ts', 'services/required.ts', 'sync/secrets.ts'],
    );
  });

  it('naming the vault outside the allow-list counts as importing it', () => {
    assert.deepEqual(
      flagged({
        'services/loader.ts': `const VAULT = '../services/crypto/credentialVault.js';`,
        'services/escaped.ts': String.raw`const VAULT = './credential\u0056ault.js';`,
        'services/comment.ts': `// credentialVault.ts is not imported here\nexport const x = 1;`,
      }),
      ['services/escaped.ts', 'services/loader.ts'],
    );
  });

  it('the envelope, findSealed and stageKeyProvider have their own allow-lists', () => {
    assert.deepEqual(
      flagged({
        'services/crypto/credentialVault.ts': `import { open } from './envelope.js';
import { stageKeyProvider } from './stageKeyProvider.js';
repo.findSealed();`,
        'services/crypto/keyProviders.ts': `import { aadFor } from './envelope.js';`,
        'services/crypto/envelope.test.ts': `import { open } from './envelope.js';
stageKeyProvider();`,
        'services/opener.ts': `import { open } from './crypto/envelope.js';`,
        'services/dyn.ts': `const { open } = await import('./crypto/envelope.js');`,
        'services/sealed.ts': `export const read = (r: Repo) => r.findSealed('w', 'i');`,
        'services/key.ts': `import { stageKeyProvider } from './crypto/stageKeyProvider.js';`,
        'services/ok.ts': `// findSealed and stageKeyProvider are only named in this comment
export const x = 1;`,
      }),
      ['services/dyn.ts', 'services/key.ts', 'services/opener.ts', 'services/sealed.ts'],
    );
  });

  it('allows what the rules allow', () => {
    assert.deepEqual(
      flagged({
        'sync/worker.ts': `import { decryptForSync } from '../services/crypto/credentialVault.js';`,
        'sync/secrets.ts': `const vault = await import('../services/crypto/credentialVault.js');`,
        'sync/worker.test.ts': `import { decryptForSync } from '../services/crypto/credentialVault.js';`,
        'mcp/tools/items.ts': `import { getItemRepository } from '../../models/index.js';`,
        'services/workspaces.ts': `import { getCredentialRepository } from '../models/index.js';`,
      }),
      [],
    );
  });
});

describe('server/src import graph', () => {
  const files = sourceTree();
  const edges = importGraph(files);
  const has = (from: string, target: string): boolean =>
    edges.some((edge) => edge.from === from && edge.target === target);

  it('sees the real tree (the scan is not vacuous)', () => {
    assert.ok(files.has(VAULT) && files.has(WRITER) && files.has(SECRETS));
    assert.ok(has('services/crypto/credentialVault.test.ts', VAULT));
    assert.ok(has(WRITER, 'services/crypto/envelope.ts'));
    assert.ok(has('app.ts', 'routes/index.ts'));
    assert.ok(has(RUN_SYNC, SECRETS));
    // A literal specifier: esbuild bundles the vault into the Lambda layer.
    assert.ok(has(SECRETS, VAULT));
  });

  it('scans every file to its end without losing track of a string, template or comment', () => {
    const lost = [...files].filter(([, source]) => !scan(source).complete).map(([file]) => file);
    assert.deepEqual(lost, []);
  });

  it('breaks none of the rules', () => {
    assert.deepEqual(violations(files), []);
  });
});
