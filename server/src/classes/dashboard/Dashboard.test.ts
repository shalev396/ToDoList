/**
 * The Dashboard class on a throwaway MongoDB, where the old service's suites don't reach: the
 * operation's role is checked before the dashboard is read (403 before 404), a method holds its
 * own checks on any loaded dashboard, `save` is one compare-and-set with its history entry,
 * `listAll` (a natural-key lookup) sees what `list` hides, a persona's role comes before its key,
 * and a workspace's end removes its dashboards, histories and views (removeAllIn).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerFor, hasStatus, newUser } from '../../testing/workspaceFixtures.js';
import type { DashboardView } from '../../types/dashboards.js';
import type { Caller } from '../base/Caller.js';
import type * as DashboardModule from './index.js';

let db: TestDatabase;
let classes: typeof DashboardModule;

before(async () => {
  db = await startTestDatabase('todolist_classes_dashboard');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  classes = await import('./index.js');
});

after(async () => {
  await db.stop();
});

interface Team {
  workspaceId: string;
  owner: Caller;
  editor: Caller;
  viewer: Caller;
}

/** A workspace with an owner, an editor and a viewer. */
async function team(label: string): Promise<Team> {
  const models = await import('../../models/index.js');
  const [owner, editor, viewer] = await Promise.all(
    ['owner', 'editor', 'viewer'].map((role) => newUser(`${label}-${role}`)),
  );
  assert.ok(owner && editor && viewer);
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: label, slug: label, ownerId: owner.id });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: owner.id, role: 'owner' });
  await memberships.create(workspace.id, { userId: editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: viewer.id, role: 'viewer' });
  return {
    workspaceId: workspace.id,
    owner: await callerFor(workspace.id, owner.id),
    editor: await callerFor(workspace.id, editor.id),
    viewer: await callerFor(workspace.id, viewer.id),
  };
}

const RENAME = (title: string): { op: string; title: string } => ({ op: 'set_title', title });

describe('Dashboard: the role before anything is read', () => {
  it('a viewer gets 403 on a missing dashboard; an editor gets 404', async () => {
    const { Dashboard } = classes;
    const t = await team('dash-role-first');
    await assert.rejects(
      Dashboard.load(t.viewer, 'no-such-dashboard', Dashboard.Operation.edit),
      (error: unknown) =>
        hasStatus(403)(error) && (error as Error).message === 'Only an editor can edit dashboards',
    );
    await assert.rejects(
      Dashboard.load(t.editor, 'no-such-dashboard', Dashboard.Operation.edit),
      hasStatus(404),
    );
    await assert.rejects(
      Dashboard.load(t.editor, 'no-such-dashboard', Dashboard.Operation.publish),
      hasStatus(403),
    );
  });

  it('a method checks again: a loaded dashboard refuses a caller it would not load for', async () => {
    const { Dashboard } = classes;
    const t = await team('dash-method-checks');
    const created = await Dashboard.create(t.owner, { title: 'Shared', language: 'en' });
    const dashboard = await Dashboard.load(t.owner, created.id, Dashboard.Operation.edit);
    await assert.rejects(
      dashboard.applyOps(t.viewer, { expectedVersion: 1, ops: [RENAME('Viewer')] }),
      hasStatus(403),
    );
    await assert.rejects(dashboard.publish(t.editor, { expectedVersion: 1 }), hasStatus(403));
    const other = await team('dash-method-other');
    await assert.rejects(dashboard.view(other.owner), hasStatus(404));
    assert.equal((await Dashboard.load(t.owner, created.id)).version, 1, 'nothing was written');
  });

  it('a persona: the role first, then the key', async () => {
    const { Persona } = classes;
    const t = await team('dash-persona-role');
    const input = { personaKey: 'no-such-persona', language: 'en' as const };
    await assert.rejects(Persona.plan(t.viewer, input), hasStatus(403));
    await assert.rejects(Persona.plan(t.editor, input), hasStatus(404));
    await assert.rejects(Persona.instantiate(t.viewer, input), hasStatus(403));
  });
});

/** A dashboard's stored versions, newest first (tests read the repository directly). */
async function storedVersions(
  workspaceId: string,
  dashboardId: string,
): Promise<{ version: number; summary: string | null; patch: unknown[] }[]> {
  const { getDashboardVersionRepository } = await import('../../models/index.js');
  const entries = await (await getDashboardVersionRepository()).list(workspaceId, dashboardId, 20);
  return entries.map(({ version, summary, patch }) => ({ version, summary, patch }));
}

/** The draft a view shows, as `save` takes it. */
function draftOf(view: DashboardView): Parameters<DashboardModule.Dashboard['save']>[1] {
  return {
    title: view.title,
    scope: view.scope,
    vars: view.vars,
    layouts: view.layouts,
    blocks: view.blocks,
  };
}

describe('Dashboard#save', () => {
  it('writes the next version with its history entry; a stale version is a 409 with the current one', async () => {
    const { Dashboard } = classes;
    const t = await team('dash-save');
    const created = await Dashboard.create(t.editor, { title: 'First', language: 'en' });
    const dashboard = await Dashboard.load(t.editor, created.id, Dashboard.Operation.edit);
    const draft = { ...draftOf(created), title: 'Second' };
    assert.equal(await dashboard.save(t.editor, draft, 1, { summary: 'rename' }), 2);
    assert.deepEqual(await storedVersions(t.workspaceId, created.id), [
      {
        version: 2,
        summary: 'rename',
        patch: [{ op: 'replace', path: '/title', value: 'Second' }],
      },
      { version: 1, summary: 'create', patch: [] },
    ]);
    // The instance was read at version 1: stale now, whichever version it names.
    for (const ifVersion of [1, 2]) {
      await assert.rejects(
        dashboard.save(t.editor, { ...draft, title: 'Stale' }, ifVersion, { summary: 'stale' }),
        (error: unknown) =>
          hasStatus(409)(error) && (error as { currentVersion?: number }).currentVersion === 2,
      );
    }
    const now = await Dashboard.load(t.editor, created.id);
    assert.deepEqual([now.title, now.version], ['Second', 2]);
  });

  it('cannot publish, skip the checks or write the history’s patches: only the summary is read', async () => {
    const { Dashboard } = classes;
    const t = await team('dash-save-narrow');
    const created = await Dashboard.create(t.editor, { title: 'First', language: 'en' });
    await (
      await Dashboard.load(t.owner, created.id, Dashboard.Operation.publish)
    ).publish(t.owner, { expectedVersion: 1 });
    const dashboard = await Dashboard.load(t.editor, created.id, Dashboard.Operation.edit);
    const forged = [{ op: 'replace', path: '/title', value: 'Forged' }];
    // Whatever a caller passes besides the summary, as if the old commit's fields were accepted.
    const wide = dashboard.save.bind(dashboard) as (
      caller: Caller,
      doc: unknown,
      ifVersion: number,
      change: unknown,
    ) => Promise<number>;
    const version = await wide(
      t.editor,
      { ...draftOf(created), title: 'Edited', scope: { ...created.scope, page: 'group' } },
      1,
      {
        summary: 'edit',
        published: { copy: { title: 'Forged', vars: {}, layouts: created.layouts, blocks: [] } },
        patch: forged,
        inverse: forged,
      },
    );
    assert.equal(version, 2);
    const after = await Dashboard.load(t.editor, created.id);
    assert.equal(after.publishedVersion, 1, 'an editor’s save never publishes');
    assert.equal((await after.view(t.editor, { as: 'published' })).title, 'First');
    assert.equal(after.scope.page, created.scope.page, 'the scope stays the stored one');
    const [entry] = await storedVersions(t.workspaceId, created.id);
    assert.deepEqual(entry, {
      version: 2,
      summary: 'edit',
      patch: [{ op: 'replace', path: '/title', value: 'Edited' }],
    });

    // The checks a write makes: the secret scan, and the document's own validation.
    await assert.rejects(
      after.save(
        t.editor,
        { ...draftOf(created), title: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123' },
        2,
        {
          summary: 'secret',
        },
      ),
      hasStatus(400),
    );
    await assert.rejects(
      after.save(
        t.editor,
        { ...draftOf(created), blocks: [{ id: 'b', type: 'nope' }] } as never,
        2,
        {
          summary: 'invalid',
        },
      ),
      hasStatus(400),
    );
    await assert.rejects(
      after.save(t.viewer, draftOf(created), 2, { summary: 'viewer' }),
      hasStatus(403),
    );
    assert.equal(
      (await Dashboard.load(t.editor, created.id)).version,
      2,
      'nothing more was written',
    );
  });
});

describe('Dashboard.listAll', () => {
  it('sees another member’s private page, which list hides', async () => {
    const { Dashboard } = classes;
    const models = await import('../../models/index.js');
    const t = await team('dash-list-all');
    const mine = await (
      await models.getDashboardRepository()
    ).create(t.workspaceId, {
      ownerUserId: t.editor.userId,
      title: 'Private',
      visibility: 'private',
    });
    const all = await Dashboard.listAll(t.owner);
    assert.ok(all.some((dashboard) => dashboard.id === mine.id));
    const listed = await Dashboard.list(t.owner, {});
    assert.ok(!listed.some((dashboard) => dashboard.id === mine.id));
    await assert.rejects(Dashboard.load(t.owner, mine.id), hasStatus(404));
  });
});

describe('Dashboard.removeAllIn and View.removeAllIn', () => {
  it('remove a workspace’s dashboards (deleted ones too), histories and views, and nothing else', async () => {
    const { Dashboard, View } = classes;
    const t = await team('dash-remove-all');
    const keep = await team('dash-remove-keep');
    for (const workspace of [t, keep]) {
      const created = await Dashboard.create(workspace.owner, { title: 'Page', language: 'en' });
      const gone = await Dashboard.create(workspace.owner, { title: 'Gone', language: 'en' });
      await (
        await Dashboard.load(workspace.owner, gone.id, Dashboard.Operation.delete)
      ).delete(workspace.owner);
      await (
        await Dashboard.load(workspace.owner, created.id, Dashboard.Operation.edit)
      ).applyOps(workspace.owner, { expectedVersion: 1, ops: [RENAME('Renamed')] });
      await View.create(workspace.owner, {
        title: 'View',
        query: { source: 'items' },
        viz: { kind: 'list' },
      });
    }
    assert.deepEqual(await Dashboard.removeAllIn(t.workspaceId), { dashboards: 2, versions: 3 });
    assert.equal(await View.removeAllIn(t.workspaceId), 1);
    assert.deepEqual(await Dashboard.removeAllIn(t.workspaceId), { dashboards: 0, versions: 0 });
    assert.deepEqual(await Dashboard.listAll(t.owner), []);
    assert.deepEqual(await View.list(t.owner), []);
    assert.equal((await Dashboard.listAll(keep.owner)).length, 1);
    assert.equal((await View.list(keep.owner)).length, 1);
  });
});
