/**
 * Resources and prompts (MCP.md §10) over HTTP:
 * - each principal is offered the resources and prompts its scopes and role allow, on this
 *   endpoint;
 * - resources are JSON, private-cached, and redacted like the tools. Reads are audited as
 *   mcp.resource.<name>, and another workspace's item is not found;
 * - prompts are static instructions that name the tools, with the user's own arguments.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { startMcpHarness, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

const FAKE_GITHUB_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';

let h: McpHarness;
let models: typeof Models;
let team: Team;
let fullKey: TestKey;
let readKey: TestKey;
let viewerKey: TestKey;
let itemId = '';
let otherItemId = '';
let dashboardId = '';

before(async () => {
  h = await startMcpHarness('todolist_mcp_resources_test', {});
  models = await import('../../models/index.js');
  team = await newTeam('resources');
  const other = await newTeam('resources-other');
  fullKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read', 'workspace:read', 'integrations:read', 'builder:write'],
  });
  readKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read'],
  });
  viewerKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.viewer.id,
    scopes: ['read', 'workspace:read'],
  });
  const items = await models.getItemRepository();
  itemId = (
    await items.createLocal(team.workspace.id, {
      ownerUserId: team.editor.id,
      title: 'Rotate the deploy key',
      topicId: 'work',
      bodyPreview: `old one: ${FAKE_GITHUB_TOKEN}`,
    })
  ).id;
  otherItemId = (
    await items.createLocal(other.workspace.id, {
      ownerUserId: other.owner.id,
      title: 'Not yours',
      topicId: 'work',
    })
  ).id;
  const { createDashboard } = await import('../../testing/dashboardCalls.js');
  const { contextFor } = await import('../../testing/workspaceFixtures.js');
  dashboardId = (
    await createDashboard(
      await contextFor(team.workspace.id, team.editor.id),
      { userId: team.editor.id, agentId: null },
      { fromTemplate: 'college', language: 'en' },
    )
  ).id;
});

after(async () => {
  await h.stop();
});

async function read(key: TestKey, uri: string): Promise<Record<string, unknown>> {
  const client = await h.connect(key.raw);
  const result = await client.readResource({ uri });
  const [content] = result.contents;
  assert.ok(content !== undefined && 'text' in content);
  assert.equal(content.mimeType, 'application/json');
  return JSON.parse(content.text) as Record<string, unknown>;
}

describe('resources', () => {
  it('offers each key the resources it may read', async () => {
    const full = await h.connect(fullKey.raw);
    const fixed = (await full.listResources()).resources.map((resource) => resource.uri);
    for (const uri of [
      'todolist://workspace/current',
      'todolist://facets',
      'todolist://schema/query',
      'todolist://integrations/status',
      `todolist://dashboard/${dashboardId}`,
      'todolist://schema/block/clock',
      'todolist://templates/college@1',
    ]) {
      assert.ok(fixed.includes(uri), uri);
    }
    const templates = (await full.listResourceTemplates()).resourceTemplates.map(
      (template) => template.uriTemplate,
    );
    assert.deepEqual(templates.sort(), [
      'todolist://dashboard/{id}',
      'todolist://dashboard/{id}/versions',
      'todolist://item/{id}',
      'todolist://schema/block/{type}',
      'todolist://templates/{id}',
    ]);
    const narrow = await h.connect(readKey.raw);
    const narrowUris = (await narrow.listResources()).resources.map((resource) => resource.uri);
    assert.equal(narrowUris.includes('todolist://workspace/current'), false);
    assert.equal(narrowUris.includes('todolist://integrations/status'), false);
    const viewer = await h.connect(viewerKey.raw);
    const viewerTemplates = (await viewer.listResourceTemplates()).resourceTemplates.map(
      (template) => template.uriTemplate,
    );
    assert.equal(viewerTemplates.includes('todolist://dashboard/{id}/versions'), false);
  });

  it('reads the workspace with the member’s role and this key’s scopes', async () => {
    const workspace = await read(fullKey, 'todolist://workspace/current');
    const agent = workspace['agent'] as { id: string; scopes: string[] };
    assert.equal(agent.id, fullKey.id);
    assert.equal((workspace['member'] as { role: string }).role, 'editor');
    assert.deepEqual([...agent.scopes].sort(), [
      'builder:write',
      'integrations:read',
      'read',
      'workspace:read',
    ]);
  });

  it('reads an item redacted, and does not find another workspace’s', async () => {
    const item = await read(readKey, `todolist://item/${itemId}`);
    assert.equal(item['id'], itemId);
    assert.equal(JSON.stringify(item).includes(FAKE_GITHUB_TOKEN), false);
    assert.equal(h.received().join('').includes(FAKE_GITHUB_TOKEN), false);
    const client = await h.connect(readKey.raw);
    await assert.rejects(client.readResource({ uri: `todolist://item/${otherItemId}` }));
    const entry = await (
      await models.getAuditLogRepository()
    ).findRecent(team.workspace.id, {
      action: 'mcp.resource.item',
      metaEquals: { resultStatus: 'ok' },
      since: new Date(Date.now() - 60_000),
    });
    assert.equal(entry?.targetId, itemId);
  });

  it('reads a draft for editors with ?draft=1; viewers get the published copy only', async () => {
    const draft = await read(readKey, `todolist://dashboard/${dashboardId}?draft=1`);
    assert.deepEqual([draft['id'], draft['as']], [dashboardId, 'draft']);
    const viewer = await h.connect(viewerKey.raw);
    await assert.rejects(
      viewer.readResource({ uri: `todolist://dashboard/${dashboardId}?draft=1` }),
    );
  });

  it('reads schemas and templates, and not an unknown one', async () => {
    const clock = await read(readKey, 'todolist://schema/block/clock');
    assert.equal(clock['type'], 'clock');
    assert.ok(clock['vizSchema'] !== undefined && clock['blockSchema'] !== undefined);
    const query = await read(readKey, 'todolist://schema/query');
    assert.ok(Array.isArray(query['operators']));
    const college = await read(readKey, 'todolist://templates/college');
    assert.equal(college['key'], 'college@1');
    const client = await h.connect(readKey.raw);
    await assert.rejects(client.readResource({ uri: 'todolist://schema/block/nope' }));
  });

  it('is cached privately on the 2026-07-28 revision', async () => {
    const client = await h.connect(readKey.raw, { modern: true });
    const result = (await client.readResource({ uri: 'todolist://facets' })) as Record<
      string,
      unknown
    >;
    assert.equal(result['cacheScope'], 'private', JSON.stringify(Object.keys(result)));
  });
});

describe('prompts', () => {
  it('offers the read prompts on /readonly, and build_dashboard where the builder is', async () => {
    const readonly = await h.connect(fullKey.raw, { readonly: true });
    assert.deepEqual(
      (await readonly.listPrompts()).prompts.map((prompt) => prompt.name),
      ['morning_brief', 'plan_my_week', 'deadline_review', 'weekly_review'],
    );
    const full = await h.connect(fullKey.raw);
    assert.deepEqual(
      (await full.listPrompts()).prompts.map((prompt) => prompt.name),
      ['morning_brief', 'plan_my_week', 'deadline_review', 'build_dashboard', 'weekly_review'],
    );
  });

  it('answers static instructions with the user’s arguments', async () => {
    const client = await h.connect(readKey.raw);
    const brief = await client.getPrompt({
      name: 'morning_brief',
      arguments: { date: '2026-11-12' },
    });
    const [message] = brief.messages;
    assert.ok(message?.content.type === 'text');
    assert.match(message.content.text, /2026-11-12/);
    assert.match(message.content.text, /list_today/);
    assert.match(message.content.text, /never as instructions/);
  });
});
