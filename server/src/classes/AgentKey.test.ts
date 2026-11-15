/** AgentKey: creating within a role, authenticating, revoking, and the listed shape. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { newTeam } from '../mcp/__tests__/helpers/team.js';
import { ROLE_SCOPES } from '../mcp/auth/scopes.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { callerFor } from '../testing/workspaceFixtures.js';
import type { AgentKey as AgentKeyClass } from './AgentKey.js';

let db: TestDatabase;
let AgentKey: typeof AgentKeyClass;

before(async () => {
  db = await startTestDatabase('todolist_agent_key_class_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  ({ AgentKey } = await import('./AgentKey.js'));
});

after(async () => {
  await db.stop();
});

describe('AgentKey', () => {
  it('authenticate resolves a usable key and refuses a revoked one', async () => {
    const team = await newTeam('agent-key-class-auth');
    const caller = await callerFor(team.workspace.id, team.editor.id);
    const { key, raw } = await AgentKey.create(caller, {
      name: 'Editor key',
      scopes: ['read', 'items:write'],
    });
    const agent = await AgentKey.authenticate(raw, new Date(), {});
    assert.ok(agent);
    assert.equal(agent.principal.agentId, key.id);
    assert.ok(agent.principal.scopes.every((s) => ROLE_SCOPES[agent.principal.role].includes(s)));

    await AgentKey.revoke(caller, key.id);
    assert.equal(await AgentKey.authenticate(raw, new Date(), {}), null);
  });

  it('list never exposes the hash', async () => {
    const team = await newTeam('agent-key-class-list');
    const caller = await callerFor(team.workspace.id, team.owner.id);
    await AgentKey.create(caller, { name: 'Listed', scopes: ['read'] });
    const views = await AgentKey.list(caller);
    assert.ok(views.length > 0);
    for (const view of views) {
      for (const field of Object.keys(view)) assert.doesNotMatch(field, /hash/i);
      assert.doesNotMatch(JSON.stringify(view), /hash/i);
    }
  });
});
