/**
 * The dashboard, builder and view routes over HTTP: what the UI editor relies on (versions, dry
 * runs, the 409 and 400 shapes, publish), the builder endpoints, saved views, and isolation
 * between workspaces.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { findSecrets } from '../../services/secretPatterns.js';

let api: ApiHarness;
const token = { owner: '', editor: '', viewer: '', stranger: '' };
let wid = '';
let otherWid = '';

before(async () => {
  api = await startApiHarness('todolist_dashboards_http');
  for (const who of ['owner', 'editor', 'viewer', 'stranger'] as const) {
    token[who] = (await api.login(`dash-http-${who}@example.test`)).token;
  }
  const created = await api.call('POST', '/api/private/workspaces', {
    token: token.owner,
    body: { name: 'Dashboards HTTP' },
  });
  assert.equal(created.status, 201, created.text);
  wid = (created.body?.['data'] as { id: string }).id;
  const other = await api.call('POST', '/api/private/workspaces', {
    token: token.stranger,
    body: { name: 'Another workspace' },
  });
  otherWid = (other.body?.['data'] as { id: string }).id;
  // Work and College are named by their slugs here ('work', 'college').
  const { addDefaultTopics } = await import('../../testing/workspaceFixtures.js');
  await addDefaultTopics(wid, { slugIds: true });

  const models = await import('../../models/index.js');
  const memberships = await models.getMembershipRepository();
  const users = await models.getUserRepository();
  for (const [who, role] of [
    ['editor', 'editor'],
    ['viewer', 'viewer'],
  ] as const) {
    const user = await users.findByEmail(`dash-http-${who}@example.test`);
    assert.ok(user);
    await memberships.create(wid, { userId: user.id, role });
  }
  const owner = await users.findByEmail('dash-http-owner@example.test');
  assert.ok(owner);
  const items = await models.getItemRepository();
  await items.createLocal(wid, {
    ownerUserId: owner.id,
    title: 'Due soon',
    topicId: 'work',
    dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });
  await items.createLocal(wid, {
    ownerUserId: owner.id,
    title: 'Long overdue',
    topicId: 'college',
    dueAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
});

after(async () => {
  await api.stop();
});

type Who = keyof typeof token;

function base(workspace = wid): string {
  return `/api/private/workspaces/${workspace}`;
}

async function call(who: Who, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await api.call(method, `${base()}${path}`, {
    token: token[who],
    ...(body === undefined ? {} : { body }),
  });
  // Nothing a dashboard route answers may carry a secret (the response guard would 500 anyway).
  assert.deepEqual(findSecrets(res.body), [], res.text);
  return res;
}

function data(res: ApiResponse): unknown {
  return res.body?.['data'];
}

interface Dashboard {
  id: string;
  as: string;
  title: string;
  vars: Record<string, unknown>;
  layouts: { lg: { i: string; x: number; y: number; w: number; h: number }[] };
  blocks: { id: string; type: string; title: string }[];
  version: number;
  publishedVersion: number | null;
}

async function createBlank(who: Who = 'editor', title = 'Blank'): Promise<Dashboard> {
  const res = await call(who, 'POST', '/dashboards', { title });
  assert.equal(res.status, 201, res.text);
  return data(res) as Dashboard;
}

async function getDraft(id: string): Promise<Dashboard> {
  const res = await call('editor', 'GET', `/dashboards/${id}`);
  assert.equal(res.status, 200, res.text);
  return data(res) as Dashboard;
}

async function versionCount(id: string): Promise<number> {
  return (data(await call('editor', 'GET', `/dashboards/${id}/versions`)) as unknown[]).length;
}

describe('POST …/dashboards/:id/ops', () => {
  it('ops bump the version', async () => {
    const dashboard = await createBlank();
    const res = await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      ops: [{ op: 'add_block', block: { type: 'deadlines', title: 'Deadlines' } }],
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(data(res), { version: 2, warnings: [] });
    const after = await getDraft(dashboard.id);
    assert.equal(after.version, 2);
    assert.equal(after.blocks[0]?.type, 'deadlines');
    assert.equal(await versionCount(dashboard.id), 2);
  });

  it('dryRun writes nothing and answers valid, errors, warnings, diff and preview', async () => {
    const dashboard = await createBlank();
    const before = await getDraft(dashboard.id);
    const res = await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      dryRun: true,
      ops: [{ op: 'add_block', block: { type: 'deadlines', title: 'Deadlines' } }],
    });
    assert.equal(res.status, 200, res.text);
    const result = data(res) as {
      valid: boolean;
      errors: unknown[];
      warnings: unknown[];
      diff: unknown[];
      preview: Record<string, { rows?: { title: string }[] }>;
    };
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.ok(result.diff.length > 0);
    // upcoming_14d: overdue items are included and come first.
    const [preview] = Object.values(result.preview);
    assert.deepEqual(
      preview?.rows?.map((row) => row.title),
      ['Long overdue', 'Due soon'],
    );
    assert.deepEqual(await getDraft(dashboard.id), before);
    assert.equal(await versionCount(dashboard.id), 1);
  });

  it('a stale expectedVersion answers 409 {message, currentVersion}', async () => {
    const dashboard = await createBlank();
    await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      ops: [{ op: 'set_title', title: 'First' }],
    });
    const res = await call('owner', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      ops: [{ op: 'set_title', title: 'Second' }],
    });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { message: 'Version conflict', currentVersion: 2 });
    assert.equal((await getDraft(dashboard.id)).title, 'First');
  });

  it('a refused op answers 400 {message, pointer}; a malformed body 400 {message}', async () => {
    const dashboard = await createBlank();
    const res = await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      ops: [{ op: 'set_view', blockId: 'blk_nowhere', view: 'month' }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body?.['pointer'], '/ops/0/blockId');
    assert.match(String(res.body['message']), /^\/ops\/0\/blockId: /);
    const malformed = await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      ops: [{ op: 'set_title', title: 'x' }],
    });
    assert.equal(malformed.status, 400);
    assert.match(String(malformed.body?.['message']), /expectedVersion/);
    const unknownKey = await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      ops: [{ op: 'set_title', title: 'x' }],
      force: true,
    });
    assert.equal(unknownKey.status, 400);
    assert.equal(await versionCount(dashboard.id), 1);
  });
});

describe('PATCH …/dashboards/:id and PUT …/layout', () => {
  it('PATCH sets the title and the vars as one version', async () => {
    const dashboard = await createBlank();
    const res = await call('editor', 'PATCH', `/dashboards/${dashboard.id}`, {
      expectedVersion: 1,
      title: 'College',
      vars: { range: 'this_semester', course: null },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal((data(res) as { version: number }).version, 2);
    const after = await getDraft(dashboard.id);
    assert.equal(after.title, 'College');
    assert.deepEqual(after.vars, { range: 'this_semester', course: null });
    const empty = await call('editor', 'PATCH', `/dashboards/${dashboard.id}`, {
      expectedVersion: 2,
    });
    assert.equal(empty.status, 400);
  });

  it('PUT layout moves blocks; blocks it does not list keep their place', async () => {
    const dashboard = await createBlank();
    await call('editor', 'POST', `/dashboards/${dashboard.id}/ops`, {
      expectedVersion: 1,
      ops: [
        { op: 'add_block', block: { type: 'clock' } },
        { op: 'add_block', block: { type: 'chart' } },
      ],
    });
    const [clock, chart] = (await getDraft(dashboard.id)).layouts.lg;
    assert.ok(clock && chart);
    const res = await call('editor', 'PUT', `/dashboards/${dashboard.id}/layout`, {
      expectedVersion: 2,
      layouts: { lg: [{ i: clock.i, x: 0, y: 8, w: 12, h: 8 }] },
    });
    assert.equal(res.status, 200, res.text);
    const after = (await getDraft(dashboard.id)).layouts.lg;
    assert.deepEqual(
      after.find((item) => item.i === clock.i),
      { i: clock.i, x: 0, y: 8, w: 12, h: 8 },
    );
    assert.deepEqual(
      after.find((item) => item.i === chart.i),
      chart,
    );
    const unknown = await call('editor', 'PUT', `/dashboards/${dashboard.id}/layout`, {
      expectedVersion: 3,
      layouts: { md: [{ i: 'blk_nowhere', x: 0, y: 0, w: 1, h: 1 }] },
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body?.['pointer'], '/ops/0/layouts/md/0/i');
  });
});

describe('undo, redo, revert and versions over HTTP', () => {
  it('walks the history and lists it newest first', async () => {
    const dashboard = await createBlank();
    const path = `/dashboards/${dashboard.id}`;
    await call('editor', 'PATCH', path, { expectedVersion: 1, title: 'Two' });
    await call('editor', 'PATCH', path, { expectedVersion: 2, title: 'Three' });
    assert.equal(
      (
        data(await call('editor', 'POST', `${path}/undo`, { expectedVersion: 3 })) as {
          version: number;
        }
      ).version,
      4,
    );
    assert.equal((await getDraft(dashboard.id)).title, 'Two');
    await call('editor', 'POST', `${path}/redo`, { expectedVersion: 4 });
    assert.equal((await getDraft(dashboard.id)).title, 'Three');
    const reverted = await call('editor', 'POST', `${path}/revert`, {
      expectedVersion: 5,
      toVersion: 1,
    });
    assert.equal(reverted.status, 200, reverted.text);
    assert.equal((await getDraft(dashboard.id)).title, 'Blank');
    const history = data(await call('editor', 'GET', `${path}/versions?limit=3`)) as {
      version: number;
      summary: string;
    }[];
    assert.deepEqual(
      history.map((entry) => [entry.version, entry.summary]),
      [
        [6, 'revert:v1'],
        [5, 'redo:v3'],
        [4, 'undo:v3'],
      ],
    );
    const nothing = await call('editor', 'POST', `${path}/redo`, { expectedVersion: 6 });
    assert.equal(nothing.status, 409);
    assert.equal(nothing.body?.['currentVersion'], undefined);
  });
});

describe('publish and what viewers see', () => {
  it('viewers see only the published copy; publish is the owner’s', async () => {
    const dashboard = await createBlank('editor', 'Draft title');
    const path = `/dashboards/${dashboard.id}`;
    assert.equal((await call('viewer', 'GET', path)).status, 404);
    assert.ok(
      !(data(await call('viewer', 'GET', '/dashboards')) as { id: string }[]).some(
        (d) => d.id === dashboard.id,
      ),
    );
    assert.equal(
      (await call('editor', 'POST', `${path}/publish`, { expectedVersion: 1 })).status,
      403,
    );
    // Publish names the version the owner reviewed: missing is a 400, stale a 409.
    const unversioned = await call('owner', 'POST', `${path}/publish`);
    assert.equal(unversioned.status, 400);
    assert.match(String(unversioned.body?.['message']), /expectedVersion/);
    const stale = await call('owner', 'POST', `${path}/publish`, { expectedVersion: 7 });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { message: 'Version conflict', currentVersion: 1 });

    const published = await call('owner', 'POST', `${path}/publish`, { expectedVersion: 1 });
    assert.equal(published.status, 200, published.text);
    assert.deepEqual(data(published), { version: 1, publishedVersion: 1 });
    await call('editor', 'PATCH', path, { expectedVersion: 1, title: 'Unpublished edit' });

    const seen = data(await call('viewer', 'GET', `${path}?as=draft`)) as Dashboard;
    assert.equal(seen.as, 'published');
    assert.equal(seen.title, 'Draft title');
    const editorView = data(await call('editor', 'GET', `${path}?as=published`)) as Dashboard;
    assert.equal(editorView.title, 'Draft title');
    assert.equal((await getDraft(dashboard.id)).title, 'Unpublished edit');
    assert.equal((await call('editor', 'GET', `${path}?as=everything`)).status, 400);
  });

  it('an owner’s own edits are published as they are saved', async () => {
    const dashboard = await createBlank('owner', 'Live');
    assert.equal(dashboard.publishedVersion, 1);
    await call('owner', 'PATCH', `/dashboards/${dashboard.id}`, {
      expectedVersion: 1,
      title: 'Live 2',
    });
    assert.equal(
      (data(await call('viewer', 'GET', `/dashboards/${dashboard.id}`)) as Dashboard).title,
      'Live 2',
    );
  });
});

describe('builder endpoints', () => {
  it('serves the catalog and the templates', async () => {
    const catalog = data(await call('viewer', 'GET', '/builder/catalog')) as {
      blockTypes: { type: string; size: unknown }[];
      datePresets: string[];
    };
    assert.equal(catalog.blockTypes.length, 15);
    assert.ok(catalog.datePresets.includes('upcoming_14d'));
    const templates = data(await call('viewer', 'GET', '/builder/templates')) as { key: string }[];
    assert.deepEqual(
      templates.map((template) => template.key),
      ['dashboard@1', 'work@1', 'personal@1', 'college@1', 'college-course@1', 'project@1'],
    );
  });

  it('serves the view templates and personas to a viewer, smallest persona first', async () => {
    const views = data(await call('viewer', 'GET', '/builder/view-templates')) as {
      key: string;
      type: string;
    }[];
    assert.deepEqual(
      views.map((view) => view.key),
      [
        'my-open-work@1',
        'by-status@1',
        'this-week@1',
        'deadlines-agenda@1',
        'workload-this-week@1',
        'study-dashboard@1',
      ],
    );
    const personas = data(await call('viewer', 'GET', '/builder/personas')) as { key: string }[];
    assert.deepEqual(
      personas.map((persona) => persona.key),
      ['light-student@1', 'two-jobs-studies-side-project@1', 'student-job@1'],
    );
  });

  it('keeps persona instantiation to editors, and 404s an unknown persona', async () => {
    const viewer = await call(
      'viewer',
      'POST',
      '/builder/personas/light-student@1/instantiate',
      {},
    );
    assert.equal(viewer.status, 403, viewer.text);
    const unknown = await call('editor', 'POST', '/builder/personas/nope@1/instantiate', {});
    assert.equal(unknown.status, 404, unknown.text);
  });

  it('instantiates a template; its deadlines block runs through POST /query', async () => {
    const res = await call('editor', 'POST', '/builder/instantiate', {
      templateKey: 'dashboard',
      language: 'en',
    });
    assert.equal(res.status, 201, res.text);
    const dashboard = data(res) as Dashboard;
    assert.equal(dashboard.title, 'Dashboard');
    const deadlines = dashboard.blocks.find((block) => block.type === 'deadlines');
    assert.ok(deadlines);
    const rows = await call('editor', 'POST', '/query', {
      dashboardId: dashboard.id,
      blockId: deadlines.id,
    });
    assert.equal(rows.status, 200, rows.text);
    assert.deepEqual(
      (data(rows) as { rows: { title: string }[] }).rows.map((row) => row.title),
      ['Long overdue', 'Due soon'],
    );
    // A group template (project@1) needs a topic from the caller.
    const noArea = await call('editor', 'POST', '/builder/instantiate', { templateKey: 'project' });
    assert.equal(noArea.status, 400);
    assert.equal(noArea.body?.['pointer'], '/scope/topicId');
    const withArea = await call('editor', 'POST', '/builder/instantiate', {
      templateKey: 'project',
      scope: { topicId: 'work' },
    });
    assert.equal(withArea.status, 201, withArea.text);
    assert.deepEqual((data(withArea) as { scope: unknown }).scope, {
      topicId: 'work',
      containerId: null,
      page: 'group',
      groupVar: 'project',
    });
    const unknown = await call('editor', 'POST', '/builder/instantiate', { templateKey: 'nope' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body?.['pointer'], '/templateKey');
  });

  it('validates a draft as a save would, without writing', async () => {
    const res = await call('viewer', 'POST', '/builder/validate', {
      draft: {
        title: 'Draft',
        scope: { topicId: null, containerId: null, page: 'topic' },
        vars: {},
        layouts: { lg: [], md: [], sm: [] },
        blocks: [{ id: 'blk_chart', type: 'chart', title: 'C', viz: { kind: 'pie' } }],
      },
    });
    assert.equal(res.status, 200, res.text);
    const result = data(res) as { valid: boolean; errors: { pointer: string }[] };
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((error) => error.pointer).sort(), [
      '/blocks/0/query',
      '/blocks/0/viz/kind',
    ]);
  });
});

describe('saved views', () => {
  it('validates the query and the viz with pointers, and keeps private views private', async () => {
    const badField = await call('editor', 'POST', '/views', {
      title: 'Bad',
      query: {
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'ownerUserId', operator: '=', value: 'x' }] },
      },
      viz: { kind: 'list' },
    });
    assert.equal(badField.status, 400);
    assert.equal(badField.body?.['pointer'], '/query/where/rules/0/field');
    const badViz = await call('editor', 'POST', '/views', {
      title: 'Bad',
      query: { source: 'items' },
      viz: { kind: 'hologram' },
    });
    assert.equal(badViz.status, 400);
    assert.equal(badViz.body?.['pointer'], '/viz/kind');

    const created = await call('editor', 'POST', '/views', {
      title: 'Mine',
      query: { source: 'items', dateRange: 'upcoming_7d' },
      viz: { kind: 'list', visibleRows: 5 },
      visibility: 'private',
    });
    assert.equal(created.status, 201, created.text);
    const view = data(created) as { id: string; title: string };
    assert.equal((await call('owner', 'GET', `/views/${view.id}`)).status, 404);
    assert.ok(
      !(data(await call('owner', 'GET', '/views')) as { id: string }[]).some(
        (v) => v.id === view.id,
      ),
    );
    const renamed = await call('editor', 'PATCH', `/views/${view.id}`, { title: 'Still mine' });
    assert.equal((data(renamed) as { title: string }).title, 'Still mine');
    assert.equal((await call('owner', 'DELETE', `/views/${view.id}`)).status, 404);
    assert.equal((await call('editor', 'DELETE', `/views/${view.id}`)).status, 204);
    assert.equal((await call('editor', 'GET', `/views/${view.id}`)).status, 404);
  });
});

describe('isolation between workspaces', () => {
  it('a dashboard or view id from another workspace is a 404 everywhere', async () => {
    const theirs = await api.call('POST', `${base(otherWid)}/dashboards`, {
      token: token.stranger,
      body: { title: 'Theirs' },
    });
    assert.equal(theirs.status, 201, theirs.text);
    const theirId = (data(theirs) as Dashboard).id;
    const theirView = await api.call('POST', `${base(otherWid)}/views`, {
      token: token.stranger,
      body: { title: 'Theirs', query: { source: 'items' }, viz: { kind: 'list' } },
    });
    const theirViewId = (data(theirView) as { id: string }).id;

    assert.equal((await call('owner', 'GET', `/dashboards/${theirId}`)).status, 404);
    assert.equal(
      (
        await call('owner', 'POST', `/dashboards/${theirId}/ops`, {
          expectedVersion: 1,
          ops: [{ op: 'set_title', title: 'x' }],
        })
      ).status,
      404,
    );
    assert.equal(
      (await call('owner', 'POST', `/dashboards/${theirId}/publish`, { expectedVersion: 1 }))
        .status,
      404,
    );
    assert.equal((await call('owner', 'DELETE', `/dashboards/${theirId}`)).status, 404);
    assert.equal((await call('owner', 'GET', `/views/${theirViewId}`)).status, 404);
    // Their workspace itself: not a member, so 404 before anything else.
    const outside = await api.call('GET', `${base(otherWid)}/dashboards/${theirId}`, {
      token: token.owner,
    });
    assert.equal(outside.status, 404);
    const untouched = await api.call('GET', `${base(otherWid)}/dashboards/${theirId}`, {
      token: token.stranger,
    });
    assert.equal((data(untouched) as Dashboard).title, 'Theirs');
  });
});
