/**
 * `stageObjectStore()` and `stageMailer()` hand out the stage's bucket and mailer whole (list,
 * deleteMany, any send). Everything else reaches them through the functions in the same modules
 * (`uploadFile`, `deleteFile`, `clearUserUploadedAssets`, `sendEmail`…), which carry the prefix and
 * the address rules, so the two names are pinned to their own modules (phase 7c fix round, review
 * m6). Tests and src/testing build their own stores and are exempt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nameText, scan, sourceTree } from '../testing/importGraph.js';

const DOORS: readonly { pattern: RegExp; module: string }[] = [
  { pattern: /\bstageObjectStore\b/, module: 'utils/s3Util.ts' },
  { pattern: /\bstageMailer\b/, module: 'utils/sesUtil.ts' },
];

const isTest = (file: string): boolean =>
  file.endsWith('.test.ts') || file.startsWith('testing/') || file.includes('/__tests__/');

function strays(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file)) continue;
    const text = nameText(scan(source));
    for (const { pattern, module } of DOORS) {
      if (file !== module && pattern.test(text)) found.push(`${file}: ${pattern.source}`);
    }
  }
  return found.sort();
}

describe('stageObjectStore and stageMailer are pinned to their own modules', () => {
  const files = sourceTree();

  it('sees the real tree: each module names its own door', () => {
    for (const { pattern, module } of DOORS) {
      assert.ok(pattern.test(nameText(scan(files.get(module) ?? ''))), `${module} lost its door`);
    }
  });

  it('no other production module names either', () => {
    assert.deepEqual(strays(files), []);
  });

  it('catches a stray, an alias and a dynamic import; not a comment or a test', () => {
    const tree = new Map(files);
    tree.set(
      'services/sweep.ts',
      `import { stageObjectStore } from '../utils/s3Util.js';\nawait stageObjectStore().list('');`,
    );
    tree.set(
      'services/alias.ts',
      `import { stageMailer as mail } from '../utils/sesUtil.js';\nexport { mail };`,
    );
    tree.set(
      'services/lazy.ts',
      `const { stageObjectStore } = await import('../utils/s3Util.js');\nstageObjectStore();`,
    );
    tree.set('services/note.ts', `// stageMailer() is not called here\nexport const x = 1;`);
    tree.set('services/fixture.test.ts', `stageMailer();`);
    assert.deepEqual(strays(tree), [
      `services/alias.ts: ${DOORS[1]?.pattern.source ?? ''}`,
      `services/lazy.ts: ${DOORS[0]?.pattern.source ?? ''}`,
      `services/sweep.ts: ${DOORS[0]?.pattern.source ?? ''}`,
    ]);
  });
});
