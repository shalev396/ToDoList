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

  it('a soft-deleted to-do whose copy is still marked: the list shows the copy', async () => {
    const { todo, copyId } = await todoWithCopy('workspace');
    const mongoose = (await import('mongoose')).default;
    // As if its release never ran: the copy still names the to-do.
    await mongoose.connection
      .collection('Items')
      .updateOne({ _id: todo.id as never }, { $set: { deletedAt: new Date() } });
    const ids = await idsOf('u-owner');
    assert.ok(ids.includes(copyId) && !ids.includes(todo.id));
  });

  it('a saved block’s hide display rule: its done to-do, hidden, no longer hides the open copy', async () => {
    const { todo, copyId } = await todoWithCopy('workspace', {
      todo: { status: 'done', topicId: 't-hide' },
      copy: { topicId: 't-hide' },
    });
    const { createDashboard, applyDashboardOps, getDashboard } =
      await import('../testing/dashboardCalls.js');
    const { runWorkspaceQuery } = await import('./workspaceQuery.js');
    const actor = { userId: 'u-owner', agentId: null };
    const dashboard = await createDashboard(ws, actor, { title: 'Hide done', language: 'en' });
    const query = {
      source: 'items' as const,
      where: {
        combinator: 'and' as const,
        rules: [{ field: 'topic', operator: '=' as const, value: 't-hide' }],
      },
    };
    await applyDashboardOps(ws, actor, dashboard.id, {
      expectedVersion: dashboard.version,
      ops: [
        {
          op: 'add_block',
          block: {
            type: 'list',
            query,
            rules: [
              { if: { field: 'status', operator: '=', value: 'done' }, then: { hide: true } },
            ],
          },
        },
        { op: 'add_block', block: { type: 'list', query } },
      ],
    });
    const [hiding, plain] = (await getDashboard(ws, actor, dashboard.id, {})).blocks;
    assert.ok(hiding && plain);
    const rowsOf = async (blockId: string): Promise<string[]> =>
      ((await runWorkspaceQuery(ws, 'u-owner', { dashboardId: dashboard.id, blockId })).rows ?? [])
        .map((row) => row.id)
        .sort();
    assert.deepEqual(await rowsOf(hiding.id), [copyId, todo.id].sort());
    assert.deepEqual(await rowsOf(plain.id), [todo.id]);
  });

  it('a saved block’s malformed stored hide rule is skipped (logged once), never an error', async (t) => {
    const { todo, copyId } = await todoWithCopy('workspace', {
      todo: { status: 'done', topicId: 't-malformed' },
      copy: { topicId: 't-malformed' },
    });
    const { createDashboard, applyDashboardOps, getDashboard } =
      await import('../testing/dashboardCalls.js');
    const { runWorkspaceQuery } = await import('./workspaceQuery.js');
    const { logger } = await import('./logger.js');
    const actor = { userId: 'u-owner', agentId: null };
    const dashboard = await createDashboard(ws, actor, { title: 'Malformed', language: 'en' });
    await applyDashboardOps(ws, actor, dashboard.id, {
      expectedVersion: dashboard.version,
      ops: [
        {
          op: 'add_block',
          block: {
            type: 'list',
            query: {
              source: 'items',
              where: {
                combinator: 'and',
                rules: [{ field: 'topic', operator: '=', value: 't-malformed' }],
              },
            },
          },
        },
      ],
    });
    const [block] = (await getDashboard(ws, actor, dashboard.id, {})).blocks;
    assert.ok(block);
    const done = { field: 'status', operator: '=', value: 'done' };
    const { DashboardMongoModel } = await import('../models/mongoose/Dashboard.js');
    // Written past the schema: a `then` that is no object, a rule with no `if`, and null.
    const setRules = async (rules: unknown[]): Promise<void> => {
      await DashboardMongoModel.collection.updateOne(
        { _id: dashboard.id as never, 'blocks.id': block.id },
        { $set: { 'blocks.$.rules': rules } },
      );
    };
    const warn = t.mock.method(logger, 'warn', () => undefined);
    const rowsOf = async (): Promise<string[]> =>
      (
        (await runWorkspaceQuery(ws, 'u-owner', { dashboardId: dashboard.id, blockId: block.id }))
          .rows ?? []
      )
        .map((row) => row.id)
        .sort();
    await setRules([{ if: done, then: 'hide' }, { then: { hide: true } }, null]);
    assert.deepEqual(await rowsOf(), [todo.id]);
    assert.deepEqual(await rowsOf(), [todo.id]);
    // A well-formed hide rule beside them still counts.
    await setRules([
      { if: done, then: 'hide' },
      { if: done, then: { hide: true } },
    ]);
    assert.deepEqual(await rowsOf(), [copyId, todo.id].sort());
    const malformed = warn.mock.calls.filter((call) =>
      String(call.arguments[0]).includes('malformed display rule'),
    );
    assert.equal(malformed.length, 1);
  });

  it('a hide rule on a props field the workspace does not have means the same on every block', async () => {
    const { todo } = await todoWithCopy('workspace', {
      todo: { status: 'done', topicId: 't-ghost' },
      copy: { topicId: 't-ghost' },
    });
    const { createDashboard, applyDashboardOps, getDashboard } =
      await import('../testing/dashboardCalls.js');
    const { runWorkspaceQuery } = await import('./workspaceQuery.js');
    const actor = { userId: 'u-owner', agentId: null };
    const dashboard = await createDashboard(ws, actor, { title: 'Ghost', language: 'en' });
    await applyDashboardOps(ws, actor, dashboard.id, {
      expectedVersion: dashboard.version,
      ops: [
        {
          op: 'add_block',
          block: {
            type: 'list',
            // No props in the query: the registry is still read, for the rule.
            query: {
              source: 'items',
              where: {
                combinator: 'and',
                rules: [{ field: 'topic', operator: '=', value: 't-ghost' }],
              },
            },
            rules: [{ if: { field: 'props.ghost', operator: 'null' }, then: { hide: true } }],
          },
        },
      ],
    });
    const [block] = (await getDashboard(ws, actor, dashboard.id, {})).blocks;
    assert.ok(block);
    // `props.ghost` is in no item's props: the rule is refused and hides nothing, so the to-do
    // still absorbs its copy, as on a block whose query reads props.
    const result = await runWorkspaceQuery(ws, 'u-owner', {
      dashboardId: dashboard.id,
      blockId: block.id,
    });
    assert.deepEqual(
      (result.rows ?? []).map((row) => row.id),
      [todo.id],
    );
  });

  it('provider-field discovery leaves out a copy whose to-do the member may see', async () => {
    const { ProviderFields } = await import('../classes/item/ProviderFields.js');
    const { todo } = await todoWithCopy('workspace', { copy: { props: { copyOnlyPoints: 5 } } });
    const paths = async (userId: string, at: number): Promise<string[]> =>
      (await ProviderFields.of({ id: ws.id }, userId, at)).map((field) => field.path);
    // Later than any cached answer: each call reads afresh.
    const start = Date.now() + 10 * 60_000;
    assert.ok(!(await paths('u-owner', start)).includes('props.copyOnlyPoints'));
    // Private to its owner: another member sees the copy, so its field is offered to them.
    const repo = await models.getItemRepository();
    await repo.updateLocal(ws.id, todo.id, { visibility: 'private' });
    assert.ok(!(await paths('u-owner', start + 2 * 60_000)).includes('props.copyOnlyPoints'));
    assert.ok((await paths('u-other', start + 4 * 60_000)).includes('props.copyOnlyPoints'));
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
