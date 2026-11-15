/**
 * The adapters never reach a provider secret: their context has no `secret` (sync/types.ts), and
 * their request headers come from the integration's auth strategy (`ctx.auth`). Nothing under
 * sync/providers/ (tests aside) names a `.secret` member or indexes a `secret[…]`, or loads the
 * credential, the sync's secret door or the vault's envelope.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { importsIn, scan, sourceTree } from '../../testing/importGraph.js';

const ADAPTERS = 'sync/providers/';
/** Naming the secret, as code (comments and string literals are masked out first). */
const NAMES_SECRET = [/\.secret\b/, /\bsecret\s*\[/, /\bsecret\s*:/];
/** The modules that hold or open a credential. */
const CREDENTIAL_MODULES = /(?:^|\/)(?:Credential|secrets|envelope|credentialVault)\.js$/;

const isTest = (file: string): boolean => file.endsWith('.test.ts');

function violations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    if (!file.startsWith(ADAPTERS) || isTest(file)) continue;
    const scanned = scan(source);
    if (NAMES_SECRET.some((pattern) => pattern.test(scanned.masked))) {
      found.push(`${file}: names the secret (use ctx.auth)`);
    }
    for (const ref of importsIn(scanned)) {
      if (ref.specifier !== null && CREDENTIAL_MODULES.test(ref.specifier)) {
        found.push(`${file}: loads ${ref.specifier}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

describe('the adapters never reach the secret', () => {
  it('flags an adapter that reads the secret or loads the credential', () => {
    assert.deepEqual(
      violations(
        new Map([
          [`${ADAPTERS}a.ts`, `const t = ctx.secret['token'];`],
          [`${ADAPTERS}b.ts`, `const { secret } = ctx; const t = secret['token'];`],
          [
            `${ADAPTERS}c.ts`,
            `import { Credential } from '../../classes/integration/Credential.js';`,
          ],
          [`${ADAPTERS}d.ts`, `import { withProviderSecret } from '../secrets.js';`],
          [`${ADAPTERS}e.ts`, `// ctx.secret is gone\nconst label = 'secret[0]';`],
          [`${ADAPTERS}f.test.ts`, `const t = ctx.secret['token'];`],
          [`${ADAPTERS}g.ts`, `const h = await ctx.auth.headers();`],
        ]),
      ),
      [
        `${ADAPTERS}a.ts: names the secret (use ctx.auth)`,
        `${ADAPTERS}b.ts: names the secret (use ctx.auth)`,
        `${ADAPTERS}c.ts: loads ../../classes/integration/Credential.js`,
        `${ADAPTERS}d.ts: loads ../secrets.js`,
      ],
    );
  });

  it('holds for the real adapters', () => {
    const files = sourceTree();
    assert.ok([...files.keys()].filter((file) => file.startsWith(ADAPTERS)).length >= 10);
    assert.deepEqual(violations(files), []);
  });
});
