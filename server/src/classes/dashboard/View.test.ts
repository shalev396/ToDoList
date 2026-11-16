/**
 * Saved views (View) on a throwaway MongoDB: each operation's role before the view is read (403
 * before 404), a private view is its owner's alone, every write is checked (the query compiles,
 * the viz fits the catalog, no secret) and audited under its own action, and the public shape is
 * field by field.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerFor, hasStatus, newUser } from '../../testing/workspaceFixtures.js';
import type { Caller } from '../base/Caller.js';
import type { View as ViewClass } from './View.js';

let db: TestDatabase;
let View: typeof ViewClass;

before(async () => {
  db = await startTestDatabase('todolist_classes_view');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  ({ View } = await import('./View.js'));
});

after(async () => {
  await db.stop();
});

async function team(
  label: string,
): Promise<{ workspaceId: string; owner: Caller; editor: Caller; viewer: Caller }> {
  const models = await import('../../models/index.js');
  const owner = await newUser(`${label}-owner`);
  const editor = await newUser(`${label}-editor`);
  const viewer = await newUser(`${label}-viewer`);
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

const LIST = { title: 'Open tasks', query: { source: 'items' }, viz: { kind: 'list' } };

async function actionsOf(workspaceId: string): Promise<string[]> {
  const { getAuditLogRepository } = await import('../../models/index.js');
  const entries = await (await getAuditLogRepository()).list(workspaceId, {}, 20);
  return entries.map((entry) => entry.action).reverse();
}

describe('View', () => {
  it('creates, updates and deletes, each audited; the shape is field by field', async () => {
    const t = await team('view-crud');
    const view = await View.create(t.editor, LIST);
    assert.deepEqual(Object.keys(view.toView()).sort(), [
      'createdAt',
      'id',
      'ownerUserId',
      'query',
      'title',
      'updatedAt',
      'visibility',
      'viz',
    ]);
    assert.equal(view.ownerUserId, t.editor.userId);
    assert.ok(view.isOwnedBy(t.editor.userId));
    assert.deepEqual(view.query.toJSON(), { source: 'items' });
    const updated = await (
      await View.load(t.owner, view.id, View.Operation.edit)
    ).update(t.owner, {
      title: 'Renamed',
    });
    assert.equal(updated.title, 'Renamed');
    await (await View.load(t.owner, view.id, View.Operation.delete)).delete(t.owner);
    await assert.rejects(View.load(t.owner, view.id), hasStatus(404));
    assert.deepEqual(await actionsOf(t.workspaceId), ['view.create', 'view.update', 'view.delete']);
  });

  it('the role first: a viewer gets 403 even for a view that does not exist', async () => {
    const t = await team('view-role-first');
    await assert.rejects(View.create(t.viewer, LIST), hasStatus(403));
    await assert.rejects(View.load(t.viewer, 'no-such-view', View.Operation.edit), hasStatus(403));
    await assert.rejects(View.load(t.editor, 'no-such-view', View.Operation.edit), hasStatus(404));
    const view = await View.create(t.editor, LIST);
    const loaded = await View.load(t.viewer, view.id);
    await assert.rejects(loaded.update(t.viewer, { title: 'Viewer' }), hasStatus(403));
    await assert.rejects(loaded.delete(t.viewer), hasStatus(403));
  });

  it('a private view is its owner’s alone', async () => {
    const t = await team('view-private');
    const mine = await View.create(t.editor, { ...LIST, visibility: 'private' });
    await assert.rejects(View.load(t.owner, mine.id), hasStatus(404));
    assert.ok(!(await View.list(t.owner)).some((view) => view.id === mine.id));
    assert.ok((await View.list(t.editor)).some((view) => view.id === mine.id));
  });

  it('refuses a query that does not compile, a viz the catalog lacks, and secrets', async () => {
    const t = await team('view-checks');
    await assert.rejects(
      View.create(t.editor, { ...LIST, query: { source: 'nope' } }),
      hasStatus(400),
    );
    await assert.rejects(View.create(t.editor, { ...LIST, viz: { kind: 'nope' } }), hasStatus(400));
    await assert.rejects(
      View.create(t.editor, { ...LIST, title: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123' }),
      hasStatus(400),
    );
    assert.deepEqual(await View.list(t.editor), []);
  });
});
