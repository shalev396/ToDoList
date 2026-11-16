/**
 * The plugin's smoke flow (scripts/mcp-smoke.ts) in-process: a memory-Mongo app, a seeded
 * workspace and a generated FAKE agent key. The key is never printed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatTable, runSmoke } from '../../../scripts/mcp-smoke.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { startMcpHarness, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let team: Team;
let key: TestKey;

before(async () => {
  h = await startMcpHarness('todolist_mcp_smoke_test', {});
  team = await newTeam('smoke');
  key = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read', 'items:write'],
  });
});

after(async () => {
  await h.stop();
});

describe('mcp smoke flow', () => {
  it('passes every step and prints no key', async () => {
    const client = await h.connect(key.raw);
    const steps = await runSmoke(client);
    const table = formatTable(steps);
    assert.deepEqual(
      steps.filter((s) => !s.ok),
      [],
      table,
    );
    assert.equal(steps.length, 5);
    assert.ok(!table.includes(key.raw));
  });
});
