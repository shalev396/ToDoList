/**
 * H5: one row, not three, in the item list (REST and MCP search_items). A provider copy of a local
 * to-do is hidden only while its to-do shows in the same list: the to-do is one the viewer may see
 * (shared, or the viewer made it) and it matches the list's filters and search. So the copy
 * follows the to-do's sharing, is released when it is deleted, shows when the list is filtered
 * by its provider alone, by a status or a search the to-do does not match, and stays hidden on
 * every page when the to-do is on another one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type * as Items from '../testing/itemCalls.js';
import type * as Models from '../models/index.js';
import type { CreateLocalItemInput, ItemData, ItemUpsert } from '../models/definitions/Item.js';

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

/**
 * A local to-do with one Linear copy, hidden for whoever sees the to-do in the same list. `extra`
 * sets more of the to-do's fields and of the copy's.
 */
async function todoWithCopy(
  visibility: 'workspace' | 'private',
  extra: { todo?: Partial<CreateLocalItemInput>; copy?: Partial<ItemUpsert> } = {},
): Promise<{ todo: ItemData; copyId: string }> {
  n += 1;
  const repo = await models.getItemRepository();
  const todo = await repo.createLocal(ws.id, {
    ownerUserId: 'u-owner',
    title: `Local ${String(n)}`,
    topicId: null,
    visibility,
    ...extra.todo,
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
      ...extra.copy,
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

  it('a done to-do with an open copy: a list of open items shows the copy', async () => {
    const { todo, copyId } = await todoWithCopy('workspace', { todo: { status: 'done' } });
    const open = await idsOf('u-owner', { status: ['open', 'in_progress'] });
    assert.ok(open.includes(copyId), 'the open issue no longer vanishes');
    assert.ok(!open.includes(todo.id));
    const done = await idsOf('u-owner', { status: 'done' });
    assert.ok(done.includes(todo.id) && !done.includes(copyId));
    // No filter: both are in the list, one row.
    const all = await idsOf('u-owner');
    assert.ok(all.includes(todo.id) && !all.includes(copyId));
  });

  it('a search the to-do does not match shows the copy; one it matches shows the to-do', async () => {
    const { todo, copyId } = await todoWithCopy('workspace', {
      todo: { title: 'Quarterly taxes' },
      copy: { title: 'Accountant call' },
    });
    assert.deepEqual(await idsOf('u-owner', { q: 'accountant' }), [copyId]);
    assert.deepEqual(await idsOf('u-owner', { q: 'quarterly' }), [todo.id]);
  });

  it('every page leaves out a copy whose to-do is in the list, on any page', async () => {
    const day = (days: number): Date => new Date(Date.UTC(2031, 0, days, 12));
    // By due date: the to-do first, then another to-do, then the copy.
    const { todo, copyId } = await todoWithCopy('workspace', {
      todo: { topicId: 't-pages', dueAt: day(1) },
      copy: { topicId: 't-pages', dueAt: day(5) },
    });
    const repo = await models.getItemRepository();
    const other = await repo.createLocal(ws.id, {
      ownerUserId: 'u-owner',
      title: 'In between',
      topicId: 't-pages',
      dueAt: day(3),
      visibility: 'workspace',
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await items.listItems(ws, 'u-owner', {
        topicId: 't-pages',
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(seen, [todo.id, other.id]);
    assert.ok(!seen.includes(copyId));
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
