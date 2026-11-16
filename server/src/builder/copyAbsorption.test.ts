/**
 * H5: a provider copy of a local to-do is absorbed into its to-do in a dashboard block, unless the
 * block is filtered by a provider that is not `local`: then the copy shows (its to-do does not
 * match the filter). The access filter stays the first stage.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IItemRepository } from '../models/index.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Query, QueryResult } from '../types/builder.js';
import type { CompileContext } from './compile.js';
import type { RunQueryDeps } from './run.js';

let db: TestDatabase;
let items: IItemRepository;
let runQuery: (query: Query, ctx: CompileContext, deps: RunQueryDeps) => Promise<QueryResult>;
let deps: RunQueryDeps;
let todoId = '';
let copyId = '';

const context = (userId: string): CompileContext => ({
  ws: { id: 'w-copy' },
  userId,
  vars: {},
  now: new Date('2026-11-11T08:00:00Z'),
  timeZone: 'Asia/Jerusalem',
  weekStart: 'sun',
  preview: false,
  access: {
    userId,
    integrations: [{ id: 'i-linear', provider: 'linear', accountId: 'acct', ownerUserId: 'u-1' }],
    local: 'visible',
  },
});

before(async () => {
  db = await startTestDatabase('todolist_builder_copy_absorption');
  const models = await import('../models/index.js');
  items = await models.getItemRepository();
  const containers = await models.getContainerRepository();
  ({ runQuery } = await import('./run.js'));
  deps = {
    items: (workspaceId, stages, options): Promise<Record<string, unknown>[]> =>
      items.aggregate(workspaceId, stages, options),
    containers: (workspaceId, stages, options): Promise<Record<string, unknown>[]> =>
      containers.aggregate(workspaceId, stages, options),
  };
  const todo = await items.createLocal('w-copy', {
    ownerUserId: 'u-1',
    title: 'Plan',
    topicId: null,
  });
  todoId = todo.id;
  await items.bulkUpsert('w-copy', [
    {
      integrationId: 'i-linear',
      kind: 'issue',
      topicId: null,
      title: 'Plan (Linear)',
      status: 'open',
      source: {
        provider: 'linear',
        accountId: 'acct',
        externalId: 'lin-1',
        key: 'ENG-1',
        url: 'https://linear.app/x/issue/ENG-1',
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    },
  ]);
  const copy = await items.findBySource(
    'w-copy',
    { provider: 'linear', accountId: 'acct', integrationId: 'i-linear' },
    'lin-1',
  );
  copyId = copy?.id ?? '';
  await items.setOverlay('w-copy', copyId, {
    copyOf: todoId,
    copyOfOwner: 'u-1',
    copyOfShared: true,
  });
});

after(async () => {
  await db.stop();
});

const idsOf = async (query: Query, userId = 'u-1'): Promise<string[]> =>
  ((await runQuery(query, context(userId), deps)).rows ?? []).map((row) => row.id);

describe('a dashboard block and a provider copy', () => {
  it('an unfiltered block shows the to-do only: the copy is absorbed', async () => {
    const ids = await idsOf({ source: 'items', limit: 50 });
    assert.deepEqual(ids, [todoId]);
  });

  it('a block filtered by the copy’s provider shows the copy', async () => {
    const ids = await idsOf({
      source: 'items',
      where: {
        combinator: 'and',
        rules: [{ field: 'source.provider', operator: '=', value: 'linear' }],
      },
      limit: 50,
    });
    assert.deepEqual(ids, [copyId]);
  });

  it('a block filtered to local shows the to-do, and counts agree', async () => {
    const where = {
      combinator: 'and' as const,
      rules: [{ field: 'source.provider', operator: '=' as const, value: 'local' }],
    };
    assert.deepEqual(await idsOf({ source: 'items', where, limit: 50 }), [todoId]);
    const count = await runQuery(
      { source: 'items', aggregate: { op: 'count' } },
      context('u-1'),
      deps,
    );
    assert.equal(count.total, 1);
  });
});
