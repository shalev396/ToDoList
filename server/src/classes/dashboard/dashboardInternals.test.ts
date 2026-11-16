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
 * - the dashboard collections are read and written only by their classes (phase 6a review M7): the
 *   Dashboards repository by Dashboard and NewDashboard, DashboardVersions by History, Views by
 *   View; any other class asks them (`connectorIdsIn` for ItemPolicy's share facts,
 *   `softDeleteAllOn` for a deleted topic's pages, `load` and `pageBlock` for QueryTarget);
 * - the seed-only and global operations are named only where they belong:
 *   `listOutlines` (other members' private pages, outlined) by Dashboard, Persona and the seed;
 *   `pinAccount` (an account without a connection test) by Integration and the seed;
 *   `removeAllIn` (a workspace's hard deletes) by the classes that own them and the cascade;
 *   `removeConnectorEverywhere` by Dashboard and Integration#stopSharing;
 *   `removeOrphans` and `referencedWorkspaceIds` (global sweeps) by their classes and the purge;
 * - the dashboard document check has one composer: the steps of the document (the builder's
 *   refusedInput, parseDraft, variableIssues, secretIssues, finalIssues) are named only by DocCheck,
 *   and the per-block rules (vizIssues, queryRuleIssues, filterVariableIssues, actionNameIssues,
 *   lintFields, lintSourceLink, lintText) only by the Block classes that apply them, so no write
 *   validates a dashboard any other way (phase 6a review R1);
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
const DOC_CHECK = 'classes/dashboard/DocCheck.ts';
const VALIDATE = 'builder/validate.ts';
const CATALOG = 'builder/catalog.ts';
const LINT = 'builder/lint.ts';
const BLOCK = 'classes/dashboard/blocks/Block.ts';
const ROW_BLOCK = 'classes/dashboard/blocks/RowBlock.ts';
const FILTER_BLOCK = 'classes/dashboard/blocks/FilterBlock.ts';
const ACTION_BLOCK = 'classes/dashboard/blocks/ActionBlock.ts';
const ITEM_POLICY = 'classes/policies/ItemPolicy.ts';
const TOPIC = 'classes/workspace/Topic.ts';
const QUERY_TARGET = 'classes/item/QueryTarget.ts';

/** The steps of the document check, composed by DocCheck alone. */
const DOCUMENT_STEPS = /\b(refusedInput|parseDraft|variableIssues|secretIssues|finalIssues)\b/;
/** The per-block rules the base Block applies. */
const BLOCK_RULES = /\b(vizIssues|queryRuleIssues|lintFields|lintText)\b/;

/** Who may load each internal module at run time (besides tests). */
const LOADERS: Readonly<Record<string, ReadonlySet<string>>> = {
  [HISTORY]: new Set([DASHBOARD, NEW_DASHBOARD, DRY_RUN]),
  [CASCADE]: new Set([WORKSPACE]),
};

/** Doors without a caller's checks, and the modules (besides models/** and tests) that may name them. */
const GUARDED_NAMES: readonly { pattern: RegExp; allowed: ReadonlySet<string> }[] = [
  // The dashboard collections, each through its own class (models/** is exempt).
  { pattern: /\bgetDashboardRepository\b/, allowed: new Set([DASHBOARD, NEW_DASHBOARD]) },
  { pattern: /\bgetDashboardVersionRepository\b/, allowed: new Set([HISTORY]) },
  { pattern: /\bgetViewRepository\b/, allowed: new Set([VIEW]) },
  // What another class asks of every dashboard of a workspace, with no caller of its own.
  { pattern: /\bconnectorIdsIn\b/, allowed: new Set([DASHBOARD, ITEM_POLICY]) },
  { pattern: /\bsoftDeleteAllOn\b/, allowed: new Set([DASHBOARD, TOPIC]) },
  { pattern: /\blistOutlines\b/, allowed: new Set([DASHBOARD, PERSONA, SEED]) },
  { pattern: /\bpinAccount\b/, allowed: new Set([INTEGRATION, SEED]) },
  {
    pattern: /\bremoveAllIn\b/,
    allowed: new Set([DASHBOARD, HISTORY, VIEW, INTEGRATION, TOPIC, CASCADE]),
  },
  { pattern: /\bremoveConnectorEverywhere\b/, allowed: new Set([DASHBOARD, INTEGRATION]) },
  { pattern: /\bremoveOrphans\b/, allowed: new Set([DASHBOARD, PURGE]) },
  { pattern: /\breferencedWorkspaceIds\b/, allowed: new Set([DASHBOARD, HISTORY, VIEW]) },
  // The repository's global id list: the sweep's classes only (models/** is exempt).
  { pattern: /\blistWorkspaceIds\b/, allowed: new Set([DASHBOARD, HISTORY, VIEW, TOPIC]) },
  // The load gate by name too: a local `export { History }` in an allowed loader would otherwise
  // hand the class on without any import edge to History.ts.
  {
    pattern: /\bHistory\.of\b|\bHistoryTrail\b/,
    allowed: new Set([HISTORY, DASHBOARD, NEW_DASHBOARD, DRY_RUN]),
  },
  // The document check: one composer (DocCheck), and each per-block rule applied by its class.
  { pattern: DOCUMENT_STEPS, allowed: new Set([VALIDATE, DOC_CHECK]) },
  { pattern: BLOCK_RULES, allowed: new Set([CATALOG, LINT, BLOCK]) },
  { pattern: /\blintSourceLink\b/, allowed: new Set([LINT, ROW_BLOCK]) },
  { pattern: /\bfilterVariableIssues\b/, allowed: new Set([CATALOG, FILTER_BLOCK]) },
  { pattern: /\bactionNameIssues\b/, allowed: new Set([CATALOG, ACTION_BLOCK]) },
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
    assert.ok(names(DOC_CHECK, /\bparseDraft\b/) && names(DOC_CHECK, /\bsecretIssues\b/));
    assert.ok(names(BLOCK, /\bvizIssues\b/) && names(BLOCK, /\blintText\b/));
    assert.ok(names(ROW_BLOCK, /\blintSourceLink\b/));
    assert.ok(names(FILTER_BLOCK, /\bfilterVariableIssues\b/));
    assert.ok(names(ACTION_BLOCK, /\bactionNameIssues\b/));
    assert.ok(names(DASHBOARD, /\bgetDashboardRepository\b/));
    assert.ok(names(HISTORY, /\bgetDashboardVersionRepository\b/));
    assert.ok(names(VIEW, /\bgetViewRepository\b/));
    assert.ok(names(ITEM_POLICY, /\bconnectorIdsIn\b/) && names(TOPIC, /\bsoftDeleteAllOn\b/));
    assert.ok(names(QUERY_TARGET, /\bView\.load\b/) && names(QUERY_TARGET, /\bpageBlock\b/));
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

  it('a class that reads a dashboard collection itself is caught (phase 6a review M7)', () => {
    const tree = new Map(files);
    tree.set(
      QUERY_TARGET,
      `${files.get(QUERY_TARGET) ?? ''}
import { getViewRepository } from '../../models/index.js';
export const own = getViewRepository;`,
    );
    tree.set(
      ITEM_POLICY,
      `${files.get(ITEM_POLICY) ?? ''}
export const raw = async () => (await import('../../models/index.js')).getDashboardRepository;`,
    );
    tree.set(
      TOPIC,
      `${files.get(TOPIC) ?? ''}
export const versions = 'getDashboardVersionRepository';`,
    );
    tree.set(
      'mcp/tools/peek.ts',
      `export const go = (d: { connectorIdsIn(): void }) => d.connectorIdsIn();`,
    );
    assert.deepEqual(violations(tree), [
      `${QUERY_TARGET}: names ${/\bgetViewRepository\b/.source}`,
      `${ITEM_POLICY}: names ${/\bgetDashboardRepository\b/.source}`,
      `${TOPIC}: names ${/\bgetDashboardVersionRepository\b/.source}`,
      `mcp/tools/peek.ts: names ${/\bconnectorIdsIn\b/.source}`,
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

  it('the document check has one composer: a write that validates by itself is caught', () => {
    const tree = new Map(files);
    tree.set(
      'builder/ops.ts',
      `${files.get('builder/ops.ts') ?? ''}
import { parseDraft } from './validate.js';
export const own = (draft: unknown) => parseDraft(draft);`,
    );
    tree.set(
      DASHBOARD,
      `${files.get(DASHBOARD) ?? ''}
import { vizIssues } from '../../builder/catalog.js';
export const own = vizIssues;`,
    );
    tree.set(
      'classes/dashboard/blocks/ListBlock.ts',
      `${files.get('classes/dashboard/blocks/ListBlock.ts') ?? ''}
import { lintSourceLink } from '../../../builder/lint.js';
export const own = lintSourceLink;`,
    );
    assert.deepEqual(violations(tree), [
      `builder/ops.ts: names ${DOCUMENT_STEPS.source}`,
      `classes/dashboard/Dashboard.ts: names ${BLOCK_RULES.source}`,
      `classes/dashboard/blocks/ListBlock.ts: names ${/\blintSourceLink\b/.source}`,
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
