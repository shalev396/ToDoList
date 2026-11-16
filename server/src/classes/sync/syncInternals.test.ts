/**
 * The sync's internals, as a test over the import graph of server/src (like writePaths): what an
 * integration's syncs write is reachable only from the code that legitimately writes it.
 *
 * Tests aside:
 * - only Integration.ts loads the engine (classes/sync/SyncEngine.ts) at run time: it opens a
 *   credential's read session for a run, so nothing else may start one;
 * - only the engine, Integration.ts (its disconnect, a gone integration's run) and the purge load
 *   SyncedRows (classes/sync/SyncedRows.ts), whose writes take raw ids;
 * - only GoogleCalendarIntegration and PushCommit load EventClaim (classes/calendar/EventClaim.ts),
 *   whose `take` is a tombstone write by id;
 * - the global writes and reads are named only where they belong: `purgeDeletedBefore` by
 *   SyncedRows and the purge, `reapStuck` and `listRunningStartedBefore` by SyncRun and the purge
 *   (the models implement them);
 * - the batched fixture replays are the demo seed's alone: `syncTogether` is named only by
 *   Integration and the seed, `executeTogether` only by the engine and Integration;
 * - no barrel hands either internal module on (`export *` included), and no module re-exports one.
 * A type-only import is erased, so it loads nothing and is allowed anywhere. Every dynamic import
 * takes one string literal (vaultImports.test.ts), so this graph sees every edge.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgesOf, importsIn, nameText, scan, sourceTree } from '../../testing/importGraph.js';

const ENGINE = 'classes/sync/SyncEngine.ts';
const ROWS = 'classes/sync/SyncedRows.ts';
const INTEGRATION = 'classes/integration/Integration.ts';
const PURGE = 'jobs/purge.ts';
const SEED = 'seed/seedWorkspace.ts';
/** TodoList's claim on an event before its delete: an unguarded tombstone write by id. */
const CLAIM = 'classes/calendar/EventClaim.ts';
const GOOGLE = 'classes/integration/providers/GoogleCalendarIntegration.ts';

/** Who may load each internal module at run time (besides tests). */
const LOADERS: Readonly<Record<string, ReadonlySet<string>>> = {
  [ENGINE]: new Set([INTEGRATION]),
  // ContainerCache only names its type.
  [ROWS]: new Set([ENGINE, INTEGRATION, PURGE]),
  [CLAIM]: new Set([GOOGLE, 'classes/calendar/PushCommit.ts']),
};

/** Global operations, and the modules (besides models/** and tests) that may name them. */
const GLOBAL_NAMES: readonly { pattern: RegExp; allowed: ReadonlySet<string> }[] = [
  { pattern: /\bpurgeDeletedBefore\b/, allowed: new Set([ROWS, PURGE]) },
  {
    pattern: /\b(?:reapStuck|listRunningStartedBefore)\b/,
    allowed: new Set(['classes/sync/SyncRun.ts', PURGE]),
  },
  // The demo seed's batched fixture replays, and nothing else's.
  { pattern: /\bsyncTogether\b/, allowed: new Set([INTEGRATION, SEED]) },
  { pattern: /\bexecuteTogether\b/, allowed: new Set([ENGINE, INTEGRATION]) },
];

const isTest = (file: string): boolean =>
  file.endsWith('.test.ts') || file.startsWith('testing/') || file.includes('/__tests__/');

/** Every broken rule, as `<file>: <why>`. */
function violations(files: ReadonlyMap<string, string>): string[] {
  const exists = (file: string): boolean => files.has(file);
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file)) continue;
    const scanned = scan(source);
    const edges = edgesOf(file, importsIn(scanned), exists);
    for (const edge of edges) {
      // A package, or a dynamic import of no single literal (vaultImports.test refuses those).
      if (edge.target === null) continue;
      const loaders = LOADERS[edge.target];
      if (loaders === undefined || edge.typeOnly) continue;
      if (edge.kind === 'export') found.push(`${file}: re-exports ${edge.target}`);
      else if (!loaders.has(file)) found.push(`${file}: loads ${edge.target}`);
    }
    if (file.startsWith('models/')) continue;
    const text = nameText(scanned);
    for (const { pattern, allowed } of GLOBAL_NAMES) {
      if (!allowed.has(file) && pattern.test(text)) found.push(`${file}: names ${pattern.source}`);
    }
  }
  return found.sort();
}

describe('the sync internals', () => {
  const files = sourceTree();

  it('sees the real tree (the scan is not vacuous)', () => {
    assert.ok(files.has(ENGINE) && files.has(ROWS) && files.has(INTEGRATION) && files.has(PURGE));
    const loads = (from: string, target: string): boolean =>
      edgesOf(from, importsIn(scan(files.get(from) ?? '')), (file) => files.has(file)).some(
        (edge) => edge.target === target && !edge.typeOnly,
      );
    assert.ok(loads(INTEGRATION, ENGINE));
    assert.ok(loads(PURGE, ROWS));
    assert.ok(loads(ENGINE, ROWS));
    // The seed's batch is named where it is used.
    const names = (file: string, pattern: RegExp): boolean =>
      pattern.test(nameText(scan(files.get(file) ?? '')));
    assert.ok(names(SEED, /\bsyncTogether\b/) && names(INTEGRATION, /\bexecuteTogether\b/));
  });

  it('only their legitimate callers load them, and the global operations are named only there', () => {
    assert.deepEqual(violations(files), []);
  });

  it('the rule catches a stray loader (a dynamic import too), a re-export (`export *` too) and a stray name', () => {
    const tree = new Map(files);
    tree.set(
      'routes/private/stray.ts',
      `import { SyncedRows } from '../../classes/sync/SyncedRows.js';`,
    );
    tree.set(
      'mcp/tools/engine.ts',
      `export { SyncEngine } from '../../classes/sync/SyncEngine.js';`,
    );
    tree.set(
      'services/purgeAll.ts',
      `export const go = (x: { purgeDeletedBefore(): void }) => x.purgeDeletedBefore();`,
    );
    tree.set('classes/item/types.ts', `import type { SyncedRows } from '../sync/SyncedRows.js';`);
    tree.set(
      'controllers/lazy.ts',
      `export async function go() {\n  const { EventClaim } = await import('../classes/calendar/EventClaim.js');\n  return EventClaim;\n}`,
    );
    tree.set('classes/sync/barrel.ts', `export * from './SyncedRows.js';`);
    tree.set(
      'services/syncAll.ts',
      `export const go = (i: { syncTogether(): void }) => i.syncTogether();`,
    );
    assert.deepEqual(violations(tree), [
      'classes/sync/barrel.ts: re-exports classes/sync/SyncedRows.ts',
      'controllers/lazy.ts: loads classes/calendar/EventClaim.ts',
      'mcp/tools/engine.ts: re-exports classes/sync/SyncEngine.ts',
      'routes/private/stray.ts: loads classes/sync/SyncedRows.ts',
      'services/purgeAll.ts: names \\bpurgeDeletedBefore\\b',
      'services/syncAll.ts: names \\bsyncTogether\\b',
    ]);
  });

  it('no barrel names them', () => {
    for (const barrel of [
      'classes/sync/index.ts',
      'classes/index.ts',
      'classes/calendar/index.ts',
    ]) {
      const text = files.get(barrel) ?? '';
      assert.equal(
        /SyncEngine|SyncedRows|EventClaim/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')),
        false,
        barrel,
      );
    }
  });
});
