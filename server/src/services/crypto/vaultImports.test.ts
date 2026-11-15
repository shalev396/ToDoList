/**
 * DATA.md §3.5 / DECISIONS D14, as a test over the import graph of server/src:
 * - the credential (classes/integration/Credential.ts: the one encrypt and the one decrypt path)
 *   is imported only by Integration.ts (and tests), whose read and write sessions are the only way
 *   to it; no file re-exports it; outside the allow-list, non-test code may not even name it;
 * - sync/secrets.ts, the sync's one door to a credential (through the integration's read
 *   session), is imported only by sync/runSync.ts (and tests), and only they name its exports;
 * - nothing under src/mcp/ names the credential or the Credential repository, anywhere in its
 *   source (an import clause alone misses namespace imports, destructured dynamic imports and
 *   re-exports);
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

import {
  edgesOf,
  importGraph,
  importsIn,
  importsOf,
  nameText,
  scan,
  sourceTree,
  stripComments,
} from '../../testing/importGraph.js';

/** The credential: the only code that seals or opens a provider secret. */
const VAULT = 'classes/integration/Credential.ts';
/** The integration base: its read and write sessions are the only way to a credential. */
const INTEGRATION = 'classes/integration/Integration.ts';
const INTEGRATIONS = 'classes/integration/index.ts';
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

/**
 * The modules that may use the credential (besides tests): the integration base, whose protected
 * read and write sessions hand the secret to provider subclasses for one call. The sync, "test
 * connection", the funnel, the creates and the Calendar push all go through those sessions.
 */
const VAULT_IMPORTERS = new Set([INTEGRATION]);

/** Besides tests, only these import services/crypto/envelope.ts (its `open` decrypts). */
const ENVELOPE_IMPORTERS = new Set([VAULT, KEY_PROVIDERS, STAGE_KEY_PROVIDER, JOIN_LINK_VAULT]);

/** Besides tests, only these name `findSealed` (the one read that returns the ciphertext). */
const FIND_SEALED_USERS = new Set([VAULT, ...CREDENTIAL_MODULES]);

/** Besides tests, only these name `stageKeyProvider` (the key that opens every credential). */
const STAGE_KEY_PROVIDER_USERS = new Set([VAULT, STAGE_KEY_PROVIDER, JOIN_LINK_VAULT]);

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

/** The credential's module, or its doors by name. */
const NAMES_VAULT = /integration\/Credential\b|\bCredential\.(?:of|seal|meta|destroy)\b/;

/** What MCP code may not name: matched against its whole source, comments left out. */
const MCP_FORBIDDEN =
  /integration\/Credential|credentialVault|credentialWriter|getCredentialRepository|CredentialRepository|CredentialMongoModel|models\/mongoose\/Credential|CREDENTIAL_TABLE_NAME/i;
/** The credential class by name (the word "credential" in a message is fine). */
const MCP_FORBIDDEN_NAME = /\bCredential\b/;
/** The Credential model or collection by name, e.g. mongoose.model('Credential'). */
const CREDENTIAL_MODEL_NAME = /^Credentials?$/;

// ─── The rules ──────────────────────────────────────────────────────────────

const isTest = (file: string): boolean => file.endsWith('.test.ts');

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
        report(`only ${[...VAULT_IMPORTERS].join(', ')} may import the credential`);
      }
      for (const edge of edges) {
        const vaultDoor =
          edge.target === VAULT ||
          edge.target === SECRETS ||
          NAMES_VAULT.test(edge.specifier ?? '');
        if (edge.kind === 'export' && vaultDoor) {
          report(`re-exports ${edge.specifier ?? ''}: the credential is never handed on`);
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
        MCP_FORBIDDEN_NAME.test(text) ||
        scanned.literals.some((value) => CREDENTIAL_MODEL_NAME.test(value)) ||
        edges.some(
          (edge) =>
            edge.target === VAULT ||
            (edge.target !== null && CREDENTIAL_MODULES.has(edge.target)) ||
            // `export *` of the models barrel hands on getCredentialRepository without naming it.
            (edge.kind === 'export' && edge.clause.startsWith('*') && edge.target === MODELS),
        );
      if (touchesCredentials) report('MCP code never touches credentials');
    }
  }
  return [...found].sort();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/** Stand-ins for the modules the synthetic trees point at, so their specifiers resolve. */
const STUBS: Record<string, string> = {
  [VAULT]: '',
  [INTEGRATIONS]: '',
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
        // An allow-listed file may import the credential, but never hand it on.
        'classes/integration/Integration.ts': `export * from './Credential.js';`,
        'sync/runSync.ts': `export { withProviderSecret } from './secrets.js';`,
        'routes/types.ts': `export type { SealInput } from '../classes/integration/Credential.js';`,
        'mcp/tools/barrel.ts': `export * from '../../models/index.js';`,
        'mcp/tools/index.ts': `export * from './fine.js';`,
        'mcp/tools/fine.ts': '',
        'routes/models.ts': `export * from '../models/index.js';`,
      }),
      [
        'classes/integration/Integration.ts',
        'mcp/tools/barrel.ts',
        'routes/types.ts',
        'sync/runSync.ts',
      ],
    );
  });

  it('a template literal specifier', () => {
    assert.deepEqual(
      flagged({
        'routes/private/leak.ts': `const vault = await import(${BACKTICK}../../classes/integration/Credential.js${BACKTICK});`,
        'mcp/tools/template.ts': `const model = await import(${BACKTICK}../../models/mongoose/Credential.js${BACKTICK});`,
      }),
      ['mcp/tools/template.ts', 'routes/private/leak.ts'],
    );
  });

  it('a comment marker inside a string', () => {
    assert.deepEqual(
      flagged({
        'routes/private/sneaky.ts': `const open = '/*';\nimport { Credential } from '../../classes/integration/Credential.js';\nconst close = '*/';`,
        'mcp/tools/sneaky.ts': `const open = "/*";\nimport { Credential } from '../../classes/integration/Credential.js';\nconst close = "*/";`,
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
        'sync/secrets.ts': `const CLASSES = '../classes/integration/index.js';\nexport const load = () => import(CLASSES);`,
        'services/plugins.ts': `export const load = (name: string) => import(${BACKTICK}./plugins/\${name}.js${BACKTICK});`,
        'services/concat.ts': `export const load = (b: string) => import('./a' + b);`,
        'services/required.ts': `export const load = (name: string) => require(name);`,
        'services/literal.ts': `await import('./a.js'); await import("./b.js"); await import(${BACKTICK}./c.js${BACKTICK});\nawait import('./d.json', { with: { type: 'json' } });\nconst text = 'import(notCode)';`,
        'sync/registry.test.ts': `export const load = (name: string) => import(name);`,
      }),
      ['services/concat.ts', 'services/plugins.ts', 'services/required.ts', 'sync/secrets.ts'],
    );
  });

  it('a dynamic import that starts a line is still seen: a ternary, a computed name, a block after it', () => {
    assert.deepEqual(
      importsOf(`const m = flag ?\n  import('../models/mongoose/Item.js') : undefined;`).map(
        (ref) => [ref.kind, ref.specifier],
      ),
      [['dynamic', '../models/mongoose/Item.js']],
    );
    assert.deepEqual(
      flagged({
        'services/ternary.ts': `export const load = (flag: boolean) =>\n  flag ?\n    import('./crypto/envelope.js') : undefined;`,
        'services/computed.ts': `export const load = (flag: boolean, name: string) =>\n  flag ?\n    import(name) : undefined;`,
        'services/block.ts': `export async function load(): Promise<void> {\n  import('./crypto/envelope.js')\n  {\n  }\n}`,
        'services/method.ts': `export class Caller {\n  require(minRole: string, message?: string): void {\n    void [minRole, message];\n  }\n}`,
      }),
      ['services/block.ts', 'services/computed.ts', 'services/ternary.ts'],
    );
  });

  it('naming the vault outside the allow-list counts as importing it', () => {
    assert.deepEqual(
      flagged({
        'services/loader.ts': `const VAULT = '../classes/integration/Credential.js';`,
        'services/escaped.ts': String.raw`const VAULT = '../classes/integration/\u0043redential.js';`,
        'services/caller.ts': `export const open = (id: string) => Credential.of(id);`,
        'services/comment.ts': `// classes/integration/Credential.ts is not imported here\nexport const x = 1;`,
      }),
      ['services/caller.ts', 'services/escaped.ts', 'services/loader.ts'],
    );
  });

  it('the envelope, findSealed and stageKeyProvider have their own allow-lists', () => {
    assert.deepEqual(
      flagged({
        'classes/integration/Credential.ts': `import { open } from '../../services/crypto/envelope.js';
import { stageKeyProvider } from '../../services/crypto/stageKeyProvider.js';
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
        'classes/integration/Integration.ts': `import { Credential } from './Credential.js';`,
        'sync/secrets.ts': `const { Integration } = await import('../classes/integration/index.js');`,
        'sync/worker.test.ts': `import { Credential } from '../classes/integration/Credential.js';`,
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
    assert.ok(files.has(VAULT) && files.has(INTEGRATION) && files.has(SECRETS));
    assert.ok(has('classes/integration/Credential.test.ts', VAULT));
    assert.ok(has(VAULT, ENVELOPE));
    assert.ok(has(INTEGRATION, VAULT));
    assert.ok(has('app.ts', 'routes/index.ts'));
    assert.ok(has(RUN_SYNC, SECRETS));
    // A literal specifier: esbuild bundles the integration classes into the Lambda layer.
    assert.ok(has(SECRETS, INTEGRATIONS));
  });

  it('scans every file to its end without losing track of a string, template or comment', () => {
    const lost = [...files].filter(([, source]) => !scan(source).complete).map(([file]) => file);
    assert.deepEqual(lost, []);
  });

  it('breaks none of the rules', () => {
    assert.deepEqual(violations(files), []);
  });
});
