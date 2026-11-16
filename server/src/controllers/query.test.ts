import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';

let api: ApiHarness;
let base = '';

interface Caller {
  id: string;
  token: string;
}

const users: Record<'owner' | 'editor' | 'viewer' | 'stranger', Caller> = {
  owner: { id: '', token: '' },
  editor: { id: '', token: '' },
  viewer: { id: '', token: '' },
  stranger: { id: '', token: '' },
};
const ids = {
  workspace: '',
  dashboard: '',
  unpublished: '',
  privateDashboard: '',
  view: '',
  privateView: '',
  otherWorkspace: '',
  otherDashboard: '',
  otherView: '',
};

interface Reply {
  status: number;
  json: { data?: Record<string, unknown>; message?: string };
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Reply['json'] };
}

function query(body: unknown, caller: Caller = users.owner, wid = ids.workspace): Promise<Reply> {
  return call('POST', `/api/private/workspaces/${wid}/query`, body, caller.token);
}

async function signIn(email: string): Promise<Caller> {
  const { token } = await api.login(email);
  const me = await call('GET', '/api/private/me', undefined, token);
  return { id: String(me.json.data?.['id']), token };
}

function titles(reply: Reply): string[] {
  return ((reply.json.data?.['rows'] ?? []) as { title: string }[]).map((row) => row.title).sort();
}

const byTitle = (title: string): Record<string, unknown> => ({
  source: 'items',
  where: { combinator: 'and', rules: [{ field: 'title', operator: '=', value: title }] },
});

before(async () => {
  api = await startApiHarness('todolist_query_http');
  base = api.baseUrl;
  const models = await import('../models/index.js');

  users.owner = await signIn('owner@query.test');
  users.editor = await signIn('editor@query.test');
  users.viewer = await signIn('viewer@query.test');
  users.stranger = await signIn('stranger@query.test');

  const workspaces = await models.getWorkspaceRepository();
  const memberships = await models.getMembershipRepository();
  const items = await models.getItemRepository();
  const dashboards = await models.getDashboardRepository();
  const views = await models.getViewRepository();

  const workspace = await workspaces.create({
    name: 'Query test',
    slug: 'query-test',
    ownerId: users.owner.id,
  });
  ids.workspace = workspace.id;
  await memberships.create(workspace.id, { userId: users.owner.id, role: 'owner' });
  await memberships.create(workspace.id, { userId: users.editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: users.viewer.id, role: 'viewer' });

  const local = (title: string, topicId: 'work' | 'college' | 'personal'): Promise<unknown> =>
    items.createLocal(workspace.id, { ownerUserId: users.owner.id, title, topicId });
  await local('Draft only', 'college');
  await local('Published only', 'college');
  await local('Work item', 'work');
  await local('Personal item', 'personal');

  const listBlock = (id: string, queryJson: Record<string, unknown>): Record<string, unknown> => ({
    id,
    type: 'list',
    title: 'List',
    query: queryJson,
    viz: { kind: 'list' },
  });
  const areaQuery = {
    source: 'items',
    where: { combinator: 'and', rules: [{ field: 'topic', operator: '=', value: '$page.topic' }] },
  };
  const brokenQuery = {
    source: 'items',
    where: { combinator: 'and', rules: [{ field: 'ownerUserId', operator: '=', value: 'x' }] },
  };
  const dashboard = await dashboards.create(workspace.id, {
    ownerUserId: users.owner.id,
    title: 'Dashboard',
    vars: { topic: 'work' },
    blocks: [
      listBlock('blk_list_main', byTitle('Draft only')),
      listBlock('blk_broken', brokenQuery),
      listBlock('blk_by_area', areaQuery),
      { id: 'blk_note_1', type: 'note', title: 'Note', viz: { kind: 'note' }, note: 'hi' },
    ],
  });
  await dashboards.replaceIfVersion(workspace.id, dashboard.id, dashboard.version, {
    publishedVersion: dashboard.version,
    published: {
      title: 'Dashboard',
      vars: {},
      layouts: { lg: [], md: [], sm: [] },
      blocks: [listBlock('blk_list_main', byTitle('Published only'))],
    },
  });
  ids.dashboard = dashboard.id;
  const unpublished = await dashboards.create(workspace.id, {
    ownerUserId: users.owner.id,
    title: 'Unpublished',
    blocks: [listBlock('blk_list_main', byTitle('Draft only'))],
  });
  ids.unpublished = unpublished.id;
  const privateDashboard = await dashboards.create(workspace.id, {
    ownerUserId: users.editor.id,
    title: 'Editor private page',
    visibility: 'private',
    blocks: [listBlock('blk_list_main', byTitle('Draft only'))],
  });
  ids.privateDashboard = privateDashboard.id;

  const view = await views.create(workspace.id, {
    ownerUserId: users.owner.id,
    title: 'Work view',
    query: byTitle('Work item'),
    viz: { kind: 'list' },
  });
  ids.view = view.id;
  const privateView = await views.create(workspace.id, {
    ownerUserId: users.owner.id,
    title: 'Mine',
    query: byTitle('Personal item'),
    viz: { kind: 'list' },
    visibility: 'private',
  });
  ids.privateView = privateView.id;

  // Another workspace, which the owner is not a member of.
  const other = await workspaces.create({
    name: 'Other workspace',
    slug: 'other-workspace',
    ownerId: users.stranger.id,
  });
  ids.otherWorkspace = other.id;
  await memberships.create(other.id, { userId: users.stranger.id, role: 'owner' });
  await items.createLocal(other.id, {
    ownerUserId: users.stranger.id,
    title: 'Other workspace item',
    topicId: 'work',
  });
  const otherView = await views.create(other.id, {
    ownerUserId: users.stranger.id,
    title: 'Other view',
    query: { source: 'items' },
    viz: { kind: 'list' },
  });
  ids.otherView = otherView.id;
  const otherDashboard = await dashboards.create(other.id, {
    ownerUserId: users.stranger.id,
    title: 'Other dashboard',
    blocks: [listBlock('blk_list_main', { source: 'items' })],
  });
  ids.otherDashboard = otherDashboard.id;
});

after(async () => {
  await api.stop();
});

describe('POST /api/private/workspaces/:wid/query', () => {
  it('runs a draft', async () => {
    const reply = await query({ draft: { source: 'items' } });
    assert.equal(reply.status, 200, reply.json.message);
    const data = reply.json.data ?? {};
    assert.equal(data['total'], 4);
    assert.deepEqual(titles(reply), ['Draft only', 'Personal item', 'Published only', 'Work item']);
    for (const row of data['rows'] as { id: string; source: { url: string } }[]) {
      assert.equal(row.source.url, `/w/${ids.workspace}/items/${row.id}`);
    }
    assert.deepEqual(data['warnings'], []);
    assert.deepEqual(data['appliedVars'], {});
  });

  it('runs a draft with vars and preview, and groups', async () => {
    const reply = await query({
      draft: {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'topic', operator: '=', value: '$page.topic' }],
        },
      },
      vars: { '$page.topic': 'work' },
      preview: true,
    });
    assert.equal(reply.status, 200, reply.json.message);
    assert.deepEqual(titles(reply), ['Work item']);
    assert.deepEqual(reply.json.data?.['appliedVars'], { '$page.topic': 'work' });
    const donut = await query({
      draft: { source: 'items', groupBy: ['topic'], aggregate: { op: 'count' } },
    });
    assert.deepEqual(donut.json.data?.['groups'], [
      { key: { topic: 'college' }, value: 2 },
      { key: { topic: 'personal' }, value: 1 },
      { key: { topic: 'work' }, value: 1 },
    ]);
  });

  it('answers 400 for a field outside the whitelist, naming where and never the value', async () => {
    const reply = await query({
      draft: {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'password', operator: '=', value: 'hunter2-value' }],
        },
      },
    });
    assert.equal(reply.status, 400);
    assert.match(reply.json.message ?? '', /^\/draft\/where\/rules\/0\/field: /);
    assert.doesNotMatch(reply.json.message ?? '', /hunter2/);
  });

  it('answers 400 for a smuggled $where', async () => {
    const reply = await query({
      draft: {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'title', operator: '=', value: { $where: 'sleep(5000)' } }],
        },
      },
    });
    assert.equal(reply.status, 400);
    assert.match(reply.json.message ?? '', /^\/draft\/where\/rules\/0\/value\/\$where: /);
  });

  it('answers 400 unless the body has exactly one query', async () => {
    for (const body of [
      {},
      { savedQueryId: ids.view, draft: { source: 'items' } },
      { dashboardId: ids.dashboard },
      { draft: { source: 'items' }, vars: { topic: { $ne: null } } },
      { draft: { source: 'items' }, extra: true },
    ]) {
      const reply = await query(body);
      assert.equal(reply.status, 400, JSON.stringify(body));
      assert.equal(typeof reply.json.message, 'string');
    }
  });

  it('answers 404 to a non-member and for an unknown workspace', async () => {
    const stranger = await query({ draft: { source: 'items' } }, users.stranger);
    assert.equal(stranger.status, 404);
    assert.deepEqual(stranger.json, { message: 'Not found' });
    const unknown = await query({ draft: { source: 'items' } }, users.owner, 'no-such-workspace');
    assert.equal(unknown.status, 404);
  });

  it('shows a viewer the whole workspace: there is no area scoping', async () => {
    const reply = await query({ draft: { source: 'items' } }, users.viewer);
    assert.equal(reply.status, 200);
    assert.deepEqual(titles(reply), ['Draft only', 'Personal item', 'Published only', 'Work item']);
  });

  it('runs a saved view, and hides a private one from other members', async () => {
    const reply = await query({ savedQueryId: ids.view });
    assert.equal(reply.status, 200, reply.json.message);
    assert.deepEqual(titles(reply), ['Work item']);
    assert.equal((await query({ savedQueryId: 'no-such-view' })).status, 404);
    assert.equal((await query({ savedQueryId: ids.privateView })).status, 200);
    assert.equal((await query({ savedQueryId: ids.privateView }, users.viewer)).status, 404);
  });

  it('runs a dashboard block: the draft for editors, the published one for viewers', async () => {
    const body = { dashboardId: ids.dashboard, blockId: 'blk_list_main' };
    assert.deepEqual(titles(await query(body)), ['Draft only']);
    assert.deepEqual(titles(await query(body, users.viewer)), ['Published only']);
    const unpublished = { dashboardId: ids.unpublished, blockId: 'blk_list_main' };
    assert.equal((await query(unpublished)).status, 200);
    assert.equal((await query(unpublished, users.viewer)).status, 404);
  });

  it('answers a block of another member’s private dashboard exactly like an unknown id', async () => {
    const body = { dashboardId: ids.privateDashboard, blockId: 'blk_list_main' };
    // Its own member (an editor) runs it.
    assert.deepEqual(titles(await query(body, users.editor)), ['Draft only']);
    const unknown = await query({ dashboardId: 'no-such-dashboard', blockId: 'blk_list_main' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { message: 'Not found' });
    // The workspace owner and a viewer are other members: same status and same body.
    for (const caller of [users.owner, users.viewer]) {
      const reply = await query(body, caller);
      assert.equal(reply.status, 404);
      assert.deepEqual(reply.json, unknown.json);
    }
  });

  it('defaults the dashboard vars, which the request vars override', async () => {
    const body = { dashboardId: ids.dashboard, blockId: 'blk_by_area' };
    const byDefault = await query(body);
    assert.deepEqual(titles(byDefault), ['Work item']);
    assert.deepEqual(byDefault.json.data?.['appliedVars'], { '$page.topic': 'work' });
    const overridden = await query({ ...body, vars: { '$page.topic': 'personal' } });
    assert.deepEqual(titles(overridden), ['Personal item']);
    const cleared = await query({ ...body, vars: { topic: null } });
    assert.equal(cleared.json.data?.['total'], 4);
    assert.equal((cleared.json.data['warnings'] as string[]).length, 1);
  });

  it("answers 404 for another workspace's view or dashboard, and never shows its items", async () => {
    const view = await query({ savedQueryId: ids.otherView });
    assert.equal(view.status, 404);
    const block = await query({ dashboardId: ids.otherDashboard, blockId: 'blk_list_main' });
    assert.equal(block.status, 404);
    const draft = await query({ draft: { source: 'items' } });
    assert.ok(!titles(draft).includes('Other workspace item'));
    const theirs = await query({ savedQueryId: ids.otherView }, users.stranger, ids.otherWorkspace);
    assert.deepEqual(titles(theirs), ['Other workspace item']);
  });

  it('answers 404 for an unknown dashboard or block, and 400 for a broken or query-less block', async () => {
    assert.equal(
      (await query({ dashboardId: 'no-such-dashboard', blockId: 'blk_list_main' })).status,
      404,
    );
    assert.equal((await query({ dashboardId: ids.dashboard, blockId: 'blk_missing' })).status, 404);
    const broken = await query({ dashboardId: ids.dashboard, blockId: 'blk_broken' });
    assert.equal(broken.status, 400);
    assert.match(broken.json.message ?? '', /^\/blocks\/1\/query\/where\/rules\/0\/field: /);
    const note = await query({ dashboardId: ids.dashboard, blockId: 'blk_note_1' });
    assert.equal(note.status, 400);
  });
});
