/**
 * The Media class keeps an uploaded file's object and row together, so its row writes are private;
 * what deletes files without a workspace Caller (`Media.remove`, `Media.removeAllOf`) is an
 * account operation of the signed-in user, named only by the account controller (phase 7c, final
 * review m5). `Media.upload` makes a file for its uploader, there too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nameText, scan, sourceTree } from '../testing/importGraph.js';
import { Entity } from './base/Entity.js';
import { Media } from './Media.js';
import { User } from './User.js';

const MEDIA = 'classes/Media.ts';
const ACCOUNT = 'controllers/account.ts';

const FILE_DOORS = /\bMedia\.(?:remove|removeAllOf|upload)\b/;
const MEDIA_ROWS = /\bgetMediaRepository\b/;

const DOORS: readonly { pattern: RegExp; allowed: ReadonlySet<string> }[] = [
  { pattern: FILE_DOORS, allowed: new Set([MEDIA, ACCOUNT]) },
  // Nothing reaches the rows apart from their objects (models/** is exempt).
  { pattern: MEDIA_ROWS, allowed: new Set([MEDIA]) },
];

const isTest = (file: string): boolean =>
  file.endsWith('.test.ts') || file.startsWith('testing/') || file.includes('/__tests__/');

function strays(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file) || file.startsWith('models/')) continue;
    const text = nameText(scan(source));
    for (const { pattern, allowed } of DOORS) {
      if (!allowed.has(file) && pattern.test(text)) found.push(`${file}: ${pattern.source}`);
    }
  }
  return found.sort();
}

describe('Media and User on the base layer', () => {
  it('both are Entities: known by id, equal by class and id, no public constructor', () => {
    assert.ok(Object.getPrototypeOf(Media) === Entity);
    assert.ok(Object.getPrototypeOf(User) === Entity);
    // A row's own statics, and the doors above, are the only ways to one.
    assert.equal(Object.hasOwn(Media, 'create'), false);
    assert.equal(Object.hasOwn(Media, 'deleteById'), false);
    assert.equal(Object.hasOwn(Media, 'deleteByUploadedBy'), false);
  });

  it('the file doors are named only by the account controller', () => {
    const files = sourceTree();
    assert.ok(FILE_DOORS.test(nameText(scan(files.get(ACCOUNT) ?? ''))), 'account uses them');
    assert.deepEqual(strays(files), []);
  });

  it('catches a stray caller', () => {
    const tree = new Map(sourceTree());
    tree.set('services/sweep.ts', `export const go = (id: string) => Media.remove(id);`);
    tree.set('services/peek.ts', `import { getMediaRepository } from '../models/index.js';`);
    assert.deepEqual(strays(tree), [
      `services/peek.ts: ${MEDIA_ROWS.source}`,
      `services/sweep.ts: ${FILE_DOORS.source}`,
    ]);
  });
});
