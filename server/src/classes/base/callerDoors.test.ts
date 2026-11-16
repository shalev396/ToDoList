/**
 * `Caller.fromContext` mints a Caller, with any role, from a plain WorkspaceContext: no read of the
 * workspace or the membership. It is the policy layer's root of trust, so it is a door like
 * `withSyncSecret` and the `removeAllIn`s, pinned here to the modules that legitimately use it
 * (phase 7c, final review m6). Each of them is handed a context `Caller.enter` already resolved:
 *
 * - the MCP side, whose context is the authenticated principal's (mcp/auth/principal.ts sets it
 *   from `Caller.enter`; the tool and resource helpers rebuild a caller from it, narrowed to a
 *   read tool's topics where asked): principal.ts, resources.ts, tools/itemViews.ts,
 *   tools/builder/common.ts, tools/integrations/startConnect.ts;
 * - the services the REST controllers call with `req.workspace`, which requireWorkspace set from
 *   `Caller.enter`: gcalSync, oauth/service, providerCreate/service, syncRuns, workspaceQuery.
 *
 * Why a pin and not a check inside fromContext: those contexts are legitimately copied on the way
 * (`caller.context` hands out a copy; a read tool narrows `{...workspace, onlyTopics}`), so an
 * identity or brand check would refuse them or be cast away. A new caller of the door is a
 * reviewed change to this list instead. Tests and src/testing build callers from fixtures freely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nameText, scan, sourceTree } from '../../testing/importGraph.js';

const CALLER = 'classes/base/Caller.ts';

/** Who may name `fromContext` (besides tests and src/testing): the door itself and its callers. */
const FROM_CONTEXT_CALLERS: ReadonlySet<string> = new Set([
  CALLER,
  'mcp/auth/principal.ts',
  'mcp/resources.ts',
  'mcp/tools/itemViews.ts',
  'mcp/tools/builder/common.ts',
  'mcp/tools/integrations/startConnect.ts',
  'services/gcalSync.ts',
  'services/oauth/service.ts',
  'services/providerCreate/service.ts',
  'services/syncRuns.ts',
  'services/workspaceQuery.ts',
]);

const DOOR = /\bfromContext\b/;

const isTest = (file: string): boolean =>
  file.endsWith('.test.ts') || file.startsWith('testing/') || file.includes('/__tests__/');

/** Every module that names the door without being allowed to, sorted. */
function strays(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    if (isTest(file) || FROM_CONTEXT_CALLERS.has(file)) continue;
    if (DOOR.test(nameText(scan(source)))) found.push(file);
  }
  return found.sort();
}

describe('Caller.fromContext is pinned to its callers', () => {
  const files = sourceTree();

  it('sees the real tree: each pinned module exists and names it (the list is not stale)', () => {
    for (const file of FROM_CONTEXT_CALLERS) {
      assert.ok(files.has(file), `${file} is gone: take it off the list`);
      assert.ok(DOOR.test(nameText(scan(files.get(file) ?? ''))), `${file} no longer names it`);
    }
  });

  it('no other production module names it', () => {
    assert.deepEqual(strays(files), []);
  });

  it('catches a stray caller, a destructured alias and a dynamic import; not a comment or a test', () => {
    const tree = new Map(files);
    tree.set(
      'routes/private/stray.ts',
      `import { Caller } from '../../classes/base/Caller.js';\nexport const c = (x: never) => Caller.fromContext(x, x);`,
    );
    tree.set(
      'controllers/alias.ts',
      `import { Caller } from '../classes/base/Caller.js';\nconst { fromContext: mint } = Caller;\nexport { mint };`,
    );
    tree.set(
      'services/lazy.ts',
      `export async function go() {\n  const { Caller } = await import('../classes/base/Caller.js');\n  return Caller['fromContext'];\n}`,
    );
    tree.set(
      'services/commented.ts',
      `// Caller.fromContext is not called here\nexport const x = 1;`,
    );
    tree.set('services/fixture.test.ts', `Caller.fromContext(ctx, actor);`);
    assert.deepEqual(strays(tree), [
      'controllers/alias.ts',
      'routes/private/stray.ts',
      'services/lazy.ts',
    ]);
  });
});
