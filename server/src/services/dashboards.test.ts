/**
 * services/dashboards.ts on a throwaway MongoDB: versions and concurrency (Review focus 5), undo,
 * redo, revert, pruning, publish, roles, the published copy for viewers, and lint in mcp mode.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { addDefaultTopics, contextFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import type { DashboardDraft, Op } from '../types/builder.js';
import type {
  DashboardDryRunResult,
  DashboardView,
  DashboardWriteResult,
} from '../types/dashboards.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type * as Dashboards from '../testing/dashboardCalls.js';
import type * as Models from '../models/index.js';

let db: TestDatabase;
let svc: typeof Dashboards;
let models: typeof Models;

interface Actor {
  userId: string;
  agentId: string | null;
}

const ctx = {} as Record<'owner' | 'editor' | 'viewer' | 'viewer2', WorkspaceContext>;
const actor = {} as Record<
  'owner' | 'editor' | 'viewer' | 'viewer2' | 'agent' | 'otherAgent',
  Actor
>;
let workspaceId = '';

before(async () => {
  db = await startTestDatabase('todolist_dashboards_service');
  svc = await import('../testing/dashboardCalls.js');
  models = await import('../models/index.js');
  const owner = await newUser('dash-owner');
  const editor = await newUser('dash-editor');
  const viewer = await newUser('dash-viewer');
  const viewer2 = await newUser('dash-viewer2');
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Dashboards', slug: 'dashboards-svc', ownerId: owner.id });
  workspaceId = workspace.id;
  // Its topics are named by their slugs here: 'work', 'college', 'personal'.
  await addDefaultTopics(workspace.id, { slugIds: true });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: owner.id, role: 'owner' });
  await memberships.create(workspace.id, { userId: editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: viewer.id, role: 'viewer' });
  await memberships.create(workspace.id, { userId: viewer2.id, role: 'viewer' });
  ctx.owner = await contextFor(workspace.id, owner.id);
  ctx.editor = await contextFor(workspace.id, editor.id);
  ctx.viewer = await contextFor(workspace.id, viewer.id);
  ctx.viewer2 = await contextFor(workspace.id, viewer2.id);
  actor.owner = { userId: owner.id, agentId: null };
  actor.editor = { userId: editor.id, agentId: null };
  actor.viewer = { userId: viewer.id, agentId: null };
  actor.viewer2 = { userId: viewer2.id, agentId: null };
  // Agents act for a person: the owner's agent keys.
  actor.agent = { userId: owner.id, agentId: 'agent-key-1' };
  actor.otherAgent = { userId: owner.id, agentId: 'agent-key-2' };

  const items = await models.getItemRepository();
  for (let index = 0; index < 8; index += 1) {
    await items.createLocal(workspace.id, {
      ownerUserId: owner.id,
      title: `Task ${String(index)}`,
      topicId: 'work',
      dueAt: new Date(Date.now() + (index + 1) * 60 * 60 * 1000),
    });
  }
});

after(async () => {
  await db.stop();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function written(result: Dashboards.DashboardOpsResult): DashboardWriteResult {
  assert.ok('version' in result, 'expected a write');
  return result;
}

function dryRun(result: Dashboards.DashboardOpsResult): DashboardDryRunResult {
  assert.ok('valid' in result, 'expected a dry run');
  return result;
}

async function blank(by: Actor = actor.editor, context = ctx.editor): Promise<DashboardView> {
  return svc.createDashboard(context, by, { title: 'Blank', language: 'en' });
}

async function edit(
  id: string,
  expectedVersion: number,
  ops: Op[],
  by: Actor = actor.editor,
  context = ctx.editor,
): Promise<number> {
  const result = written(await svc.applyDashboardOps(context, by, id, { expectedVersion, ops }));
  return result.version;
}

function content(view: DashboardView): Omit<DashboardDraft, 'scope'> {
  return { title: view.title, vars: view.vars, layouts: view.layouts, blocks: view.blocks };
}

async function draft(id: string): Promise<DashboardView> {
  return svc.getDashboard(ctx.owner, actor.owner, id, { as: 'draft' });
}

async function versionNumbers(id: string): Promise<number[]> {
  const versions = await models.getDashboardVersionRepository();
  return (await versions.list(workspaceId, id, 500))
    .map((entry) => entry.version)
    .sort((a, b) => a - b);
}

const addNote: Op = { op: 'add_block', block: { type: 'note', note: 'hello' } };
const rename = (title: string): Op => ({ op: 'set_title', title });

// ─── Create, read, list ─────────────────────────────────────────────────────

describe('createDashboard', () => {
  it('starts at version 1 with a full snapshot; an owner in the UI publishes at once', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.owner, {
      fromTemplate: 'dashboard@1',
      language: 'en',
    });
    assert.equal(view.version, 1);
    assert.equal(view.title, 'Dashboard');
    assert.equal(view.templateKey, 'dashboard@1');
    assert.equal(view.publishedVersion, 1);
    const versions = await models.getDashboardVersionRepository();
    const first = await versions.findByVersion(workspaceId, view.id, 1);
    assert.ok(first);
    assert.deepEqual(first.snapshot, {
      title: view.title,
      scope: view.scope,
      vars: view.vars,
      layouts: view.layouts,
      blocks: view.blocks,
    });
    assert.equal(first.actorUserId, actor.owner.userId);
    const published = await svc.getDashboard(ctx.viewer, actor.viewer, view.id, {});
    assert.equal(published.as, 'published');
    assert.deepEqual(content(published), content(view));
    const audit = await (
      await models.getAuditLogRepository()
    ).list(workspaceId, { action: 'dashboard.create' }, 10);
    assert.ok(audit.some((entry) => entry.targetId === view.id));
  });

  it('editors and agents create drafts only', async () => {
    const byEditor = await blank();
    assert.equal(byEditor.publishedVersion, null);
    const byAgent = await svc.createDashboard(ctx.owner, actor.agent, {
      fromTemplate: 'work',
      language: 'he',
    });
    assert.equal(byAgent.publishedVersion, null);
    assert.equal(byAgent.title, 'עבודה');
    assert.equal(byAgent.updatedBy.agentId, 'agent-key-1');
  });

  it('takes a scope override, and needs a title or a known template', async () => {
    const page = await svc.createDashboard(ctx.editor, actor.editor, {
      fromTemplate: 'project@1',
      scope: { topicId: 'work' },
      language: 'en',
    });
    assert.deepEqual(page.scope, {
      topicId: 'work',
      containerId: null,
      page: 'group',
      groupVar: 'project',
    });
    // A group page (blank, or overriding the template) names its variable.
    await assert.rejects(
      svc.createDashboard(ctx.editor, actor.editor, {
        title: 'Group',
        scope: { topicId: 'work', page: 'group' },
        language: 'en',
      }),
      (error: unknown) =>
        hasStatus(400)(error) && (error as { pointer?: string }).pointer === '/scope/groupVar',
    );
    const blankGroup = await svc.createDashboard(ctx.editor, actor.editor, {
      title: 'Group',
      scope: { topicId: 'work', page: 'group', groupVar: 'client' },
      language: 'en',
    });
    assert.deepEqual(blankGroup.scope, {
      topicId: 'work',
      containerId: null,
      page: 'group',
      groupVar: 'client',
    });
    assert.equal((await draft(blankGroup.id)).scope.groupVar, 'client');
    await assert.rejects(
      svc.createDashboard(ctx.editor, actor.editor, { language: 'en' }),
      (error: unknown) =>
        error instanceof Error && (error as { pointer?: string }).pointer === '/title',
    );
    await assert.rejects(
      svc.createDashboard(ctx.editor, actor.editor, { fromTemplate: 'nope', language: 'en' }),
      (error: unknown) =>
        error instanceof Error && (error as { pointer?: string }).pointer === '/fromTemplate',
    );
  });

  it('a group page needs a topic: project@1 has none, so the caller passes it', async () => {
    const needsArea = (error: unknown): boolean =>
      hasStatus(400)(error) &&
      (error as { pointer?: string }).pointer === '/scope/topicId' &&
      (error as Error).message.includes('scope.topicId required');
    await assert.rejects(
      svc.createDashboard(ctx.editor, actor.editor, { fromTemplate: 'project', language: 'en' }),
      needsArea,
    );
    await assert.rejects(
      svc.createDashboard(ctx.editor, actor.editor, {
        title: 'Group',
        scope: { page: 'group', groupVar: 'client' },
        language: 'en',
      }),
      needsArea,
    );
    await assert.rejects(
      svc.instantiateDashboard(ctx.editor, actor.editor, {
        templateKey: 'project@1',
        language: 'en',
      }),
      needsArea,
    );
    const personal = await svc.instantiateDashboard(ctx.editor, actor.editor, {
      templateKey: 'project@1',
      language: 'he',
      scope: { topicId: 'personal' },
    });
    assert.deepEqual(personal.scope, {
      topicId: 'personal',
      containerId: null,
      page: 'group',
      groupVar: 'project',
    });
    // A group template belongs to the topic it is made in.
    const course = await svc.createDashboard(ctx.editor, actor.editor, {
      fromTemplate: 'college-course@1',
      language: 'en',
      scope: { topicId: 'college' },
    });
    assert.equal(course.scope.topicId, 'college');
    // A topic that is not this workspace's is refused.
    await assert.rejects(
      svc.createDashboard(ctx.editor, actor.editor, {
        fromTemplate: 'work@1',
        language: 'en',
        scope: { topicId: 'not-a-topic' },
      }),
      hasStatus(400),
    );
  });

  it('viewers cannot create (403)', async () => {
    await assert.rejects(
      svc.createDashboard(ctx.viewer, actor.viewer, { title: 'Mine', language: 'en' }),
      hasStatus(403),
    );
  });
});

describe('getDashboard and listDashboards', () => {
  it('viewers see the published copy only; an unpublished dashboard is 404 for them', async () => {
    const view = await blank();
    await assert.rejects(svc.getDashboard(ctx.viewer, actor.viewer, view.id, {}), hasStatus(404));
    await assert.rejects(
      svc.getDashboard(ctx.viewer, actor.viewer, view.id, { as: 'draft' }),
      hasStatus(404),
    );
    assert.ok(
      !(await svc.listDashboards(ctx.viewer, actor.viewer, {})).some((d) => d.id === view.id),
    );
    assert.ok(
      (await svc.listDashboards(ctx.editor, actor.editor, {})).some((d) => d.id === view.id),
    );
    // Editors get the draft, or the published copy when asked (404 until there is one).
    assert.equal((await svc.getDashboard(ctx.editor, actor.editor, view.id, {})).as, 'draft');
    await assert.rejects(
      svc.getDashboard(ctx.editor, actor.editor, view.id, { as: 'published' }),
      hasStatus(404),
    );

    await svc.publishDashboard(ctx.owner, actor.owner, view.id, { expectedVersion: 1 });
    await edit(view.id, 1, [rename('Draft only')]);
    const seen = await svc.getDashboard(ctx.viewer, actor.viewer, view.id, { as: 'draft' });
    assert.equal(seen.as, 'published');
    assert.equal(seen.title, 'Blank');
    assert.equal(seen.publishedVersion, 1);
    const listed = (await svc.listDashboards(ctx.viewer, actor.viewer, {})).find(
      (d) => d.id === view.id,
    );
    assert.equal(listed?.title, 'Blank');
    assert.equal((await draft(view.id)).title, 'Draft only');
  });

  it('every member sees the dashboards of every topicId: a workspace is shared whole', async () => {
    const work = await svc.createDashboard(ctx.owner, actor.owner, {
      fromTemplate: 'work',
      language: 'en',
    });
    const main = await svc.createDashboard(ctx.owner, actor.owner, {
      title: 'Main',
      language: 'en',
    });
    assert.equal((await svc.getDashboard(ctx.viewer2, actor.viewer2, work.id, {})).title, 'Work');
    assert.equal((await svc.getDashboard(ctx.viewer2, actor.viewer2, main.id, {})).title, 'Main');
    const listed = await svc.listDashboards(ctx.viewer2, actor.viewer2, {});
    assert.ok(listed.some((d) => d.id === main.id));
    assert.ok(listed.some((d) => d.id === work.id));
  });

  it('a private dashboard is its owner’s alone', async () => {
    const dashboards = await models.getDashboardRepository();
    const mine = await dashboards.create(workspaceId, {
      ownerUserId: actor.editor.userId,
      title: 'Mine',
      visibility: 'private',
    });
    assert.equal((await svc.getDashboard(ctx.editor, actor.editor, mine.id, {})).title, 'Mine');
    await assert.rejects(svc.getDashboard(ctx.owner, actor.owner, mine.id, {}), hasStatus(404));
    await assert.rejects(
      svc.applyDashboardOps(ctx.owner, actor.owner, mine.id, {
        expectedVersion: 1,
        ops: [rename('x')],
      }),
      hasStatus(404),
    );
  });

  it('filters the list by topic and page', async () => {
    const page = await svc.createDashboard(ctx.owner, actor.owner, {
      fromTemplate: 'college-course',
      language: 'en',
      scope: { topicId: 'college' },
    });
    const groups = await svc.listDashboards(ctx.owner, actor.owner, {
      topicId: 'college',
      page: 'group',
    });
    assert.ok(groups.some((d) => d.id === page.id));
    assert.ok(groups.every((d) => d.scope.topicId === 'college' && d.scope.page === 'group'));
    const mains = await svc.listDashboards(ctx.owner, actor.owner, { topicId: null });
    assert.ok(mains.every((d) => d.scope.topicId === null));
  });
});

// ─── Ops: versions, concurrency, dry runs, lint ─────────────────────────────

describe('applyDashboardOps', () => {
  it('bumps the version and records the patch, the inverse, the actor and a summary', async () => {
    const view = await blank();
    const result = written(
      await svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        ops: [{ op: 'add_block', block: { type: 'deadlines', title: 'Due' } }],
      }),
    );
    assert.equal(result.version, 2);
    const entry = await (
      await models.getDashboardVersionRepository()
    ).findByVersion(workspaceId, view.id, 2);
    assert.ok(entry);
    assert.equal(entry.summary, 'add_block deadlines');
    assert.equal(entry.actorUserId, actor.editor.userId);
    assert.equal(entry.actorAgentId, null);
    assert.equal(entry.snapshot, null);
    assert.ok(entry.patch.length > 0 && entry.inverse.length > 0);
    const after = await draft(view.id);
    assert.equal(after.version, 2);
    assert.equal(after.blocks[0]?.title, 'Due');
    const audit = await (
      await models.getAuditLogRepository()
    ).list(workspaceId, { action: 'dashboard.update' }, 50);
    assert.ok(audit.some((e) => e.targetId === view.id && e.meta['version'] === 2));
  });

  it('a stale expectedVersion is a 409 with the current version, and writes nothing', async () => {
    const view = await blank();
    await edit(view.id, 1, [rename('First')]);
    await assert.rejects(
      svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        ops: [rename('Stale')],
      }),
      (error: unknown) =>
        hasStatus(409)(error) && (error as { currentVersion?: number }).currentVersion === 2,
    );
    assert.equal((await draft(view.id)).title, 'First');
    assert.deepEqual(await versionNumbers(view.id), [1, 2]);
  });

  it('concurrent edits on one version: exactly one lands, the other gets 409 (Review focus 5)', async () => {
    const view = await blank();
    const results = await Promise.allSettled([
      svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        ops: [{ op: 'arrange', layouts: { lg: [] } }, rename('From the UI')],
      }),
      svc.applyDashboardOps(ctx.owner, actor.agent, view.id, {
        expectedVersion: 1,
        ops: [rename('From an agent')],
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const [loser] = rejected;
    assert.ok(hasStatus(409)(loser?.reason));
    assert.equal((loser?.reason as { currentVersion?: number }).currentVersion, 2);
    const winnerTitle = results[0].status === 'fulfilled' ? 'From the UI' : 'From an agent';
    assert.equal((await draft(view.id)).title, winnerTitle);
    assert.deepEqual(await versionNumbers(view.id), [1, 2]);
  });

  it('dryRun validates, diffs and previews, and writes nothing', async () => {
    const view = await blank();
    const before = await draft(view.id);
    const result = dryRun(
      await svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        dryRun: true,
        ops: [
          {
            op: 'add_block',
            block: {
              type: 'list',
              query: {
                source: 'items',
                where: {
                  combinator: 'and',
                  rules: [{ field: 'topic', operator: '=', value: 'work' }],
                },
              },
            },
          },
        ],
      }),
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.diff.length > 0);
    const [preview] = Object.values(result.preview);
    assert.ok(preview && 'rows' in preview);
    assert.equal(preview.rows.length, 8);
    assert.equal(preview.total, 8);
    const afterwards = await draft(view.id);
    assert.deepEqual(afterwards, before);
    assert.deepEqual(await versionNumbers(view.id), [1]);
  });

  it('a preview refuses a props path the workspace never synced, as saving would', async () => {
    const view = await blank();
    const result = dryRun(
      await svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        dryRun: true,
        ops: [
          {
            op: 'add_block',
            block: {
              type: 'list',
              query: {
                source: 'items',
                where: {
                  combinator: 'and',
                  rules: [{ field: 'props.jira.neverSynced', operator: '=', value: 1 }],
                },
              },
            },
          },
        ],
      }),
    );
    const [preview] = Object.values(result.preview);
    assert.ok(preview && 'error' in preview, 'the preview reports the refused field');
  });

  it('agents get at most 5 preview rows', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.agent, {
      title: 'Agent',
      language: 'en',
    });
    const result = dryRun(
      await svc.applyDashboardOps(ctx.owner, actor.agent, view.id, {
        expectedVersion: 1,
        dryRun: true,
        ops: [
          { op: 'add_block', block: { type: 'list', title: 'All', query: { source: 'items' } } },
        ],
      }),
    );
    const [preview] = Object.values(result.preview);
    assert.ok(preview && 'rows' in preview);
    assert.equal(preview.rows.length, 5);
    assert.equal(preview.total, 8);
  });

  it('an invalid op is a 400 with a pointer; in a dry run it is reported, not thrown', async () => {
    const view = await blank();
    await assert.rejects(
      svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        ops: [{ op: 'remove_block', blockId: 'blk_missing' }],
      }),
      (error: unknown) =>
        hasStatus(400)(error) && (error as { pointer?: string }).pointer === '/ops/0/blockId',
    );
    const result = dryRun(
      await svc.applyDashboardOps(ctx.editor, actor.editor, view.id, {
        expectedVersion: 1,
        dryRun: true,
        ops: [{ op: 'remove_block', blockId: 'blk_missing' }],
      }),
    );
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.map((issue) => issue.pointer),
      ['/ops/0/blockId'],
    );
    assert.deepEqual(await versionNumbers(view.id), [1]);
  });

  it('mcp-mode lint errors block an agent’s write; the same edit from the UI only warns', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.agent, {
      title: 'Filters',
      language: 'en',
    });
    const textField: Op[] = [
      { op: 'add_block', block: { type: 'filter', viz: { kind: 'chips', field: 'Pick one' } } },
    ];
    await assert.rejects(
      svc.applyDashboardOps(ctx.owner, actor.agent, view.id, {
        expectedVersion: 1,
        ops: textField,
      }),
      (error: unknown) =>
        hasStatus(400)(error) && (error as { pointer?: string }).pointer === '/blocks/0/viz/field',
    );
    const preview = dryRun(
      await svc.applyDashboardOps(ctx.owner, actor.agent, view.id, {
        expectedVersion: 1,
        dryRun: true,
        ops: textField,
      }),
    );
    assert.equal(preview.valid, false);
    assert.equal(preview.errors[0]?.code, 'hardcoded_text');
    assert.deepEqual(await versionNumbers(view.id), [1]);

    const fromUi = written(
      await svc.applyDashboardOps(ctx.owner, actor.owner, view.id, {
        expectedVersion: 1,
        ops: textField,
      }),
    );
    assert.equal(fromUi.version, 2);
    assert.equal(fromUi.warnings[0]?.code, 'hardcoded_text');
  });

  it('keeps a snapshot every 10th version', async () => {
    const view = await blank();
    let version = 1;
    for (let step = 0; step < 10; step += 1)
      version = await edit(view.id, version, [rename(`T${String(step)}`)]);
    const versions = await models.getDashboardVersionRepository();
    const tenth = await versions.findByVersion(workspaceId, view.id, 10);
    assert.ok(tenth?.snapshot);
    assert.equal((tenth.snapshot as { title: string }).title, 'T8');
    assert.equal((await versions.findByVersion(workspaceId, view.id, 9))?.snapshot, null);
    assert.equal((await versions.findByVersion(workspaceId, view.id, 11))?.snapshot, null);
  });

  it('owner UI writes publish; editor and agent writes do not', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.owner, {
      title: 'Live',
      language: 'en',
    });
    await edit(view.id, 1, [rename('By owner')], actor.owner, ctx.owner);
    assert.equal((await draft(view.id)).publishedVersion, 2);
    await edit(view.id, 2, [rename('By editor')]);
    await edit(view.id, 3, [rename('By agent')], actor.agent, ctx.owner);
    const viewed = await svc.getDashboard(ctx.viewer, actor.viewer, view.id, {});
    assert.equal(viewed.title, 'By owner');
    assert.equal(viewed.publishedVersion, 2);
    assert.equal(viewed.version, 4);
  });

  it('viewers cannot edit (403)', async () => {
    const view = await blank();
    await assert.rejects(
      svc.applyDashboardOps(ctx.viewer, actor.viewer, view.id, {
        expectedVersion: 1,
        ops: [rename('x')],
      }),
      hasStatus(403),
    );
  });
});

// ─── Undo, redo, revert ─────────────────────────────────────────────────────

describe('undo and redo', () => {
  it('undo restores exactly; redo re-applies; undo takes several steps as one version', async () => {
    const view = await blank();
    const v1 = await draft(view.id);
    await edit(view.id, 1, [addNote]);
    const v2 = await draft(view.id);
    await edit(view.id, 2, [rename('Renamed'), { op: 'set_vars', vars: { range: 'today' } }]);
    const v3 = await draft(view.id);

    const undone = await svc.undoDashboard(ctx.editor, actor.editor, view.id, {
      expectedVersion: 3,
    });
    assert.equal(undone.version, 4);
    assert.deepEqual(content(await draft(view.id)), content(v2));

    const redone = await svc.redoDashboard(ctx.editor, actor.editor, view.id, {
      expectedVersion: 4,
    });
    assert.equal(redone.version, 5);
    assert.deepEqual(content(await draft(view.id)), content(v3));

    await svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 5, steps: 2 });
    assert.deepEqual(content(await draft(view.id)), content(v1));
    const versions = await models.getDashboardVersionRepository();
    assert.equal((await versions.findByVersion(workspaceId, view.id, 4))?.summary, 'undo:v3');
    assert.equal((await versions.findByVersion(workspaceId, view.id, 5))?.summary, 'redo:v3');
    assert.equal((await versions.findByVersion(workspaceId, view.id, 6))?.summary, 'undo:v5,v2');
  });

  it('consecutive undos walk back; nothing left is a 409; redo needs an undo on top', async () => {
    const view = await blank();
    await edit(view.id, 1, [rename('A')]);
    await edit(view.id, 2, [rename('B')]);
    await assert.rejects(
      svc.redoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 3 }),
      hasStatus(409),
    );
    await svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 3 });
    assert.equal((await draft(view.id)).title, 'A');
    await svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 4 });
    assert.equal((await draft(view.id)).title, 'Blank');
    await assert.rejects(
      svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 5 }),
      hasStatus(409),
    );
    await assert.rejects(
      svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 4 }),
      hasStatus(409),
    );
  });

  it('a write landing between reading the dashboard and its history is a version conflict', async () => {
    const view = await blank();
    await edit(view.id, 1, [rename('A')]);
    await svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 2 });
    const versions = await models.getDashboardVersionRepository();
    const original = versions.list.bind(versions);
    let next = 3;
    const spy = mock.method(versions, 'list', async (...args: Parameters<typeof versions.list>) => {
      // Someone else's write lands after the dashboard was read, before its history is.
      next = await edit(view.id, next, [rename(`Agent ${String(next)}`)], actor.agent, ctx.owner);
      return original(...args);
    });
    try {
      await assert.rejects(
        svc.redoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 3 }),
        (error: unknown) =>
          hasStatus(409)(error) && (error as { currentVersion?: number }).currentVersion === 4,
      );
      await assert.rejects(
        svc.undoDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 4 }),
        (error: unknown) =>
          hasStatus(409)(error) && (error as { currentVersion?: number }).currentVersion === 5,
      );
    } finally {
      spy.mock.restore();
    }
  });

  it('an agent’s undo skips human versions and keeps them', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.agent, {
      title: 'Shared',
      language: 'en',
    });
    await edit(view.id, 1, [addNote], actor.agent, ctx.owner);
    await edit(view.id, 2, [rename('Human title')], actor.editor, ctx.editor);
    await edit(
      view.id,
      3,
      [{ op: 'add_block', block: { type: 'counter' } }],
      actor.otherAgent,
      ctx.owner,
    );

    const result = await svc.undoDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 4 });
    assert.equal(result.version, 5);
    const after = await draft(view.id);
    assert.equal(after.title, 'Human title');
    assert.deepEqual(
      after.blocks.map((block) => block.type),
      ['counter'],
    );
    assert.equal(
      (await (await models.getDashboardVersionRepository()).findByVersion(workspaceId, view.id, 5))
        ?.summary,
      'undo:v2',
    );
    // Nothing of its own is left to undo.
    await assert.rejects(
      svc.undoDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 5 }),
      hasStatus(409),
    );
  });

  it('an agent’s undo refuses when someone has since edited the same block', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.agent, {
      title: 'Shared',
      language: 'en',
    });
    await edit(view.id, 1, [addNote], actor.agent, ctx.owner);
    const noteId = (await draft(view.id)).blocks[0]?.id ?? '';
    await edit(
      view.id,
      2,
      [{ op: 'update_block', blockId: noteId, patch: { title: 'Agent' } }],
      actor.agent,
      ctx.owner,
    );
    await edit(view.id, 3, [{ op: 'update_block', blockId: noteId, patch: { title: 'Human' } }]);
    await assert.rejects(
      svc.undoDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 4 }),
      hasStatus(409),
    );
    assert.equal((await draft(view.id)).blocks[0]?.title, 'Human');
  });
});

describe('revertDashboard', () => {
  it('reverting to v3 after 25 versions equals v3', async () => {
    const view = await blank();
    let version = 1;
    let third: DashboardView | null = null;
    for (let step = 0; step < 24; step += 1) {
      const ops: Op[] = step % 4 === 0 ? [addNote] : [rename(`Title ${String(step)}`)];
      version = await edit(view.id, version, ops);
      if (version === 3) third = await draft(view.id);
    }
    assert.equal(version, 25);
    assert.ok(third);
    const result = await svc.revertDashboard(ctx.editor, actor.editor, view.id, {
      expectedVersion: 25,
      toVersion: 3,
    });
    assert.equal(result.version, 26);
    assert.deepEqual(content(await draft(view.id)), content(third));
    const entry = await (
      await models.getDashboardVersionRepository()
    ).findByVersion(workspaceId, view.id, 26);
    assert.equal(entry?.summary, 'revert:v3');
  });

  it('starts from the nearest snapshot, and answers 404 once the history is pruned beyond reach', async () => {
    const view = await blank();
    let version = 1;
    const states = new Map<number, DashboardView>();
    for (let step = 0; step < 55; step += 1) {
      version = await edit(view.id, version, [rename(`Step ${String(step)}`)]);
      states.set(version, await draft(view.id));
    }
    // Versions 7–56 are kept (v1 is pruned). v15 starts from v10’s snapshot; v6 has no snapshot
    // at or before it but is reached backward from the head (v7…v56’s inverses); v5 is not.
    assert.ok(!(await versionNumbers(view.id)).includes(1));
    await assert.rejects(
      svc.revertDashboard(ctx.editor, actor.editor, view.id, {
        expectedVersion: version,
        toVersion: 5,
      }),
      hasStatus(404),
    );
    await svc.revertDashboard(ctx.editor, actor.editor, view.id, {
      expectedVersion: version,
      toVersion: 15,
    });
    assert.equal((await draft(view.id)).title, states.get(15)?.title);
    await assert.rejects(
      svc.revertDashboard(ctx.editor, actor.editor, view.id, {
        expectedVersion: version + 1,
        toVersion: version + 5,
      }),
      hasStatus(404),
    );
  });
});

// ─── Pruning, publish, delete, history ──────────────────────────────────────

describe('lint on undo, redo and revert', () => {
  /** A filter whose viz.field is free text: a warning in the UI, an error for agents. */
  const textFilter: Op = {
    op: 'add_block',
    block: { type: 'filter', viz: { kind: 'chips', field: 'Pick one' } },
  };

  it('an agent cannot revert to a version holding hard-coded text; a person can', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.agent, {
      title: 'Lint',
      language: 'en',
    });
    await edit(view.id, 1, [textFilter], actor.owner, ctx.owner);
    const filterId = (await draft(view.id)).blocks[0]?.id ?? '';
    await edit(view.id, 2, [{ op: 'remove_block', blockId: filterId }], actor.owner, ctx.owner);
    await assert.rejects(
      svc.revertDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 3, toVersion: 2 }),
      (error: unknown) =>
        hasStatus(400)(error) && (error as { pointer?: string }).pointer === '/blocks/0/viz/field',
    );
    assert.equal((await draft(view.id)).version, 3);
    const byPerson = await svc.revertDashboard(ctx.owner, actor.owner, view.id, {
      expectedVersion: 3,
      toVersion: 2,
    });
    assert.equal(byPerson.version, 4);
  });

  it('an agent cannot undo its way back to hard-coded text', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.agent, {
      title: 'Lint',
      language: 'en',
    });
    await edit(view.id, 1, [textFilter], actor.owner, ctx.owner);
    const filterId = (await draft(view.id)).blocks[0]?.id ?? '';
    // The agent removes the offending block (its result is clean), then tries to undo that.
    await edit(view.id, 2, [{ op: 'remove_block', blockId: filterId }], actor.agent, ctx.owner);
    await assert.rejects(
      svc.undoDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 3 }),
      (error: unknown) =>
        hasStatus(400)(error) && (error as { pointer?: string }).pointer === '/blocks/0/viz/field',
    );
    // A person in the UI may: hard-coded text is only a warning there.
    const byPerson = await svc.undoDashboard(ctx.owner, actor.owner, view.id, {
      expectedVersion: 3,
    });
    assert.equal(byPerson.version, 4);
    // Redo by the agent of a person's undo: not its own undo (409, as before).
    await assert.rejects(
      svc.redoDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 4 }),
      hasStatus(409),
    );
  });
});

describe('revert after pruning', () => {
  it('every kept version can be reverted to', async () => {
    const view = await blank();
    let version = 1;
    const states = new Map<number, Omit<DashboardDraft, 'scope'>>();
    for (let step = 0; step < 55; step += 1) {
      const ops: Op[] =
        step % 5 === 0
          ? [addNote]
          : [rename(`Step ${String(step)}`), { op: 'set_vars', vars: { step } }];
      version = await edit(view.id, version, ops);
      states.set(version, content(await draft(view.id)));
    }
    const kept = await versionNumbers(view.id);
    assert.equal(kept.length, 50);
    assert.ok(!kept.includes(1));
    // Oldest first: each revert adds a version and prunes the oldest kept one, never one still ahead.
    for (const target of kept) {
      const result = await svc.revertDashboard(ctx.editor, actor.editor, view.id, {
        expectedVersion: version,
        toVersion: target,
      });
      version = result.version;
      assert.deepEqual(content(await draft(view.id)), states.get(target), `v${String(target)}`);
    }
  });
});

describe('pruning', () => {
  it('the 51st version prunes the oldest unpublished one', async () => {
    const view = await blank();
    let version = 1;
    while (version < 50)
      version = await edit(view.id, version, [rename(`v${String(version + 1)}`)]);
    assert.equal((await versionNumbers(view.id)).length, 50);
    version = await edit(view.id, version, [rename('v51')]);
    const kept = await versionNumbers(view.id);
    assert.equal(kept.length, 50);
    assert.deepEqual([kept[0], kept.at(-1)], [2, 51]);
  });

  it('…and keeps the published version, however old', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.owner, {
      title: 'Published',
      language: 'en',
    });
    let version = 1;
    while (version < 51)
      version = await edit(view.id, version, [rename(`v${String(version + 1)}`)]);
    let kept = await versionNumbers(view.id);
    assert.equal(kept.length, 51);
    assert.equal(kept[0], 1);
    version = await edit(view.id, version, [rename('v52')]);
    kept = await versionNumbers(view.id);
    assert.deepEqual(kept.slice(0, 2), [1, 3]);
    assert.equal(kept.length, 51);
    // The published copy still rebuilds v1 for a revert.
    await svc.revertDashboard(ctx.owner, actor.owner, view.id, {
      expectedVersion: version,
      toVersion: 1,
    });
    assert.equal((await draft(view.id)).title, 'Published');
  });
});

describe('publishDashboard', () => {
  it('publishes the version the owner reviewed, without bumping it', async () => {
    const view = await blank();
    await edit(view.id, 1, [addNote]);
    const result = await svc.publishDashboard(ctx.owner, actor.owner, view.id, {
      expectedVersion: 2,
    });
    assert.deepEqual(result, { version: 2, publishedVersion: 2 });
    const viewed = await svc.getDashboard(ctx.viewer, actor.viewer, view.id, {});
    assert.deepEqual(content(viewed), content(await draft(view.id)));
    assert.equal((await draft(view.id)).version, 2);
    const audit = await (
      await models.getAuditLogRepository()
    ).list(workspaceId, { action: 'dashboard.publish' }, 20);
    assert.ok(audit.some((entry) => entry.targetId === view.id));
  });

  it('an agent write between the review and the publish makes the publish a 409', async () => {
    const view = await blank();
    const reviewed = await draft(view.id);
    await edit(view.id, reviewed.version, [rename('Agent change')], actor.agent, ctx.owner);
    await assert.rejects(
      svc.publishDashboard(ctx.owner, actor.owner, view.id, { expectedVersion: reviewed.version }),
      (error: unknown) =>
        hasStatus(409)(error) && (error as { currentVersion?: number }).currentVersion === 2,
    );
    assert.equal((await draft(view.id)).publishedVersion, null);
    await assert.rejects(svc.getDashboard(ctx.viewer, actor.viewer, view.id, {}), hasStatus(404));
  });

  it('a write landing while the publish is in flight is a 409 too: one compare-and-set, no retry', async () => {
    const view = await blank();
    const dashboards = await models.getDashboardRepository();
    const original = dashboards.setPublished.bind(dashboards);
    let landed = false;
    const spy = mock.method(
      dashboards,
      'setPublished',
      async (...args: Parameters<typeof dashboards.setPublished>) => {
        if (!landed) {
          landed = true;
          await edit(view.id, 1, [rename('Agent change')], actor.agent, ctx.owner);
        }
        return original(...args);
      },
    );
    try {
      await assert.rejects(
        svc.publishDashboard(ctx.owner, actor.owner, view.id, { expectedVersion: 1 }),
        (error: unknown) =>
          hasStatus(409)(error) && (error as { currentVersion?: number }).currentVersion === 2,
      );
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
    const after = await draft(view.id);
    assert.equal(after.publishedVersion, null);
    assert.equal(after.title, 'Agent change');
  });

  it('is for owners only; an agent also needs builder:publish', async () => {
    const view = await blank();
    await assert.rejects(
      svc.publishDashboard(ctx.editor, actor.editor, view.id, { expectedVersion: 1 }),
      hasStatus(403),
    );
    await assert.rejects(
      svc.publishDashboard(ctx.owner, actor.agent, view.id, { expectedVersion: 1 }),
      hasStatus(403),
    );
    const result = await svc.publishDashboard(ctx.owner, actor.agent, view.id, {
      expectedVersion: 1,
      allowAgentPublish: true,
    });
    assert.equal(result.publishedVersion, 1);
  });
});

describe('deleteDashboard and listDashboardVersions', () => {
  it('only an owner deletes; the dashboard is gone afterwards', async () => {
    const view = await blank();
    await assert.rejects(svc.deleteDashboard(ctx.editor, actor.editor, view.id), hasStatus(403));
    await svc.deleteDashboard(ctx.owner, actor.owner, view.id);
    await assert.rejects(svc.getDashboard(ctx.owner, actor.owner, view.id, {}), hasStatus(404));
    await assert.rejects(svc.deleteDashboard(ctx.owner, actor.owner, view.id), hasStatus(404));
  });

  it('lists the history newest first, for editors', async () => {
    const view = await svc.createDashboard(ctx.owner, actor.owner, {
      title: 'History',
      language: 'en',
    });
    await edit(view.id, 1, [addNote], actor.agent, ctx.owner);
    const history = await svc.listDashboardVersions(ctx.editor, actor.editor, view.id, {});
    assert.deepEqual(
      history.map((entry) => [
        entry.version,
        entry.actorAgentId,
        entry.summary,
        entry.hasSnapshot,
        entry.published,
      ]),
      [
        [2, 'agent-key-1', 'add_block note', false, false],
        [1, null, 'create', true, true],
      ],
    );
    await assert.rejects(
      svc.listDashboardVersions(ctx.viewer, actor.viewer, view.id, {}),
      hasStatus(403),
    );
  });
});

describe('DashboardVersionRepository', () => {
  it('keeps empty objects, so a version replays exactly', async () => {
    const versions = await models.getDashboardVersionRepository();
    const snapshot = { title: 'T', vars: {}, layouts: { lg: [], md: [], sm: [] }, blocks: [] };
    const patch = [{ op: 'replace', path: '/vars', value: {} }];
    await versions.append(workspaceId, {
      dashboardId: 'd-empty-objects',
      version: 1,
      patch,
      inverse: patch,
      snapshot,
      actorUserId: actor.owner.userId,
    });
    const stored = await versions.findByVersion(workspaceId, 'd-empty-objects', 1);
    assert.deepEqual(stored?.snapshot, snapshot);
    assert.deepEqual(stored.patch, patch);
    assert.deepEqual(stored.inverse, patch);
  });
});

describe('DashboardRepository.setPublished', () => {
  it('publishes only at the stored version and never bumps it', async () => {
    const dashboards = await models.getDashboardRepository();
    const created = await dashboards.create(workspaceId, {
      ownerUserId: actor.owner.userId,
      title: 'Repo',
    });
    const snapshot = { title: 'Repo', vars: {}, layouts: { lg: [], md: [], sm: [] }, blocks: [] };
    assert.equal(await dashboards.setPublished(workspaceId, created.id, 2, snapshot), null);
    const published = await dashboards.setPublished(workspaceId, created.id, 1, snapshot);
    assert.equal(published?.version, 1);
    assert.equal(published.publishedVersion, 1);
    assert.deepEqual(published.published, snapshot);
    assert.equal(await dashboards.setPublished('another-workspace', created.id, 1, snapshot), null);
  });
});

describe('validateDashboardDraft', () => {
  it('reports schema, catalog and lint findings with pointers', async () => {
    const result = await svc.validateDashboardDraft(
      { id: 'ws-validate' },
      {
        title: 'Draft',
        scope: { topicId: null, containerId: null, page: 'topic' },
        vars: {},
        layouts: { lg: [], md: [], sm: [] },
        blocks: [
          {
            id: 'blk_filter',
            type: 'filter',
            title: 'F',
            viz: { kind: 'chips', field: 'Free text' },
            sets: '$page.x',
          },
        ],
      },
      'ui',
    );
    assert.equal(result.valid, true);
    assert.deepEqual(
      result.warnings.map((issue) => [issue.code, issue.pointer]),
      [['hardcoded_text', '/blocks/0/viz/field']],
    );
    const mcp = await svc.validateDashboardDraft({ id: 'ws-validate' }, { title: '' }, 'mcp');
    assert.equal(mcp.valid, false);
    assert.ok(mcp.errors.length > 0);
    assert.ok(mcp.errors.every((issue) => issue.code === 'invalid'));
  });
});
