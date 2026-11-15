/**
 * The dashboard internals, as a test over the import graph of server/src (like syncInternals):
 * the doors that skip a caller's checks are reachable only from the code that legitimately uses
 * them.
 *
 * Tests aside:
 * - only Dashboard, NewDashboard and DashboardDryRun load History (classes/dashboard/History.ts):
 *   History.of(…) reads and writes a dashboard's versions with no caller, so nothing else may;
 * - only Workspace loads the cascade (classes/workspace/cascade.ts): `new OwnerDeletion(id, actor)`
 *   deletes a workspace, its dashboards included, with no check of its own;
 * - the seed-only and global operations are named only where they belong:
 *   `listOutlines` (other members' private pages, outlined) by Dashboard, Persona and the seed;
 *   `pinAccount` (an account without a connection test) by Integration and the seed;
 *   `removeAllIn` (a workspace's hard deletes) by the classes that own them and the cascade;
 *   `removeConnectorEverywhere` by Dashboard and Integration#stopSharing;
 *   `removeOrphans` and `referencedWorkspaceIds` (global sweeps) by their classes and the purge;
 * - no barrel hands History or the cascade on (`export *` included), and no module re-exports one.
 * A type-only import is erased, so it loads nothing and is allowed anywhere. Every dynamic import
 * takes one string literal (vaultImports.test.ts), so this graph sees every edge.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { edgesOf, importsIn, nameText, scan, sourceTree } from '../../testing/importGraph.js';

const HISTORY = 'classes/dashboard/History.ts';
const DASHBOARD = 'classes/dashboard/Dashboard.ts';
const NEW_DASHBOARD = 'classes/dashboard/NewDashboard.ts';
const DRY_RUN = 'classes/dashboard/DashboardDryRun.ts';
const VIEW = 'classes/dashboard/View.ts';
const PERSONA = 'classes/dashboard/Persona.ts';
const CASCADE = 'classes/workspace/cascade.ts';
const WORKSPACE = 'classes/workspace/Workspace.ts';
const INTEGRATION = 'classes/integration/Integration.ts';
const SEED = 'seed/seedWorkspace.ts';
const PURGE = 'jobs/purge.ts';

/** Who may load each internal module at run time (besides tests). */
const LOADERS: Readonly<Record<string, ReadonlySet<string>>> = {
  [HISTORY]: new Set([DASHBOARD, NEW_DASHBOARD, DRY_RUN]),
  [CASCADE]: new Set([WORKSPACE]),
};

/** Doors without a caller's checks, and the modules (besides models/** and tests) that may name them. */
const GUARDED_NAMES: readonly { pattern: RegExp; allowed: ReadonlySet<string> }[] = [
  { pattern: /\blistOutlines\b/, allowed: new Set([DASHBOARD, PERSONA, SEED]) },
  { pattern: /\bpinAccount\b/, allowed: new Set([INTEGRATION, SEED]) },
  {
    pattern: /\bremoveAllIn\b/,
    allowed: new Set([DASHBOARD, HISTORY, VIEW, INTEGRATION, CASCADE]),
  },
  { pattern: /\bremoveConnectorEverywhere\b/, allowed: new Set([DASHBOARD, INTEGRATION]) },
  { pattern: /\bremoveOrphans\b/, allowed: new Set([DASHBOARD, PURGE]) },
  { pattern: /\breferencedWorkspaceIds\b/, allowed: new Set([DASHBOARD, HISTORY, VIEW]) },
  // The repository's global id list: the sweep's classes only (models/** is exempt).
  { pattern: /\blistWorkspaceIds\b/, allowed: new Set([DASHBOARD, HISTORY, VIEW]) },
  // The load gate by name too: a local `export { History }` in an allowed loader would otherwise
  // hand the class on without any import edge to History.ts.
  {
    pattern: /\bHistory\.of\b|\bHistoryTrail\b/,
    allowed: new Set([HISTORY, DASHBOARD, NEW_DASHBOARD, DRY_RUN]),
  },
];

/** The load gate, by name: History.of is how a trail is read and written. */
const HISTORY_NAMES = /\bHistory\.of\b|\bHistoryTrail\b/;

const isTest = (file: string): boolean =>
  file.endsWith('.test.ts') || file.startsWith('testing/') || file.includes('/__tests__/');

/** Every broken rule, as `<file>: <why>`. */
function violations(files: ReadonlyMap<string, string>): string[] {
  const exists = (file: string): boolean => files.has(file);
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file)) continue;
    const scanned = scan(source);
    for (const edge of edgesOf(file, importsIn(scanned), exists)) {
      // A package, or a dynamic import of no single literal (vaultImports.test refuses those).
      if (edge.target === null) continue;
      const loaders = LOADERS[edge.target];
      if (loaders === undefined || edge.typeOnly) continue;
      if (edge.kind === 'export') found.push(`${file}: re-exports ${edge.target}`);
      else if (!loaders.has(file)) found.push(`${file}: loads ${edge.target}`);
    }
    if (file.startsWith('models/')) continue;
    const text = nameText(scanned);
    for (const { pattern, allowed } of GUARDED_NAMES) {
      if (!allowed.has(file) && pattern.test(text)) found.push(`${file}: names ${pattern.source}`);
    }
  }
  return found.sort();
}

describe('the dashboard internals', () => {
  const files = sourceTree();

  it('sees the real tree (the scan is not vacuous)', () => {
    for (const file of [HISTORY, DASHBOARD, NEW_DASHBOARD, CASCADE, WORKSPACE, SEED, PURGE]) {
      assert.ok(files.has(file), file);
    }
    const loads = (from: string, target: string): boolean =>
      edgesOf(from, importsIn(scan(files.get(from) ?? '')), (file) => files.has(file)).some(
        (edge) => edge.target === target && !edge.typeOnly,
      );
    assert.ok(loads(DASHBOARD, HISTORY));
    assert.ok(loads(NEW_DASHBOARD, HISTORY));
    assert.ok(loads(WORKSPACE, CASCADE));
    const names = (file: string, pattern: RegExp): boolean =>
      pattern.test(nameText(scan(files.get(file) ?? '')));
    assert.ok(names(SEED, /\blistOutlines\b/) && names(SEED, /\bpinAccount\b/));
    assert.ok(names(PURGE, /\bremoveOrphans\b/) && names(CASCADE, /\bremoveAllIn\b/));
    assert.ok(names(DASHBOARD, /\bHistory\.of\b/) && names(HISTORY, /\bHistoryTrail\b/));
    for (const file of [DASHBOARD, HISTORY, VIEW]) {
      assert.ok(names(file, /\blistWorkspaceIds\b/), file);
    }
  });

  it('only their legitimate callers load them, and the guarded names are named only there', () => {
    assert.deepEqual(violations(files), []);
  });

  it('the rule catches a stray loader (a dynamic import too), a re-export (`export *` too) and a stray name', () => {
    const tree = new Map(files);
    tree.set(
      'routes/private/stray.ts',
      `import { History } from '../../classes/dashboard/History.js';`,
    );
    tree.set('classes/dashboard/barrel.ts', `export * from './History.js';`);
    tree.set(
      'controllers/lazy.ts',
      `export async function go() {\n  const { OwnerDeletion } = await import('../classes/workspace/cascade.js');\n  return OwnerDeletion;\n}`,
    );
    tree.set('classes/item/types.ts', `import type { History } from '../dashboard/History.js';`);
    tree.set(
      'mcp/tools/peek.ts',
      `export const go = (d: { listOutlines(): void }) => d.listOutlines();`,
    );
    tree.set(
      'services/pin.ts',
      `export const go = (i: { pinAccount(a: string): void }) => i.pinAccount('x');`,
    );
    assert.deepEqual(violations(tree), [
      'classes/dashboard/barrel.ts: re-exports classes/dashboard/History.ts',
      'controllers/lazy.ts: loads classes/workspace/cascade.ts',
      'mcp/tools/peek.ts: names \\blistOutlines\\b',
      'routes/private/stray.ts: loads classes/dashboard/History.ts',
      'services/pin.ts: names \\bpinAccount\\b',
    ]);
  });

  it('a local re-export from an allowed loader does not smuggle History out', () => {
    const tree = new Map(files);
    tree.set(
      DASHBOARD,
      `${files.get(DASHBOARD) ?? ''}
export { History };
`,
    );
    tree.set(
      'routes/private/smuggled.ts',
      `import { History } from '../../classes/dashboard/Dashboard.js';
export const go = () => History.of('w', 'd');`,
    );
    tree.set(
      'controllers/trail.ts',
      `import { HistoryTrail } from '../classes/dashboard/Dashboard.js';
export const go = (t: HistoryTrail<object>) => t;`,
    );
    tree.set(
      'services/ids.ts',
      `export const go = (r: { listWorkspaceIds(): string[] }) => r.listWorkspaceIds();`,
    );
    assert.deepEqual(violations(tree), [
      `controllers/trail.ts: names ${HISTORY_NAMES.source}`,
      `routes/private/smuggled.ts: names ${HISTORY_NAMES.source}`,
      `services/ids.ts: names ${/\blistWorkspaceIds\b/.source}`,
    ]);
  });

  it('no barrel names them', () => {
    for (const barrel of [
      'classes/dashboard/index.ts',
      'classes/workspace/index.ts',
      'classes/index.ts',
    ]) {
      const text = (files.get(barrel) ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal(
        /\bHistory\b|HistoryTrail|OwnerDeletion|AccountClosingDeletion|WorkspaceTeardown/.test(
          text,
        ),
        false,
        barrel,
      );
    }
  });
});
