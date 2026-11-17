/**
 * The provider definitions touch neither the database nor the stage's configuration: code that
 * must not load the integration classes (the sync engine in fixtures mode, the request schemas,
 * the seed) reads them, and so does a test before its database starts. Nothing under
 * classes/integration/definitions/ may reach, at run time, the models' barrel, a model, the
 * connection or `config/environment.ts`, directly or through what it imports. (The plain types
 * and constants under models/definitions/ are fine: they load nothing.) Type-only imports are
 * erased, so they don't count.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { importGraph, sourceTree } from '../../../testing/importGraph.js';

const DEFINITIONS = 'classes/integration/definitions/';

/** What loads the database or the stage's configuration. */
const FORBIDDEN: readonly RegExp[] = [
  /^models\/index\.ts$/,
  /^models\/(mongoose|sequelize)\//,
  /^config\/(environment|database)\.ts$/,
  /^config\/providers\//,
];

const isTest = (file: string): boolean => file.endsWith('.test.ts') || file.includes('__tests__/');

/** For each definitions module that reaches a forbidden one: the import chain to it. */
function violations(files: ReadonlyMap<string, string>): string[] {
  const runtime = new Map<string, string[]>();
  for (const edge of importGraph(files)) {
    if (edge.typeOnly || edge.target === null) continue;
    runtime.set(edge.from, [...(runtime.get(edge.from) ?? []), edge.target]);
  }
  const found: string[] = [];
  for (const start of files.keys()) {
    if (!start.startsWith(DEFINITIONS) || isTest(start)) continue;
    const parent = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.shift() ?? '';
      if (FORBIDDEN.some((pattern) => pattern.test(file))) {
        const chain = [file];
        for (let at = parent.get(file); at !== null && at !== undefined; at = parent.get(at)) {
          chain.push(at);
        }
        found.push(chain.reverse().join(' -> '));
        break;
      }
      for (const next of runtime.get(file) ?? []) {
        if (!parent.has(next)) {
          parent.set(next, file);
          queue.push(next);
        }
      }
    }
  }
  return found.sort();
}

describe('the provider definitions are free of the database and the stage’s configuration', () => {
  it('flags a definition that reaches the models or the environment, through any chain', () => {
    const tree = new Map([
      [`${DEFINITIONS}a.ts`, `import { x } from './b.js';`],
      [`${DEFINITIONS}b.ts`, `import { y } from '../../../builder/c.js';`],
      ['builder/c.ts', `import { getRepo } from '../models/index.js';`],
      ['models/index.ts', `import { environment } from '../config/environment.js';`],
      ['config/environment.ts', ''],
      [`${DEFINITIONS}d.ts`, `import { environment } from '../../../config/environment.js';`],
      [`${DEFINITIONS}e.ts`, `import type { X } from '../../../models/index.js';`],
      [
        `${DEFINITIONS}f.ts`,
        `import { PREFIX } from '../../../models/definitions/Integration.js';`,
      ],
      ['models/definitions/Integration.ts', ''],
    ]);
    assert.deepEqual(violations(tree), [
      `${DEFINITIONS}a.ts -> ${DEFINITIONS}b.ts -> builder/c.ts -> models/index.ts`,
      `${DEFINITIONS}b.ts -> builder/c.ts -> models/index.ts`,
      `${DEFINITIONS}d.ts -> config/environment.ts`,
    ]);
  });

  it('holds for the real tree', () => {
    const files = sourceTree();
    assert.ok(
      [...files.keys()].filter((file) => file.startsWith(DEFINITIONS)).length >= 8,
      'the definitions are scanned',
    );
    assert.deepEqual(violations(files), []);
  });
});
