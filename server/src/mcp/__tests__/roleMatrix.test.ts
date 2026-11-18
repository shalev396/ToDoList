/**
 * The scope × role matrix over the workspace tools (MCP.md §4, §7.5, §12), over HTTP: for each
 * role and key scope set, tools/list shows exactly the tools that key may call; every other
 * workspace tool is refused and changes nothing; every listed one works. A key never exceeds its
 * user: workspace:share on an editor still can't invite.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { AgentScope, Role } from '../../types/domain.js';
import { insertAgentKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam } from './helpers/team.js';

let h: McpHarness;
let models: typeof Models;

const READ = ['workspace_get', 'workspace_list_members', 'audit_log_query'];
const SHARE = [
  'workspace_invite',
  'workspace_update_member',
  'workspace_remove_member',
  'set_topic_colour',
  'set_file_under',
];
const ALL = [
  'workspace_get',
  'workspace_list_members',
  'workspace_invite',
  'workspace_update_member',
  'workspace_remove_member',
  'set_topic_colour',
  'set_file_under',
  'audit_log_query',
];

interface Row {
  role: Role;
  scopes: AgentScope[];
  readonly?: boolean;
  /** Exactly what tools/list shows, in order. */
  tools: string[];
}

const MATRIX: Row[] = [
  { role: 'viewer', scopes: ['read'], tools: [] },
  { role: 'viewer', scopes: ['workspace:read'], tools: READ },
  { role: 'viewer', scopes: ['workspace:share'], tools: [] },
  { role: 'viewer', scopes: ['workspace:read', 'workspace:share'], tools: READ },
  { role: 'editor', scopes: ['read'], tools: [] },
  { role: 'editor', scopes: ['workspace:read'], tools: READ },
  { role: 'editor', scopes: ['workspace:share'], tools: [] },
  { role: 'editor', scopes: ['workspace:read', 'workspace:share'], tools: READ },
  { role: 'owner', scopes: ['read'], tools: [] },
  { role: 'owner', scopes: ['workspace:read'], tools: READ },
  { role: 'owner', scopes: ['workspace:share'], tools: SHARE },
  { role: 'owner', scopes: ['workspace:read', 'workspace:share'], tools: ALL },
  { role: 'owner', scopes: ['workspace:read', 'workspace:share'], readonly: true, tools: READ },
];

before(async () => {
  h = await startMcpHarness('todolist_mcp_matrix_test', {});
  models = await import('../../models/index.js');
});

after(async () => {
  await h.stop();
});

let seq = 0;

describe('scope × role matrix over the workspace tools', () => {
  for (const row of MATRIX) {
    const label = `${row.role} [${row.scopes.join(', ')}]${row.readonly === true ? ' on /readonly' : ''}`;

    it(`${label}: lists ${row.tools.length === 0 ? 'nothing' : row.tools.join(', ')}`, async () => {
      seq += 1;
      const team = await newTeam(`matrix-${String(seq)}`);
      const { newUser } = await import('../../testing/workspaceFixtures.js');
      const target = await newUser(`matrix-${String(seq)}-target`);
      const memberships = await models.getMembershipRepository();
      await memberships.create(team.workspace.id, { userId: target.id, role: 'viewer' });
      const user = { viewer: team.viewer, editor: team.editor, owner: team.owner }[row.role];
      const key = await insertAgentKey({
        workspaceId: team.workspace.id,
        userId: user.id,
        scopes: row.scopes,
      });
      const client = await h.connect(key.raw, { readonly: row.readonly === true });

      const { tools } = await client.listTools();
      // The workspace toolset only: other toolsets have their own matrix (allToolsets.test.ts).
      assert.deepEqual(
        tools.map((tool) => tool.name).filter((name) => ALL.includes(name)),
        row.tools,
      );

      const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
      await addDefaultTopics(team.workspace.id);
      const { seedIntegration } = await import('../../testing/integrationFixtures.js');
      await seedIntegration(team.workspace.id, {
        id: `int-matrix-${String(seq)}`,
        ownerUserId: user.id,
        provider: 'jira',
      });
      const email = `invited-${String(seq)}@example.test`;
      const allowedCalls: Record<string, Record<string, unknown>> = {
        workspace_get: {},
        workspace_list_members: {},
        audit_log_query: {},
        workspace_invite: { email, role: 'viewer' },
        // Previews: allowed, and they change nothing either.
        workspace_update_member: { userId: target.id, role: 'editor' },
        workspace_remove_member: { userId: target.id },
        set_topic_colour: { topic: 'work', family: 'violet' },
        set_file_under: { integrationId: `int-matrix-${String(seq)}`, topic: 'work' },
      };
      const refusedCalls: Record<string, Record<string, unknown>> = {
        ...allowedCalls,
        workspace_update_member: { userId: target.id, role: 'editor', confirm: true },
        workspace_remove_member: { userId: target.id, confirm: true },
      };

      for (const name of ALL) {
        if (row.tools.includes(name)) {
          const result = await client.callTool({ name, arguments: allowedCalls[name] ?? {} });
          assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
        } else {
          await assert.rejects(
            client.callTool({ name, arguments: refusedCalls[name] ?? {} }),
            /not served on the read-only endpoint|needs a scope or role/,
            name,
          );
        }
      }

      // Refused calls changed nothing; the only change allowed here is the invite itself.
      assert.equal((await memberships.find(team.workspace.id, target.id))?.role, 'viewer');
      const invites = await (
        await models.getInviteRepository()
      ).listForWorkspace(team.workspace.id);
      assert.deepEqual(
        invites.map((invite) => invite.email),
        row.tools.includes('workspace_invite') ? [email] : [],
      );
    });
  }
});

/**
 * Every toolset: an agent key with every scope, for each role, on both endpoints. tools/list is
 * exactly what the registry allows that role (the contract test holds the registry to MCP.md's
 * table), and a tool outside the list is refused before it runs.
 */
describe('scope × role matrix over every toolset, on both endpoints', () => {
  const OUTSIDE: Record<Role, string> = {
    owner: 'create_todo',
    editor: 'builder_publish',
    viewer: 'create_todo',
  };
  for (const role of ['owner', 'editor', 'viewer'] as const) {
    for (const readonly of [false, true]) {
      it(`${role}${readonly ? ' on /readonly' : ''}: lists exactly the allowed tools`, async () => {
        const { AGENT_SCOPES } = await import('../../types/domain.js');
        const { effectiveScopes } = await import('../auth/scopes.js');
        const { toolsFor } = await import('../registry.js');
        seq += 1;
        const team = await newTeam(`matrix-all-${role}-${String(seq)}`);
        const key = await insertAgentKey({
          workspaceId: team.workspace.id,
          userId: team[role].id,
          scopes: [...AGENT_SCOPES],
        });
        const scopes = effectiveScopes(AGENT_SCOPES, role);
        const expected = toolsFor({ role, scopes }, { readonly }).map((tool) => tool.name);
        const client = await h.connect(key.raw, { readonly });
        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map((tool) => tool.name),
          expected,
        );
        if (role === 'owner' && !readonly) assert.equal(expected.length, 51);
        if (readonly) {
          assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
        }
        const outside = readonly ? 'create_todo' : OUTSIDE[role];
        if (!expected.includes(outside)) {
          await assert.rejects(
            client.callTool({ name: outside, arguments: { title: 'x' } }),
            /needs a scope or role|not served on the read-only endpoint/,
          );
        }
      });
    }
  }
});
