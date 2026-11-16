/**
 * The demo data, pinned: every document of a demo workspace (testing/workspaceDump.ts: ids named
 * by what they identify, wall-clock times masked, sealed bytes as their length), after the seed's
 * first run and again after a second one. The expected dumps are demoDump.golden.json, beside this
 * file; it was written by the seed as it was before its writes were batched, so a seed that
 * writes the same data in fewer round trips leaves it unchanged.
 *
 * A deliberate change of the demo data regenerates it:
 * `UPDATE_DEMO_GOLDEN=1 node --import tsx --test src/seed/demoDump.golden.test.ts`,
 * then review the diff of the JSON.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { newUser } from '../testing/workspaceFixtures.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { dumpWorkspace } from '../testing/workspaceDump.js';

const GOLDEN = new URL('./demoDump.golden.json', import.meta.url);

/** The instant every fixture resolves against: Thursday 2026-11-12, 11:00 in Asia/Jerusalem. */
const NOW = new Date('2026-11-12T09:00:00.000Z');

let db: TestDatabase;
let guard: OutboundGuard;

before(async () => {
  db = await startTestDatabase('todolist_demo_dump_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  guard = installOutboundGuard();
});

after(async () => {
  guard.restore();
  await db.stop();
});

describe('the demo data', () => {
  it('is what the golden dump holds, after the first run and after a second one', async () => {
    const { Workspace } = await import('../classes/workspace/index.js');
    const { seedWorkspace } = await import('./seedWorkspace.js');
    const owner = await newUser('demo-dump');
    const workspace = await Workspace.create(owner, { name: 'Demo dump' });

    await seedWorkspace(workspace.id, NOW);
    const first = await dumpWorkspace(workspace.id);
    await seedWorkspace(workspace.id, NOW);
    const second = await dumpWorkspace(workspace.id);
    const actual = { first, second };

    if (process.env['UPDATE_DEMO_GOLDEN'] === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown;
    assert.deepEqual(actual, expected);
    assert.deepEqual(guard.externalHosts(), []);
  });
});
