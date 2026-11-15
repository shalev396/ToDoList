/**
 * DATA.md §5 role matrix over the dashboard, builder and view routes, over HTTP: every route ×
 * {viewer, editor, owner, non-member}, each on a fresh workspace. A refused request (403/404)
 * changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';

type Who = 'viewer' | 'editor' | 'owner' | 'stranger';
const PEOPLE = ['viewer', 'editor', 'owner', 'stranger'] as const;

interface Fixture {
  wid: string;
  /** A dashboard at version 4: created (published), a block added, renamed, the rename undone. */
  dashboardId: string;
  viewId: string;
}

interface RouteCase {
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: (f: Fixture) => string;
  body?: unknown;
  expect: Record<Who, number>;
}

const ws = (f: Fixture): string => `/api/private/workspaces/${f.wid}`;
const dash = (f: Fixture): string => `${ws(f)}/dashboards/${f.dashboardId}`;

const READ = { viewer: 200, editor: 200, owner: 200, stranger: 404 };
const EDIT = { viewer: 403, editor: 200, owner: 200, stranger: 404 };
const MAKE = { viewer: 403, editor: 201, owner: 201, stranger: 404 };
const OWN = { viewer: 403, editor: 403, owner: 200, stranger: 404 };

const BLANK_DRAFT = {
  title: 'Draft',
  scope: { topicId: null, containerId: null, page: 'topic' },
  vars: {},
  layouts: { lg: [], md: [], sm: [] },
  blocks: [],
};

const MATRIX: RouteCase[] = [
  { route: 'GET dashboards', method: 'GET', path: (f) => `${ws(f)}/dashboards`, expect: READ },
  {
    route: 'POST dashboards',
    method: 'POST',
    path: (f) => `${ws(f)}/dashboards`,
    body: { title: 'New' },
    expect: MAKE,
  },
  { route: 'GET dashboards/:id', method: 'GET', path: dash, expect: READ },
  {
    route: 'PATCH dashboards/:id',
    method: 'PATCH',
    path: dash,
    body: { expectedVersion: 4, title: 'Renamed' },
    expect: EDIT,
  },
  {
    route: 'DELETE dashboards/:id',
    method: 'DELETE',
    path: dash,
    expect: { viewer: 403, editor: 403, owner: 204, stranger: 404 },
  },
  {
    route: 'PUT dashboards/:id/layout',
    method: 'PUT',
    path: (f) => `${dash(f)}/layout`,
    body: { expectedVersion: 4, layouts: { lg: [] } },
    expect: EDIT,
  },
  {
    route: 'POST dashboards/:id/ops',
    method: 'POST',
    path: (f) => `${dash(f)}/ops`,
    body: { expectedVersion: 4, ops: [{ op: 'set_title', title: 'Changed' }] },
    expect: EDIT,
  },
  {
    route: 'GET dashboards/:id/versions',
    method: 'GET',
    path: (f) => `${dash(f)}/versions`,
    expect: EDIT,
  },
  {
    route: 'POST dashboards/:id/undo',
    method: 'POST',
    path: (f) => `${dash(f)}/undo`,
    body: { expectedVersion: 4 },
    expect: EDIT,
  },
  {
    route: 'POST dashboards/:id/redo',
    method: 'POST',
    path: (f) => `${dash(f)}/redo`,
    body: { expectedVersion: 4 },
    expect: EDIT,
  },
  {
    route: 'POST dashboards/:id/revert',
    method: 'POST',
    path: (f) => `${dash(f)}/revert`,
    body: { expectedVersion: 4, toVersion: 1 },
    expect: EDIT,
  },
  {
    route: 'POST dashboards/:id/publish',
    method: 'POST',
    path: (f) => `${dash(f)}/publish`,
    body: { expectedVersion: 4 },
    expect: OWN,
  },
  {
    route: 'GET builder/catalog',
    method: 'GET',
    path: (f) => `${ws(f)}/builder/catalog`,
    expect: READ,
  },
  {
    route: 'POST builder/validate',
    method: 'POST',
    path: (f) => `${ws(f)}/builder/validate`,
    body: { draft: BLANK_DRAFT },
    expect: READ,
  },
  {
    route: 'POST builder/instantiate',
    method: 'POST',
    path: (f) => `${ws(f)}/builder/instantiate`,
    body: { templateKey: 'work@1' },
    expect: MAKE,
  },
  {
    route: 'GET builder/templates',
    method: 'GET',
    path: (f) => `${ws(f)}/builder/templates`,
    expect: READ,
  },
  { route: 'GET views', method: 'GET', path: (f) => `${ws(f)}/views`, expect: READ },
  {
    route: 'POST views',
    method: 'POST',
    path: (f) => `${ws(f)}/views`,
    body: { title: 'Open work', query: { source: 'items' }, viz: { kind: 'list' } },
    expect: MAKE,
  },
  {
    route: 'GET views/:id',
    method: 'GET',
    path: (f) => `${ws(f)}/views/${f.viewId}`,
    expect: READ,
  },
  {
    route: 'PATCH views/:id',
    method: 'PATCH',
    path: (f) => `${ws(f)}/views/${f.viewId}`,
    body: { title: 'Renamed view' },
    expect: EDIT,
  },
  {
    route: 'DELETE views/:id',
    method: 'DELETE',
    path: (f) => `${ws(f)}/views/${f.viewId}`,
    expect: { viewer: 403, editor: 204, owner: 204, stranger: 404 },
  },
];

let api: ApiHarness;
const tokens = {} as Record<Who, string>;
const userIds = {} as Record<Who, string>;
let fixtures = 0;

before(async () => {
  api = await startApiHarness('todolist_dashboards_role_matrix');
  for (const who of PEOPLE) {
    tokens[who] = (await api.login(`dash-matrix-${who}@example.test`)).token;
    const me = await api.call('GET', '/api/private/me', { token: tokens[who] });
    userIds[who] = (me.body?.['data'] as { id: string }).id;
  }
});

after(async () => {
  await api.stop();
});

/** A fresh workspace (owner, editor, viewer), a dashboard at version 4 and a view. */
async function fixture(): Promise<Fixture> {
  const models = await import('../../models/index.js');
  const { contextFor } = await import('../../testing/workspaceFixtures.js');
  const dashboards = await import('../../testing/dashboardCalls.js');
  const views = await import('../../testing/dashboardCalls.js');
  fixtures += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Matrix', slug: `dash-matrix-${String(fixtures)}`, ownerId: userIds.owner });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: userIds.owner, role: 'owner' });
  await memberships.create(workspace.id, { userId: userIds.editor, role: 'editor' });
  await memberships.create(workspace.id, { userId: userIds.viewer, role: 'viewer' });
  const owner = await contextFor(workspace.id, userIds.owner);
  const editor = await contextFor(workspace.id, userIds.editor);
  const ownerActor = { userId: userIds.owner, agentId: null };
  const editorActor = { userId: userIds.editor, agentId: null };
  const created = await dashboards.createDashboard(owner, ownerActor, {
    title: 'Matrix',
    language: 'en',
  });
  await dashboards.applyDashboardOps(editor, editorActor, created.id, {
    expectedVersion: 1,
    ops: [{ op: 'add_block', block: { type: 'note', note: 'hi' } }],
  });
  await dashboards.applyDashboardOps(editor, editorActor, created.id, {
    expectedVersion: 2,
    ops: [{ op: 'set_title', title: 'Three' }],
  });
  await dashboards.undoDashboard(editor, editorActor, created.id, { expectedVersion: 3 });
  const view = await views.createView(owner, ownerActor, {
    title: 'View',
    query: { source: 'items' },
    viz: { kind: 'list' },
  });
  return { wid: workspace.id, dashboardId: created.id, viewId: view.id };
}

/** Everything the routes above can change. */
async function snapshot(f: Fixture): Promise<unknown> {
  const models = await import('../../models/index.js');
  const dashboards = await (await models.getDashboardRepository()).list(f.wid, {});
  const versions = await (
    await models.getDashboardVersionRepository()
  ).list(f.wid, f.dashboardId, 100);
  const views = await (await models.getViewRepository()).list(f.wid);
  return {
    dashboards: dashboards.map((d) => [
      d.id,
      d.title,
      d.version,
      d.publishedVersion,
      d.blocks.length,
    ]),
    versions: versions.map((v) => [v.version, v.summary]),
    views: views.map((v) => [v.id, v.title]),
  };
}

describe('dashboard, builder and view routes: role matrix', () => {
  for (const route of MATRIX) {
    for (const who of PEOPLE) {
      const want = route.expect[who];
      it(`${route.route} as ${who} → ${String(want)}`, async () => {
        const f = await fixture();
        const before = await snapshot(f);
        const res = await api.call(route.method, route.path(f), {
          token: tokens[who],
          ...(route.body === undefined ? {} : { body: route.body }),
        });
        assert.equal(res.status, want, res.text);
        if (want >= 400)
          assert.deepEqual(await snapshot(f), before, 'a refused request changed data');
      });
    }
  }
});
