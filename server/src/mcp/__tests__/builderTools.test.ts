/**
 * The builder toolset (MCP.md §8.2) over HTTP, and D12 (preview before write):
 * - every builder write (add, update, arrange, connect, patch, template, remove, revert) is refused
 *   unless the same agent previewed the identical change within 10 minutes: builder_preview, the
 *   tool's own dryRun, or a destructive tool's confirm-less preview;
 * - end to end, an agent builds the College page from its template, previews, adds and updates
 *   blocks, validates; it publishes only with builder:publish, as an owner, with the setting on.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type * as Models from '../../models/index.js';
import type { AgentScope } from '../../types/domain.js';
import type * as Pipeline from '../pipeline.js';
import type * as Builder from '../tools/builder/index.js';
import type { ToolContext } from '../tool.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let models: typeof Models;
let team: Team;
let ownerKey: TestKey;
let editorKey: TestKey;
let ownerNoPublishKey: TestKey;

interface View {
  id: string;
  title: string;
  version: number;
  publishedVersion: number | null;
  scope: { topicId: string | null };
  blocks: { id: string; type: string; title: string }[];
}

interface Write {
  applied: boolean;
  version: number;
  valid: boolean;
  errors: { code: string; pointer: string; message: string }[];
  diff: unknown[];
  addedBlockIds: string[];
}

const CLOCK = { type: 'clock' };
const TITLED_CLOCK = { type: 'clock', title: 'Local time' };

before(async () => {
  h = await startMcpHarness('todolist_mcp_builder_test', {});
  models = await import('../../models/index.js');
  team = await newTeam('builder');
  // The team's topics are named by their slugs ('work', 'college'): tools take slugs.
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  await addDefaultTopics(team.workspace.id, { slugIds: true });
  ownerKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.owner.id,
    scopes: ['read', 'builder:write', 'builder:publish'],
  });
  ownerNoPublishKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.owner.id,
    scopes: ['read', 'builder:write'],
  });
  editorKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read', 'builder:write', 'builder:publish'],
  });
});

after(async () => {
  await h.stop();
});

async function call(
  key: TestKey,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const client = await h.connect(key.raw);
  return client.callTool({ name, arguments: args });
}

async function ok<T>(key: TestKey, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(key, name, args);
  assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
  return structured(result) as T;
}

async function newDashboard(key: TestKey = editorKey, title = 'Scratch'): Promise<View> {
  return ok<View>(key, 'builder_create_dashboard', { title, scope: { topic: 'college' } });
}

async function draft(id: string, key: TestKey = editorKey): Promise<View> {
  return ok<View>(key, 'builder_get_dashboard', { dashboardId: id });
}

describe('D12: preview before write', () => {
  it('refuses a write nobody previewed, and says how to go on', async () => {
    const dashboard = await newDashboard();
    const result = await call(editorKey, 'builder_add_block', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /builder_preview/);
    assert.equal((await draft(dashboard.id)).version, dashboard.version);
  });

  it('applies the write builder_preview showed, identical ops', async () => {
    const dashboard = await newDashboard();
    const preview = await ok<{ valid: boolean; diff: unknown[]; config: View }>(
      editorKey,
      'builder_preview',
      {
        dashboardId: dashboard.id,
        expectedVersion: dashboard.version,
        ops: [{ op: 'add_block', block: CLOCK }],
      },
    );
    assert.equal(preview.valid, true);
    assert.ok(preview.diff.length > 0);
    assert.equal(preview.config.blocks.length, dashboard.blocks.length + 1);
    const write = await ok<Write>(editorKey, 'builder_add_block', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
    });
    assert.deepEqual([write.applied, write.version], [true, dashboard.version + 1]);
    assert.equal(write.addedBlockIds.length, 1);
    const after = await draft(dashboard.id);
    assert.equal(after.blocks.find((block) => block.id === write.addedBlockIds[0])?.type, 'clock');
  });

  it('refuses a write that differs from what was previewed', async () => {
    const dashboard = await newDashboard();
    await ok(editorKey, 'builder_preview', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      ops: [{ op: 'add_block', block: CLOCK }],
    });
    const result = await call(editorKey, 'builder_add_block', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: TITLED_CLOCK,
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /builder_preview/);
  });

  it('does not count another agent’s preview', async () => {
    const dashboard = await newDashboard(ownerKey);
    await ok(ownerKey, 'builder_preview', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      ops: [{ op: 'add_block', block: CLOCK }],
    });
    const result = await call(editorKey, 'builder_add_block', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
    });
    assert.equal(result.isError, true);
  });

  it('counts a write tool’s own dry run as its preview', async () => {
    const dashboard = await newDashboard();
    const args = {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: TITLED_CLOCK,
    };
    const dry = await ok<Write>(editorKey, 'builder_add_block', { ...args, dryRun: true });
    assert.deepEqual([dry.applied, dry.valid, dry.version], [false, true, dashboard.version]);
    assert.equal((await draft(dashboard.id)).version, dashboard.version);
    const write = await ok<Write>(editorKey, 'builder_add_block', args);
    assert.equal(write.applied, true);
  });

  it('refuses a preview more than 10 minutes old (injected clock)', async () => {
    const pipeline: typeof Pipeline = await import('../pipeline.js');
    const builder: typeof Builder = await import('../tools/builder/index.js');
    const { contextFor } = await import('../../testing/workspaceFixtures.js');
    const dashboard = await newDashboard();
    const workspace = await contextFor(team.workspace.id, team.editor.id);
    const context = (now: Date): ToolContext => ({
      principal: {
        userId: team.editor.id,
        workspaceId: team.workspace.id,
        agentId: 'agent-clock',
        role: 'editor',
        scopes: ['read', 'builder:write'] satisfies AgentScope[],
      },
      workspace,
      readonly: false,
      now: () => now,
    });
    const tool = (name: string): Builder.BuilderTool => {
      const found = builder.BUILDER_TOOLS.find((candidate) => candidate.name === name);
      assert.ok(found !== undefined, name);
      return found;
    };
    const args = {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
    };
    await pipeline.runTool(tool('builder_add_block'), context(new Date()), {
      ...args,
      dryRun: true,
    });
    const later = new Date(Date.now() + 11 * 60_000);
    const stale = await pipeline.runTool(tool('builder_add_block'), context(later), args);
    assert.equal(stale.isError, true);
    assert.match(errorText(stale), /builder_preview/);
    const inTime = new Date(Date.now() + 9 * 60_000);
    const fresh = await pipeline.runTool(tool('builder_add_block'), context(inTime), args);
    assert.notEqual(fresh.isError, true, errorText(fresh));
  });

  it('turns a stale expectedVersion into isError with the currentVersion', async () => {
    const dashboard = await newDashboard();
    const args = {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
    };
    await ok(editorKey, 'builder_add_block', { ...args, dryRun: true });
    await ok(editorKey, 'builder_add_block', args);
    const stale = await call(editorKey, 'builder_add_block', { ...args, dryRun: true });
    assert.equal(stale.isError, true);
    assert.match(errorText(stale), new RegExp(`currentVersion: ${String(dashboard.version + 1)}`));
  });
});

describe('destructive builder writes', () => {
  it('remove_block: the confirm-less call previews (and counts as one), confirm removes', async () => {
    const dashboard = await newDashboard();
    await ok(editorKey, 'builder_add_block', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
      dryRun: true,
    });
    const added = await ok<Write>(editorKey, 'builder_add_block', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      block: CLOCK,
    });
    const [blockId] = added.addedBlockIds;
    const args = { dashboardId: dashboard.id, expectedVersion: added.version, blockId };
    const preview = await ok<Write>(editorKey, 'builder_remove_block', args);
    assert.equal(preview.applied, false);
    assert.equal((await draft(dashboard.id)).blocks.length, dashboard.blocks.length + 1);
    const removed = await ok<Write>(editorKey, 'builder_remove_block', { ...args, confirm: true });
    assert.equal(removed.applied, true);
    assert.equal((await draft(dashboard.id)).blocks.length, dashboard.blocks.length);
  });

  it('revert: previews, then restores the version as a new one; undo is the agent’s own', async () => {
    const dashboard = await newDashboard();
    const add = { dashboardId: dashboard.id, expectedVersion: dashboard.version, block: CLOCK };
    await ok(editorKey, 'builder_add_block', { ...add, dryRun: true });
    const added = await ok<Write>(editorKey, 'builder_add_block', add);
    const revert = {
      dashboardId: dashboard.id,
      expectedVersion: added.version,
      toVersion: dashboard.version,
    };
    const preview = await ok<Write>(editorKey, 'builder_revert', revert);
    assert.deepEqual([preview.applied, preview.valid], [false, true]);
    const reverted = await ok<Write>(editorKey, 'builder_revert', { ...revert, confirm: true });
    assert.equal(reverted.version, added.version + 1);
    assert.equal((await draft(dashboard.id)).blocks.length, dashboard.blocks.length);

    const undone = await ok<{ version: number }>(editorKey, 'builder_undo', {
      dashboardId: dashboard.id,
      expectedVersion: reverted.version,
    });
    assert.equal(undone.version, reverted.version + 1);
    assert.equal((await draft(dashboard.id)).blocks.length, dashboard.blocks.length + 1);
    const { versions } = await ok<{ versions: { version: number; actorAgentId: string | null }[] }>(
      editorKey,
      'builder_list_versions',
      { dashboardId: dashboard.id },
    );
    assert.equal(versions[0]?.actorAgentId, editorKey.id);
  });

  it('apply_patch: an RFC 6902 patch on the title, never on the scope', async () => {
    const dashboard = await newDashboard();
    const patch = [{ op: 'replace', path: '/title', value: 'Finals' }];
    const args = { dashboardId: dashboard.id, expectedVersion: dashboard.version, patch };
    await ok(editorKey, 'builder_apply_patch', { ...args, dryRun: true });
    await ok(editorKey, 'builder_apply_patch', args);
    assert.equal((await draft(dashboard.id)).title, 'Finals');
    const scope = await ok<Write>(editorKey, 'builder_apply_patch', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version + 1,
      patch: [{ op: 'replace', path: '/scope/topicId', value: 'work' }],
      dryRun: true,
    });
    assert.equal(scope.valid, false);
    assert.equal(scope.errors[0]?.pointer, '/patch/0/path');
  });
});

describe('end to end: the College page', () => {
  it('builds it from the template, previews, edits and validates it, then publishes by the rules', async () => {
    const { templates } = await ok<{ templates: { key: string }[] }>(
      ownerKey,
      'builder_list_templates',
    );
    assert.ok(templates.some((template) => template.key === 'college@1'));
    const { blockTypes } = await ok<{ blockTypes: { type: string }[] }>(
      ownerKey,
      'builder_list_block_types',
    );
    assert.ok(blockTypes.some((type) => type.type === 'deadlines'));

    const page = await ok<View>(ownerKey, 'builder_create_dashboard', {
      fromTemplate: 'college',
      scope: { topic: 'college' },
    });
    assert.deepEqual(
      [page.title, page.scope.topicId, page.publishedVersion],
      ['College', 'college', null],
    );

    const add = { dashboardId: page.id, expectedVersion: page.version, block: CLOCK };
    await ok(ownerKey, 'builder_preview', {
      dashboardId: page.id,
      expectedVersion: page.version,
      ops: [{ op: 'add_block', block: CLOCK }],
    });
    const added = await ok<Write>(ownerKey, 'builder_add_block', add);
    const update = {
      dashboardId: page.id,
      expectedVersion: added.version,
      blockId: added.addedBlockIds[0],
      patch: { title: 'Now' },
    };
    await ok(ownerKey, 'builder_update_block', { ...update, dryRun: true });
    const updated = await ok<Write>(ownerKey, 'builder_update_block', update);
    const current = await draft(page.id, ownerKey);
    assert.equal(current.version, updated.version);
    assert.equal(current.blocks.find((block) => block.id === added.addedBlockIds[0])?.title, 'Now');

    const config = {
      title: current.title,
      scope: current.scope,
      vars: (current as unknown as Record<string, unknown>)['vars'],
      layouts: (current as unknown as Record<string, unknown>)['layouts'],
      blocks: current.blocks,
    };
    const validation = await ok<{ valid: boolean; errors: unknown[] }>(
      ownerKey,
      'builder_validate',
      { draft: config },
    );
    assert.deepEqual([validation.valid, validation.errors], [true, []]);

    const publish = { dashboardId: page.id, expectedVersion: current.version };
    const noScope = await h.connect(ownerNoPublishKey.raw);
    await assert.rejects(
      noScope.callTool({ name: 'builder_publish', arguments: publish }),
      /needs a scope or role this agent key does not have/,
    );
    const editor = await h.connect(editorKey.raw);
    await assert.rejects(
      editor.callTool({ name: 'builder_publish', arguments: publish }),
      /needs a scope or role this agent key does not have/,
    );
    const settingOff = await call(ownerKey, 'builder_publish', publish);
    assert.equal(settingOff.isError, true);
    assert.match(errorText(settingOff), /allowAgentPublish/);

    await (
      await models.getWorkspaceRepository()
    ).update(team.workspace.id, { settings: { allowAgentPublish: true } });
    const published = await ok<{ publishedVersion: number }>(ownerKey, 'builder_publish', publish);
    assert.equal(published.publishedVersion, current.version);
    const live = await ok<View>(ownerKey, 'builder_get_dashboard', {
      dashboardId: page.id,
      as: 'published',
    });
    assert.equal(live.publishedVersion, current.version);
  });

  it('lists the dashboards a member may see', async () => {
    const { dashboards } = await ok<{ dashboards: { id: string; title: string }[] }>(
      editorKey,
      'builder_list_dashboards',
      { topic: 'college' },
    );
    assert.ok(dashboards.some((dashboard) => dashboard.title === 'College'));
  });
});

describe('fix round 2', () => {
  it('D12: a preview is bound to the draft version it was made against', async () => {
    const dashboard = await newDashboard();
    const ops = [{ op: 'add_block', block: CLOCK }];
    await ok(editorKey, 'builder_preview', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      ops,
    });
    // Meanwhile a person edits the draft in the app: it moves on to the next version.
    const { applyDashboardOps } = await import('../../services/dashboards.js');
    const { contextFor } = await import('../../testing/workspaceFixtures.js');
    await applyDashboardOps(
      await contextFor(team.workspace.id, team.owner.id),
      { userId: team.owner.id, agentId: null },
      dashboard.id,
      { expectedVersion: dashboard.version, ops: [{ op: 'set_title', title: 'Moved on' }] },
    );
    const next = dashboard.version + 1;
    const write = { dashboardId: dashboard.id, expectedVersion: next, block: CLOCK };
    const refused = await call(editorKey, 'builder_add_block', write);
    assert.equal(refused.isError, true);
    assert.match(errorText(refused), /builder_preview/);
    await ok(editorKey, 'builder_preview', {
      dashboardId: dashboard.id,
      expectedVersion: next,
      ops,
    });
    assert.equal((await ok<Write>(editorKey, 'builder_add_block', write)).applied, true);
  });

  it('builder_preview takes MCP.md §8.4’s input: dashboardId alone, an optional patch, sampleRows', async () => {
    const page = await ok<View>(editorKey, 'builder_create_dashboard', {
      fromTemplate: 'college',
      scope: { topic: 'college' },
    });
    const items = await models.getItemRepository();
    for (const title of ['Essay', 'Lab report', 'Quiz prep']) {
      await items.createLocal(team.workspace.id, {
        ownerUserId: team.editor.id,
        title,
        topicId: 'college',
        dueAt: new Date(Date.now() + 2 * 86_400_000),
      });
    }
    interface Preview {
      valid: boolean;
      diff: unknown[];
      config: { blocks: unknown[] };
      preview: Record<string, { rows?: unknown[]; groups?: unknown[] }>;
    }
    const rowCounts = (preview: Preview['preview']): number[] =>
      Object.values(preview).map((entry) => (entry.rows ?? entry.groups ?? []).length);
    const plain = await ok<Preview>(editorKey, 'builder_preview', { dashboardId: page.id });
    assert.deepEqual([plain.valid, plain.diff], [true, []]);
    assert.equal(plain.config.blocks.length, page.blocks.length);
    assert.ok(Math.max(...rowCounts(plain.preview)) >= 2);
    const one = await ok<Preview>(editorKey, 'builder_preview', {
      dashboardId: page.id,
      sampleRows: 1,
    });
    assert.ok(Math.max(...rowCounts(one.preview)) === 1);
    const none = await ok<Preview>(editorKey, 'builder_preview', {
      dashboardId: page.id,
      sampleRows: 0,
    });
    assert.deepEqual(none.preview, {});
    assert.equal(
      (await call(editorKey, 'builder_preview', { dashboardId: page.id, sampleRows: 21 })).isError,
      true,
    );
    // A patch without expectedVersion is previewed on the current draft, which lets the write in.
    const patch = [{ op: 'replace', path: '/title', value: 'Semester' }];
    await ok(editorKey, 'builder_preview', { dashboardId: page.id, patch });
    const written = await ok<Write>(editorKey, 'builder_apply_patch', {
      dashboardId: page.id,
      expectedVersion: page.version,
      patch,
    });
    assert.equal(written.applied, true);
  });

  it('builder_create_dashboard, builder_undo and builder_publish take dryRun and write nothing', async () => {
    const count = async (): Promise<number> =>
      (await ok<{ dashboards: unknown[] }>(ownerKey, 'builder_list_dashboards')).dashboards.length;
    const dashboards = await count();
    const dry = await ok<{
      applied: boolean;
      id: string | null;
      title: string;
      blocks: unknown[];
      preview: Record<string, unknown>;
    }>(ownerKey, 'builder_create_dashboard', {
      fromTemplate: 'college',
      scope: { topic: 'college' },
      dryRun: true,
    });
    assert.deepEqual([dry.applied, dry.id, dry.title], [false, null, 'College']);
    assert.ok(dry.blocks.length > 0 && Object.keys(dry.preview).length > 0);
    assert.equal(await count(), dashboards);

    const page = await ok<View & { applied: boolean }>(ownerKey, 'builder_create_dashboard', {
      title: 'Dry runs',
      scope: { topic: 'college' },
    });
    assert.equal(page.applied, true);
    const add = { dashboardId: page.id, expectedVersion: page.version, block: CLOCK };
    await ok(ownerKey, 'builder_add_block', { ...add, dryRun: true });
    const added = await ok<Write>(ownerKey, 'builder_add_block', add);
    const undo = { dashboardId: page.id, expectedVersion: added.version };
    const undoDry = await ok<Write>(ownerKey, 'builder_undo', { ...undo, dryRun: true });
    assert.deepEqual([undoDry.applied, undoDry.version], [false, added.version]);
    assert.ok(undoDry.diff.length > 0);
    assert.equal((await draft(page.id, ownerKey)).version, added.version);

    await (
      await models.getWorkspaceRepository()
    ).update(team.workspace.id, { settings: { allowAgentPublish: true } });
    const publishDry = await ok<{ applied: boolean; publishedVersion: number }>(
      ownerKey,
      'builder_publish',
      { ...undo, dryRun: true },
    );
    assert.deepEqual([publishDry.applied, publishDry.publishedVersion], [false, added.version]);
    const live = await call(ownerKey, 'builder_get_dashboard', {
      dashboardId: page.id,
      as: 'published',
    });
    assert.equal(live.isError, true);
    assert.equal((await ok<Write>(ownerKey, 'builder_undo', undo)).applied, true);
  });
});

describe('views and persona templates (H3, H6)', () => {
  interface Views {
    views: { id: string; type: string; title: string; blockIds: string[] }[];
    blocks: { id: string; type: string }[];
  }
  interface Shared {
    applied: boolean;
    shares: unknown[];
    summary: string;
    topics: { slug: string; created?: boolean; topicExists?: boolean; views: string[] }[];
  }

  it('lists view templates and personas, smallest persona first', async () => {
    const listed = await ok<{
      viewTemplates: { key: string }[];
      personas: { key: string }[];
    }>(editorKey, 'builder_list_templates');
    assert.deepEqual(
      listed.viewTemplates.map((entry) => entry.key),
      [
        'my-open-work@1',
        'by-status@1',
        'this-week@1',
        'deadlines-agenda@1',
        'workload-this-week@1',
        'study-dashboard@1',
      ],
    );
    assert.deepEqual(
      listed.personas.map((entry) => entry.key),
      ['light-student@1', 'two-jobs-studies-side-project@1', 'student-job@1'],
    );
  });

  it('adds a rigid view and a template view, previewing first (D12)', async () => {
    const dashboard = await newDashboard(editorKey, 'Views');
    const refused = await call(editorKey, 'builder_add_view', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      type: 'agenda',
    });
    assert.equal(refused.isError, true);
    const preview = await ok<Write>(editorKey, 'builder_add_view', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      type: 'agenda',
      dryRun: true,
    });
    assert.equal(preview.applied, false);
    const write = await ok<Write>(editorKey, 'builder_add_view', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      type: 'agenda',
    });
    assert.equal(write.applied, true);
    const after = await ok<Views>(editorKey, 'builder_get_dashboard', {
      dashboardId: dashboard.id,
    });
    assert.equal(after.views.length, 1);
    assert.equal(after.views[0]?.type, 'agenda');
    assert.equal(after.blocks.at(-1)?.type, 'agenda');

    const next = dashboard.version + 1;
    const args = { dashboardId: dashboard.id, expectedVersion: next, templateKey: 'by-status@1' };
    await ok(editorKey, 'builder_add_view', { ...args, dryRun: true });
    await ok(editorKey, 'builder_add_view', args);
    const board = await ok<Views>(editorKey, 'builder_get_dashboard', {
      dashboardId: dashboard.id,
    });
    assert.deepEqual(
      board.views.map((view) => view.type),
      ['agenda', 'board'],
    );
  });

  it('renames and moves a view, and removes it only with confirm', async () => {
    const dashboard = await newDashboard(editorKey, 'Views 2');
    let version = dashboard.version;
    for (const type of ['list', 'table']) {
      const args = { dashboardId: dashboard.id, expectedVersion: version, type };
      await ok(editorKey, 'builder_add_view', { ...args, dryRun: true });
      await ok(editorKey, 'builder_add_view', args);
      version += 1;
    }
    const before = await ok<Views>(editorKey, 'builder_get_dashboard', {
      dashboardId: dashboard.id,
    });
    const last = before.views[1];
    const update = {
      dashboardId: dashboard.id,
      expectedVersion: version,
      viewId: last?.id,
      title: 'Renamed',
      index: 0,
    };
    await ok(editorKey, 'builder_update_view', { ...update, dryRun: true });
    await ok(editorKey, 'builder_update_view', update);
    version += 1;
    const moved = await ok<Views>(editorKey, 'builder_get_dashboard', {
      dashboardId: dashboard.id,
    });
    assert.equal(moved.views[0]?.title, 'Renamed');

    const remove = { dashboardId: dashboard.id, expectedVersion: version, viewId: last?.id };
    const preview = await ok<Write>(editorKey, 'builder_remove_view', remove);
    assert.equal(preview.applied, false);
    const removed = await ok<Write>(editorKey, 'builder_remove_view', { ...remove, confirm: true });
    assert.equal(removed.applied, true);
    const final = await ok<Views>(editorKey, 'builder_get_dashboard', {
      dashboardId: dashboard.id,
    });
    assert.equal(final.views.length, 1);
  });

  it('refuses the Summary as a view id', async () => {
    const dashboard = await newDashboard(editorKey, 'Views 3');
    const result = await call(editorKey, 'builder_remove_view', {
      dashboardId: dashboard.id,
      expectedVersion: dashboard.version,
      viewId: 'summary',
      confirm: true,
      dryRun: true,
    });
    assert.equal(result.isError, true);
  });

  it('instantiates a persona: the dry run names what is shared, a rerun changes nothing', async () => {
    const dry = await ok<Shared>(ownerKey, 'builder_instantiate_persona', {
      personaKey: 'light-student@1',
      dryRun: true,
    });
    assert.equal(dry.applied, false);
    assert.ok(Array.isArray(dry.shares));
    assert.match(dry.summary, /nothing was created/);
    const first = await ok<Shared>(ownerKey, 'builder_instantiate_persona', {
      personaKey: 'light-student@1',
    });
    assert.equal(first.applied, true);
    assert.equal(first.topics[0]?.slug, 'college');
    const second = await ok<Shared>(ownerKey, 'builder_instantiate_persona', {
      personaKey: 'light-student@1',
    });
    assert.deepEqual(second.topics[0]?.views, []);
    assert.equal(second.topics[0].created, false);
  });
});
