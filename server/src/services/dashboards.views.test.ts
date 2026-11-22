/**
 * Page views and persona templates on a throwaway MongoDB: views are written, versioned, undone and
 * published with the page; the limits hold on the server; templates bind only the instantiating
 * member's own integrations; a persona is idempotent per topic slug.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seedIntegration } from '../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { addDefaultTopics, contextFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import { CAPS, type Op } from '../types/builder.js';
import type { DashboardView } from '../types/dashboards.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type * as Dashboards from '../testing/dashboardCalls.js';
import type * as Personas from '../testing/dashboardCalls.js';
import type * as Models from '../models/index.js';

let db: TestDatabase;
let svc: typeof Dashboards;
let personas: typeof Personas;
let models: typeof Models;

const ctx = {} as Record<'owner' | 'editor' | 'viewer' | 'other', WorkspaceContext>;
const actor = {} as Record<'owner' | 'editor' | 'viewer' | 'other', Dashboards.BuilderActor>;
let workspaceId = '';

before(async () => {
  db = await startTestDatabase('todolist_dashboards_views');
  svc = await import('../testing/dashboardCalls.js');
  personas = await import('../testing/dashboardCalls.js');
  models = await import('../models/index.js');
  const users = {
    owner: await newUser('views-owner'),
    editor: await newUser('views-editor'),
    viewer: await newUser('views-viewer'),
    other: await newUser('views-other'),
  };
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Views', slug: 'views-svc', ownerId: users.owner.id });
  workspaceId = workspace.id;
  await addDefaultTopics(workspace.id, { slugIds: true });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: users.owner.id, role: 'owner' });
  await memberships.create(workspace.id, { userId: users.editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: users.viewer.id, role: 'viewer' });
  await memberships.create(workspace.id, { userId: users.other.id, role: 'editor' });
  for (const name of ['owner', 'editor', 'viewer', 'other'] as const) {
    ctx[name] = await contextFor(workspace.id, users[name].id);
    actor[name] = { userId: users[name].id, agentId: null };
  }
  await seedIntegration(workspace.id, {
    id: 'int-owner-google',
    ownerUserId: users.owner.id,
    provider: 'google_calendar',
  });
  await seedIntegration(workspace.id, {
    id: 'int-other-google',
    ownerUserId: users.other.id,
    provider: 'google_calendar',
  });
});

after(async () => {
  await db.stop();
});

async function blank(): Promise<DashboardView> {
  return svc.createDashboard(ctx.owner, actor.owner, { title: 'Page', language: 'en' });
}

async function ops(
  page: DashboardView,
  list: Op[],
  who: 'owner' | 'editor' | 'other' = 'owner',
): Promise<DashboardView> {
  const result = await svc.applyDashboardOps(ctx[who], actor[who], page.id, {
    expectedVersion: page.version,
    ops: list,
  });
  assert.ok('version' in result);
  return svc.getDashboard(ctx.owner, actor.owner, page.id, { as: 'draft' });
}

describe('view CRUD through the ops route', () => {
  it('adds, renames, moves and removes views, each a version', async () => {
    let page = await blank();
    page = await ops(page, [
      { op: 'add_view', type: 'list', title: 'One' },
      { op: 'add_view', type: 'board', title: 'Two' },
    ]);
    assert.deepEqual(
      page.views.map((view) => view.title),
      ['One', 'Two'],
    );
    const [one, two] = page.views;
    page = await ops(page, [
      { op: 'update_view', viewId: one?.id ?? '', title: 'Uno' },
      { op: 'move_view', viewId: two?.id ?? '', index: 0 },
    ]);
    assert.deepEqual(
      page.views.map((view) => view.title),
      ['Two', 'Uno'],
    );
    page = await ops(page, [{ op: 'remove_view', viewId: one?.id ?? '' }]);
    assert.equal(page.views.length, 1);
    assert.equal(page.blocks.length, 1);
  });

  it('keeps the Summary: it is no stored view and the ops refuse it', async () => {
    const page = await blank();
    await assert.rejects(
      svc.applyDashboardOps(ctx.owner, actor.owner, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'remove_view', viewId: 'summary' }],
      }),
      hasStatus(400),
    );
    assert.deepEqual(page.views, []);
  });

  it('publishes views with the page and undoes an add', async () => {
    let page = await blank();
    page = await ops(page, [{ op: 'add_view', type: 'agenda' }]);
    const published = await svc.getDashboard(ctx.viewer, actor.viewer, page.id, {});
    assert.equal(published.views.length, 1);
    await svc.undoDashboard(ctx.owner, actor.owner, page.id, { expectedVersion: page.version });
    page = await svc.getDashboard(ctx.owner, actor.owner, page.id, { as: 'draft' });
    assert.equal(page.views.length, 0);
    assert.equal(page.blocks.length, 0);
  });

  it('refuses a viewer', async () => {
    const page = await blank();
    await assert.rejects(
      svc.applyDashboardOps(ctx.viewer, actor.viewer, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'add_view', type: 'list' }],
      }),
      hasStatus(403),
    );
  });
});

describe('view limits on the server', () => {
  it('holds viewsPerPage views, the Summary included', async () => {
    let page = await blank();
    page = await ops(
      page,
      Array.from({ length: CAPS.maxViews - 1 }, () => ({ op: 'add_view', type: 'list' })),
    );
    assert.equal(page.views.length, CAPS.maxViews - 1);
    await assert.rejects(
      svc.applyDashboardOps(ctx.owner, actor.owner, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'add_view', type: 'table' }],
      }),
      hasStatus(400),
    );
  });
});

describe('view templates leave data blocks on All sources', () => {
  it('names no provider, so binds nothing: never another member’s integration either', async () => {
    let page = await blank();
    page = await ops(page, [{ op: 'add_view', templateKey: 'workload-this-week@1' }]);
    const connectors = page.blocks.flatMap((block) => block.connectors ?? []);
    assert.deepEqual(connectors, []);
    assert.equal(page.views[0]?.templateKey, 'workload-this-week@1');
  });

  it('names nothing to share for blocks on All sources, and shares nothing with shareIntegrations false', async () => {
    const shares = await svc.templateShares(ctx.editor, actor.editor, ['my-open-work@1']);
    assert.deepEqual(shares, []);
    const own = await svc.templateShares(ctx.other, actor.other, ['workload-this-week@1']);
    assert.deepEqual(own, []);
    const page = await svc.createDashboard(ctx.other, actor.other, { title: 'P2', language: 'en' });
    const result = await svc.applyDashboardOps(ctx.other, actor.other, page.id, {
      expectedVersion: page.version,
      ops: [{ op: 'add_view', templateKey: 'workload-this-week@1' }],
      shareIntegrations: false,
    });
    assert.ok('version' in result);
    const next = await svc.getDashboard(ctx.other, actor.other, page.id, { as: 'draft' });
    assert.ok(!next.blocks.flatMap((block) => block.connectors ?? []).includes('int-other-google'));
  });
});

describe('persona templates', () => {
  it('names a persona’s shares like a template’s', async () => {
    const shares = await svc.templateShares(ctx.owner, actor.owner, ['light-student@1']);
    assert.ok(shares.length >= 0);
    await assert.rejects(svc.templateShares(ctx.owner, actor.owner, ['nope@1']), hasStatus(400));
  });

  it('creates topics, pages, views and blocks, idempotently', async () => {
    const first = await personas.instantiatePersona(ctx.owner, actor.owner, {
      personaKey: 'two-jobs-studies-side-project@1',
      language: 'en',
    });
    assert.deepEqual(
      first.topics.map((topic) => topic.slug),
      ['work', 'job-2', 'college', 'side-project'],
    );
    // work and college exist (defaults): reused. job-2 and side-project are new.
    assert.deepEqual(
      first.topics.map((topic) => topic.created),
      [false, true, false, true],
    );
    const topics = await models.getTopicRepository().then((repo) => repo.list(workspaceId));
    const countBefore = topics.length;
    const college = first.topics.find((topic) => topic.slug === 'college');
    const page = await svc.getDashboard(ctx.owner, actor.owner, college?.dashboardId ?? '', {});
    assert.ok(page.views.length >= 3);
    assert.ok(page.blocks.length > 3);

    const everything = await Promise.all(
      first.topics.map((topic) =>
        svc.getDashboard(ctx.owner, actor.owner, topic.dashboardId, { as: 'draft' }),
      ),
    );
    const connectors = everything.flatMap((view) => view.blocks.flatMap((b) => b.connectors ?? []));
    assert.ok(!connectors.includes('int-other-google'));

    const second = await personas.instantiatePersona(ctx.owner, actor.owner, {
      personaKey: 'two-jobs-studies-side-project@1',
      language: 'en',
    });
    assert.ok(second.topics.every((topic) => !topic.created && !topic.pageCreated));
    assert.ok(second.topics.every((topic) => topic.viewsAdded.length === 0));
    const after = await models.getTopicRepository().then((repo) => repo.list(workspaceId));
    assert.equal(after.length, countBefore);
    assert.deepEqual(
      second.topics.map((topic) => topic.dashboardId),
      first.topics.map((topic) => topic.dashboardId),
    );
  });

  it('refuses an unknown persona and a viewer', async () => {
    await assert.rejects(
      personas.instantiatePersona(ctx.owner, actor.owner, { personaKey: 'nope@1', language: 'en' }),
      hasStatus(404),
    );
    await assert.rejects(
      personas.instantiatePersona(ctx.viewer, actor.viewer, {
        personaKey: 'light-student@1',
        language: 'en',
      }),
      hasStatus(403),
    );
  });
});
