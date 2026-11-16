/**
 * The tool contract (MCP.md §2, §7, §8, §12): exactly the tools of MCP.md, in catalog order, each
 * with the scopes, minimum role and read-only hint the table below gives; an outputSchema and all
 * four annotations on every tool; no schema that mentions a token, a secret or a credential;
 * destructive tools that take `confirm`; and a server that registers only what the principal may
 * call. Checked on the catalog and over MCP itself (an in-memory client, tools/list).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import type { WorkspaceContext } from '../../classes/base/Caller.js';
import { AGENT_SCOPES, ROLE_RANK, type AgentScope, type Role } from '../../types/domain.js';
import type { AgentPrincipal } from '../auth/principal.js';
import { READ_ONLY_SCOPES } from '../auth/scopes.js';
import { buildServer, TOOLS, toolsFor } from '../registry.js';

interface Spec {
  name: string;
  scopes: AgentScope[];
  minRole: Role;
  readOnly: boolean;
  destructive?: boolean;
}

/**
 * MCP.md §7.1–§7.5 and §8.2, in catalog order: scopes as the tables give them, minimum roles as the
 * services (and DATA.md §5) require them.
 */
const MCP_TABLE: readonly Spec[] = [
  // §7.1 Read
  { name: 'search_items', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'list_today', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'list_deadlines', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'get_calendar', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'get_item', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'list_facets', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'query_items', scopes: ['read'], minRole: 'viewer', readOnly: true },
  // §7.2 Local items
  { name: 'create_todo', scopes: ['items:write'], minRole: 'editor', readOnly: false },
  { name: 'update_todo', scopes: ['items:write'], minRole: 'editor', readOnly: false },
  { name: 'complete_todo', scopes: ['items:write'], minRole: 'editor', readOnly: false },
  {
    name: 'delete_todo',
    scopes: ['items:write'],
    minRole: 'editor',
    readOnly: false,
    destructive: true,
  },
  { name: 'set_overlay', scopes: ['items:write'], minRole: 'editor', readOnly: false },
  { name: 'list_attributes', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'set_item_attributes', scopes: ['items:write'], minRole: 'editor', readOnly: false },
  // §7.3 Sync
  { name: 'sync_now', scopes: ['sync'], minRole: 'editor', readOnly: false },
  { name: 'get_sync_status', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'sync_to_google_calendar', scopes: ['gcal:write'], minRole: 'editor', readOnly: false },
  // §7.4 Integrations
  { name: 'integrations_list', scopes: ['integrations:read'], minRole: 'viewer', readOnly: true },
  // PERMISSIONS-V2: editors connect their own integrations; any member disconnects their own.
  {
    name: 'integrations_start_connect',
    scopes: ['integrations:connect'],
    minRole: 'editor',
    readOnly: false,
  },
  {
    name: 'integrations_disconnect',
    scopes: ['integrations:connect'],
    minRole: 'viewer',
    readOnly: false,
    destructive: true,
  },
  // §7.5 Workspace and sharing
  { name: 'workspace_get', scopes: ['workspace:read'], minRole: 'viewer', readOnly: true },
  { name: 'workspace_list_members', scopes: ['workspace:read'], minRole: 'viewer', readOnly: true },
  { name: 'workspace_invite', scopes: ['workspace:share'], minRole: 'owner', readOnly: false },
  {
    name: 'workspace_update_member',
    scopes: ['workspace:share'],
    minRole: 'owner',
    readOnly: false,
    destructive: true,
  },
  {
    name: 'workspace_remove_member',
    scopes: ['workspace:share'],
    minRole: 'owner',
    readOnly: false,
    destructive: true,
  },
  { name: 'audit_log_query', scopes: ['workspace:read'], minRole: 'viewer', readOnly: true },
  // §8.2 Builder
  { name: 'builder_list_dashboards', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'builder_get_dashboard', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'builder_list_block_types', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'builder_list_templates', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'builder_validate', scopes: ['read'], minRole: 'viewer', readOnly: true },
  { name: 'builder_preview', scopes: ['read'], minRole: 'editor', readOnly: true },
  {
    name: 'builder_create_dashboard',
    scopes: ['builder:write'],
    minRole: 'editor',
    readOnly: false,
  },
  {
    name: 'builder_instantiate_persona',
    scopes: ['builder:write'],
    minRole: 'editor',
    readOnly: false,
  },
  { name: 'builder_add_block', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  { name: 'builder_add_view', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  { name: 'builder_update_view', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  {
    name: 'builder_remove_view',
    scopes: ['builder:write'],
    minRole: 'editor',
    readOnly: false,
    destructive: true,
  },
  { name: 'builder_update_block', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  { name: 'builder_arrange', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  { name: 'builder_connect_blocks', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  { name: 'builder_apply_patch', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  {
    name: 'builder_apply_template',
    scopes: ['builder:write'],
    minRole: 'editor',
    readOnly: false,
    destructive: true,
  },
  {
    name: 'builder_remove_block',
    scopes: ['builder:write'],
    minRole: 'editor',
    readOnly: false,
    destructive: true,
  },
  { name: 'builder_list_versions', scopes: ['read'], minRole: 'editor', readOnly: true },
  { name: 'builder_undo', scopes: ['builder:write'], minRole: 'editor', readOnly: false },
  {
    name: 'builder_revert',
    scopes: ['builder:write'],
    minRole: 'editor',
    readOnly: false,
    destructive: true,
  },
  { name: 'builder_publish', scopes: ['builder:publish'], minRole: 'owner', readOnly: false },
];

const FORBIDDEN_WORDS = /token|secret|credential/i;

function principal(role: Role, scopes: AgentScope[]): AgentPrincipal {
  return { userId: 'u-1', workspaceId: 'w-1', agentId: 'k-1', role, scopes };
}

/** What the table says this principal may list. */
function expected(role: Role, scopes: readonly AgentScope[], readonly = false): string[] {
  const usable = scopes.filter((scope) => !readonly || READ_ONLY_SCOPES.includes(scope));
  return MCP_TABLE.filter(
    (spec) =>
      (!readonly || spec.readOnly) &&
      ROLE_RANK[role] >= ROLE_RANK[spec.minRole] &&
      spec.scopes.every((scope) => usable.includes(scope)),
  ).map((spec) => spec.name);
}

const WORKSPACE: WorkspaceContext = {
  id: 'w-1',
  role: 'owner',
  settings: { timezone: 'Asia/Jerusalem', weekStart: 'sun', topicRules: [] },
};

async function listOverMcp(
  readonly: boolean,
  who: AgentPrincipal,
): Promise<Record<string, unknown>[]> {
  const server = buildServer({ readonly, principal: who, workspace: WORKSPACE });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('the tool catalog', () => {
  it('is exactly the tools of MCP.md, in catalog order', () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      MCP_TABLE.map((spec) => spec.name),
    );
  });

  it('gives each tool the scopes, minimum role and hints of the table', () => {
    for (const spec of MCP_TABLE) {
      const tool = TOOLS.find((candidate) => candidate.name === spec.name);
      assert.ok(tool, spec.name);
      assert.deepEqual([...tool.scopes], spec.scopes, `${spec.name} scopes`);
      assert.equal(tool.minRole, spec.minRole, `${spec.name} role`);
      assert.equal(tool.annotations.readOnlyHint, spec.readOnly, `${spec.name} readOnlyHint`);
      assert.equal(
        tool.annotations.destructiveHint,
        spec.destructive === true,
        `${spec.name} destructiveHint`,
      );
    }
  });

  it('gives every tool a title, a description, an output schema and all four annotations', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.title.length > 0, tool.name);
      assert.ok(tool.description.length > 0, tool.name);
      assert.ok(tool.outputSchema instanceof z.ZodObject, tool.name);
      assert.deepEqual(
        Object.keys(tool.annotations).sort(),
        ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'],
        tool.name,
      );
    }
  });

  it('mentions no token, secret or credential in any input or output schema', () => {
    for (const tool of TOOLS) {
      const input = JSON.stringify(z.toJSONSchema(tool.inputSchema, { io: 'input' }));
      const output = JSON.stringify(z.toJSONSchema(tool.outputSchema, { io: 'output' }));
      assert.doesNotMatch(input, FORBIDDEN_WORDS, `${tool.name} input`);
      assert.doesNotMatch(output, FORBIDDEN_WORDS, `${tool.name} output`);
    }
  });

  it('closes every input schema (additionalProperties: false)', () => {
    for (const tool of TOOLS) {
      const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
      assert.equal(schema.additionalProperties, false, tool.name);
    }
  });

  it('gives destructive tools a confirm input and a preview', () => {
    for (const tool of TOOLS.filter((candidate) => candidate.annotations.destructiveHint)) {
      assert.ok('confirm' in tool.inputSchema.shape, tool.name);
      assert.equal(typeof tool.preview, 'function', tool.name);
    }
  });

  it('marks read-only only tools that need read scopes alone', () => {
    for (const tool of TOOLS) {
      if (!tool.annotations.readOnlyHint) continue;
      assert.ok(
        tool.scopes.every((scope) => READ_ONLY_SCOPES.includes(scope)),
        tool.name,
      );
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
  });
});

describe('toolsFor', () => {
  const names = (role: Role, scopes: AgentScope[], readonly = false): string[] =>
    toolsFor(principal(role, scopes), { readonly }).map((tool) => tool.name);

  it('follows the table for every role, with every scope, on both endpoints', () => {
    for (const role of ['viewer', 'editor', 'owner'] as const) {
      for (const readonly of [false, true]) {
        assert.deepEqual(
          names(role, [...AGENT_SCOPES], readonly),
          expected(role, AGENT_SCOPES, readonly),
          `${role} readonly=${String(readonly)}`,
        );
      }
    }
  });

  it('follows the table for each single scope', () => {
    for (const scope of AGENT_SCOPES) {
      assert.deepEqual(names('owner', [scope]), expected('owner', [scope]), scope);
    }
  });

  it('gives nothing to a key without scopes', () => {
    assert.deepEqual(names('owner', []), []);
  });
});

describe('tools/list over MCP', () => {
  it('lists only what the principal may call, in catalog order, with output schemas', async () => {
    const tools = await listOverMcp(false, principal('owner', [...AGENT_SCOPES]));
    assert.deepEqual(
      tools.map((tool) => tool['name']),
      expected('owner', AGENT_SCOPES),
    );
    for (const tool of tools) {
      assert.equal(typeof tool['outputSchema'], 'object', String(tool['name']));
      assert.doesNotMatch(JSON.stringify(tool['inputSchema']), FORBIDDEN_WORDS);
      assert.doesNotMatch(JSON.stringify(tool['outputSchema']), FORBIDDEN_WORDS);
      const annotations = tool['annotations'] as Record<string, unknown>;
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof annotations[hint], 'boolean', `${String(tool['name'])} ${hint}`);
      }
    }
  });

  it('advertises each tool’s own input schema: closed, with its required fields', async () => {
    const tools = await listOverMcp(false, principal('owner', [...AGENT_SCOPES]));
    const invite = tools.find((tool) => tool['name'] === 'workspace_invite');
    const schema = invite?.['inputSchema'] as Record<string, unknown> | undefined;
    assert.ok(schema);
    assert.equal(schema['type'], 'object');
    assert.equal(schema['additionalProperties'], false);
    assert.deepEqual(schema['required'], ['email', 'role']);
    assert.deepEqual(Object.keys(schema['properties'] ?? {}).sort(), [
      'email',
      'language',
      'message',
      'role',
    ]);
  });

  it('is the same list every time (prompt caching)', async () => {
    const who = principal('owner', [...AGENT_SCOPES]);
    const first = JSON.stringify(await listOverMcp(false, who));
    const second = JSON.stringify(await listOverMcp(false, who));
    assert.equal(first, second);
  });

  it('lists only read-only tools on /readonly', async () => {
    const tools = await listOverMcp(true, principal('owner', [...AGENT_SCOPES]));
    assert.deepEqual(
      tools.map((tool) => tool['name']),
      expected('owner', AGENT_SCOPES, true),
    );
  });

  it('still answers tools/list, empty, for a key that may call nothing', async () => {
    assert.deepEqual(await listOverMcp(false, principal('viewer', [])), []);
  });
});
