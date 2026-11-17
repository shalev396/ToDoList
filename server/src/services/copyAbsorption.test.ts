/**
 * H5: one row, not three. A provider copy of a local to-do is hidden from whoever sees the to-do
 * (shared, or the viewer made it), follows the to-do's sharing, is released when it is deleted,
 * and still shows when the list is filtered by its provider alone.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type * as Items from '../testing/itemCalls.js';
import type * as Models from '../models/index.js';
import type { ItemData } from '../models/definitions/Item.js';

let db: TestDatabase;
let items: typeof Items;
let models: typeof Models;
let ws: WorkspaceContext;
/** The owner's Linear integration, shared on a block so every member sees what it holds. */
let integrationId = '';

before(async () => {
  db = await startTestDatabase('todolist_copy_absorption_test');
  items = await import('../testing/itemCalls.js');
  models = await import('../models/index.js');
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Copies', slug: 'copies', ownerId: 'u-owner' });
  ws = { id: created.id, role: 'editor', settings: created.settings };
  const integration = await (
    await models.getIntegrationRepository()
  ).create(ws.id, {
    connectedBy: 'u-owner',
    provider: 'linear',
    accountId: 'acct',
    label: 'Linear',
    authMethod: 'oauth',
    topicId: null,
  });
  integrationId = integration.id;
  // Share-on-attach: a connector on a block makes the integration's items visible to members.
  const { DashboardMongoModel } = await import('../models/mongoose/Dashboard.js');
  await DashboardMongoModel.collection.insertOne({
    workspaceId: ws.id,
    deletedAt: null,
    blocks: [{ connectors: [integrationId] }],
  });
});

after(async () => {
  await db.stop();
});

let n = 0;

/** A local to-do with one Linear copy, hidden for whoever sees the to-do. */
async function todoWithCopy(
  visibility: 'workspace' | 'private',
): Promise<{ todo: ItemData; copyId: string }> {
  n += 1;
  const repo = await models.getItemRepository();
  const todo = await repo.createLocal(ws.id, {
    ownerUserId: 'u-owner',
    title: `Local ${String(n)}`,
    topicId: null,
    visibility,
  });
  await repo.addCopy(ws.id, todo.id, {
    integrationId,
    provider: 'linear',
    externalId: `lin-${String(n)}`,
    key: `ABC-${String(n)}`,
    url: 'https://linear.example/ABC',
    status: 'created',
    requestId: `req-${String(n)}`,
    at: new Date(),
  });
  await repo.bulkUpsert(ws.id, [
    {
      integrationId: integrationId,
      kind: 'issue',
      topicId: null,
      title: `Linear ${String(n)}`,
      status: 'open',
      source: {
        provider: 'linear',
        accountId: 'acct',
        externalId: `lin-${String(n)}`,
        key: `ABC-${String(n)}`,
        url: 'https://linear.example/ABC',
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    },
  ]);
  const mirrored = await repo.findBySource(
    ws.id,
    { provider: 'linear', accountId: 'acct', integrationId: integrationId },
    `lin-${String(n)}`,
  );
  assert.ok(mirrored);
  await repo.setOverlay(ws.id, mirrored.id, {
    copyOf: todo.id,
    copyOfOwner: 'u-owner',
    copyOfShared: visibility === 'workspace',
  });
  return { todo, copyId: mirrored.id };
}

const idsOf = async (userId: string, query: Items.ItemListQuery = {}): Promise<string[]> =>
  (await items.listItems(ws, userId, query)).items.map((item) => item.id);

describe('the absorption rule', () => {
  it('hides the copy from everyone when the to-do is shared', async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    for (const user of ['u-owner', 'u-other']) {
      const ids = await idsOf(user);
      assert.ok(ids.includes(todo.id));
      assert.ok(!ids.includes(copyId));
    }
  });

  it('hides a private to-do copy from its owner only', async () => {
    const { todo, copyId } = await todoWithCopy('private');
    const own = await idsOf('u-owner');
    assert.ok(own.includes(todo.id) && !own.includes(copyId));
    const other = await idsOf('u-other');
    assert.ok(!other.includes(todo.id) && other.includes(copyId));
  });

  it('still shows the copy when the list is filtered by its provider alone', async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    const ids = await idsOf('u-owner', { provider: 'linear' });
    assert.ok(ids.includes(copyId));
    assert.ok(!ids.includes(todo.id));
  });

  it("the to-do's row carries a chip per copy, with the copy's live status", async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    const repo = await models.getItemRepository();
    await repo.bulkUpsert(ws.id, [
      {
        integrationId: integrationId,
        kind: 'issue',
        topicId: null,
        title: 'Linear moved on',
        status: 'in_progress',
        source: {
          provider: 'linear',
          accountId: 'acct',
          externalId: `lin-${String(n)}`,
          key: null,
          url: 'https://linear.example/ABC',
          updatedAtSource: null,
          etag: null,
          hash: 'changed',
        },
      },
    ]);
    const row = (await items.listItems(ws, 'u-owner', {})).items.find((i) => i.id === todo.id);
    assert.ok(row);
    assert.deepEqual(
      row.copies.map((copy) => [copy.provider, copy.liveStatus]),
      [['linear', 'in_progress']],
    );
    assert.ok(copyId);
  });

  it("follows the to-do's sharing", async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    const repo = await models.getItemRepository();
    assert.ok(!(await idsOf('u-other')).includes(copyId));
    await repo.updateLocal(ws.id, todo.id, { visibility: 'private' });
    const other = await idsOf('u-other');
    assert.ok(other.includes(copyId), 'a private to-do no longer hides the copy from others');
    assert.ok(!(await idsOf('u-owner')).includes(copyId));
    await repo.updateLocal(ws.id, todo.id, { visibility: 'workspace' });
    assert.ok(!(await idsOf('u-other')).includes(copyId));
  });

  it('is released when the to-do is deleted: the copy is an ordinary mirrored item again', async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    await items.deleteItem(ws, 'u-owner', todo.id);
    const ids = await idsOf('u-other');
    assert.ok(ids.includes(copyId));
    const repo = await models.getItemRepository();
    const copy = await repo.findById(ws.id, copyId);
    assert.ok(copy);
    assert.equal(copy.overlay.copyOf, null);
    assert.equal(copy.deletedAt, null);
  });

  it('a copy opens by id for whoever may see it, and its provider shows in the facets', async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    const opened = await items.getItem(ws, 'u-owner', copyId);
    assert.equal(opened.id, copyId);
    assert.equal(opened.source.provider, 'linear');
    const overlaid = await items.updateOverlay(ws, 'u-owner', copyId, { pinned: true });
    assert.equal(overlaid.overlay.pinned, true);
    assert.ok((await items.getFacets(ws, 'u-owner')).providers.includes('linear'));
    assert.ok(todo.id);
  });

  it('records a copy once per requestId', async () => {
    const repo = await models.getItemRepository();
    const todo = await repo.createLocal(ws.id, {
      ownerUserId: 'u-owner',
      title: 'Once',
      topicId: null,
    });
    const copy = {
      integrationId: 'i',
      provider: 'jira',
      externalId: '',
      key: null,
      url: '',
      status: 'pending' as const,
      requestId: 'same',
      at: new Date(),
    };
    assert.equal(await repo.addCopy(ws.id, todo.id, copy), true);
    assert.equal(await repo.addCopy(ws.id, todo.id, copy), false);
    const updated = await repo.updateCopy(ws.id, todo.id, 'same', {
      status: 'created',
      key: 'A-1',
    });
    assert.ok(updated);
    assert.equal(updated.copies.length, 1);
    assert.deepEqual(
      updated.copies.map((entry) => entry.key),
      ['A-1'],
    );
    // List rows carry the chips in `props.copies` (a dashboard row has props, not copies).
    assert.deepEqual(
      (updated.props['copies'] as { at?: unknown }[]).map(({ at, ...chip }) => ({
        ...chip,
        hasAt: at instanceof Date,
      })),
      [{ provider: 'jira', key: 'A-1', url: '', status: 'created', hasAt: true }],
    );
  });
});
