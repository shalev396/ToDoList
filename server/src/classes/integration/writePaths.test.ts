/**
 * The one write choke point (plan: "Read-only / read-write"), as a test over the import graph of
 * server/src: a provider writer is reachable only from the integration classes, whose protected
 * write session (Integration#withWriteSession) refuses demo data and read-only integrations
 * before it makes one.
 *
 * Outside classes/integration/** (tests aside), no module may:
 * - load anything under classes/integration/writers/ at run time (a type-only import is erased,
 *   so it can't send anything, and is allowed);
 * - name the writer factories or the create transport: `createWriteClient`, `calendarWriter`,
 *   `guardedTransport`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgesOf, importsIn, nameText, scan, sourceTree } from '../../testing/importGraph.js';

const ALLOWED = 'classes/integration/';
const WRITERS = 'classes/integration/writers/';
const WRITER_NAMES = /\b(?:createWriteClient|calendarWriter|guardedTransport)\b/;

const isTest = (file: string): boolean => file.endsWith('.test.ts');

/** Every broken rule, as `<file>: <why>`. */
function violations(files: ReadonlyMap<string, string>): string[] {
  const exists = (file: string): boolean => files.has(file);
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file) || file.startsWith(ALLOWED)) continue;
    const scanned = scan(source);
    for (const edge of edgesOf(file, importsIn(scanned), exists)) {
      if (!edge.typeOnly && edge.target?.startsWith(WRITERS) === true) {
        found.push(`${file}: loads ${edge.target}: only the integration classes reach a writer`);
      }
    }
    const named = WRITER_NAMES.exec(nameText(scanned));
    if (named !== null) {
      found.push(`${file}: names ${named[0]}: only the integration classes make a writer`);
    }
  }
  return found.sort();
}

/** The files of a synthetic tree that break a rule. */
function flagged(files: Record<string, string>): string[] {
  const tree = new Map(
    Object.entries({
      'classes/integration/writers/trackerWriter.ts': '',
      'classes/integration/writers/calendarApi.ts': '',
      'classes/integration/writers/calendarOps.ts': '',
      'classes/integration/index.ts': '',
      ...files,
    }),
  );
  return [...new Set(violations(tree).map((line) => line.slice(0, line.indexOf(':'))))].sort();
}

describe('the write paths, on synthetic trees', () => {
  it('a value import, a re-export or a dynamic import of a writer, outside the classes', () => {
    assert.deepEqual(
      flagged({
        'services/create.ts': `import { createWriteClient } from '../classes/integration/writers/trackerWriter.js';`,
        'services/push.ts': `import { applyOps } from '../classes/integration/writers/calendarOps.js';`,
        'routes/again.ts': `export * from '../classes/integration/writers/calendarApi.js';`,
        'mcp/tools/later.ts': `const w = await import('../../classes/integration/writers/calendarApi.js');`,
      }),
      ['mcp/tools/later.ts', 'routes/again.ts', 'services/create.ts', 'services/push.ts'],
    );
  });

  it('naming a writer factory or the create transport, however it is reached', () => {
    assert.deepEqual(
      flagged({
        'services/a.ts': `export const w = (t: string) => calendarWriter(t);`,
        'services/b.ts': `const transport = guardedTransport(inner);`,
        'services/c.ts': `const { createWriteClient } = await import('./elsewhere.js');`,
        'services/comment.ts': `// createWriteClient is only named in this comment\nexport const x = 1;`,
      }),
      ['services/a.ts', 'services/b.ts', 'services/c.ts'],
    );
  });

  it('allows type-only imports, the classes themselves, and tests', () => {
    assert.deepEqual(
      flagged({
        'services/types.ts': `import type { WriteResult } from '../classes/integration/writers/trackerWriter.js';`,
        'services/mixed.ts': `import { type CreateFields, type WriteResult } from '../classes/integration/writers/trackerWriter.js';`,
        'services/barrel.ts': `import { Integration } from '../classes/integration/index.js';`,
        'classes/integration/providers/X.ts': `import { calendarWriter } from '../writers/calendarApi.js';`,
        'classes/integration/writers/trackerWriter.test.ts': `import { guardedTransport } from './trackerWriter.js';`,
        'services/push.test.ts': `import { applyOps } from '../classes/integration/writers/calendarOps.js';`,
      }),
      [],
    );
  });
});

describe('server/src write paths', () => {
  const files = sourceTree();

  it('sees the real tree (the scan is not vacuous)', () => {
    assert.ok(files.has('classes/integration/writers/trackerWriter.ts'));
    assert.ok(files.has('classes/integration/writers/calendarApi.ts'));
    assert.ok(files.has('services/providerCreate/service.ts'));
  });

  it('only the integration classes reach a provider writer', () => {
    assert.deepEqual(violations(files), []);
  });
});
