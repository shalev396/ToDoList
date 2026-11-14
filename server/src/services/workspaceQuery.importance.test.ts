/**
 * Importance and attributes through the real query service (H4): `importance` as a filter and a
 * sort, a page's preset changing the order, `attr.<key>` fields (the built-in Importance reads 3
 * when unset), and provider fields accepted only when the workspace synced them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { contextFor, newUser } from '../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { WorkspaceContext } from './accessFilter.js';
import type * as Models from '../models/index.js';
import type * as Query from './workspaceQuery.js';
import type * as Items from './items.js';
import type * as Workspaces from './workspaces.js';
import type { ItemUpsert } from '../models/definitions/Item.js';
import type { ItemQueryRow, Query as BuilderQuery, QueryResult } from '../types/builder.js';
import type { ImportanceConfig } from '../types/importance.js';

const NOW = new Date('2026-11-11T08:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let db: TestDatabase;
let models: typeof Models;
let queries: typeof Query;
let items: typeof Items;
let ctx: WorkspaceContext;
let userId = '';
const ids: Record<string, string> = {};

before(async () => {
  db = await startTestDatabase('todolist_importance_query_test');
  models = await import('../models/index.js');
  queries = await import('./workspaceQuery.js');
  items = await import('./items.js');
  const workspaces: typeof Workspaces = await import('./workspaces.js');
  const user = await newUser('importance-query');
  userId = user.id;
  const workspace = await workspaces.createWorkspace(user, { name: 'Importance query' });
  ctx = await contextFor(workspace.id, userId);
  // PERMISSIONS-V2: the items are the member's own integration's, so they see them.
  const { seedIntegration } = await import('../testing/integrationFixtures.js');
  await seedIntegration(ctx.id, { id: 'i-jira', ownerUserId: userId, provider: 'jira' });

  // Three tracker items: a big old one, a small new one, a deadline-driven one.
  const repo = await models.getItemRepository();
  const base = (externalId: string, extra: Record<string, unknown>): ItemUpsert => ({
    integrationId: 'i-jira',
    kind: 'issue' as const,
    topicId: null,
    title: externalId,
    status: 'open' as const,
    source: {
      provider: 'jira' as const,
      accountId: 'a',
      externalId,
      key: externalId,
      url: `https://jira.example/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
    ...extra,
  });
  await repo.bulkUpsert(ctx.id, [
    base('BIG', { props: { jira: { storyPoints: 13 } }, priority: 1 }),
    base('SMALL', { props: { jira: { storyPoints: 1 } }, priority: 1 }),
    base('DUE', { dueAt: new Date(NOW.getTime() + 2 * DAY), priority: 1 }),
  ]);
  for (const key of ['BIG', 'SMALL', 'DUE']) {
    const [row] = await repo.aggregate(ctx.id, [{ $match: { 'source.externalId': key } }]);
    ids[key] = String(row?.['_id']);
  }
  // BIG has waited 30 days, SMALL one day, DUE five.
  const { ItemMongoModel } = await import('../models/mongoose/Item.js');
  const age = async (key: string, days: number): Promise<void> => {
    await ItemMongoModel.collection.updateOne(
      { _id: ids[key] as never },
      { $set: { createdAt: new Date(NOW.getTime() - days * DAY) } },
    );
  };
  await age('BIG', 30);
  await age('SMALL', 1);
  await age('DUE', 5);
});

after(async () => {
  await db.stop();
});

async function run(draft: BuilderQuery, importance?: ImportanceConfig): Promise<QueryResult> {
  return queries.runWorkspaceQuery(
    ctx,
    userId,
    { draft, ...(importance === undefined ? {} : { importance }) },
    NOW,
  );
}

const titles = (rows: ItemQueryRow[] | undefined): string[] => (rows ?? []).map((row) => row.title);

describe('importance in queries', () => {
  const byImportance: BuilderQuery = {
    source: 'items',
    sort: [{ field: 'importance', dir: 'desc' }],
  };

  it('switching the page preset changes the order', async () => {
    const fair = await run(byImportance, { preset: 'fair', params: {} });
    assert.deepEqual(titles(fair.rows as ItemQueryRow[]), ['BIG', 'DUE', 'SMALL']);
    const shortest = await run(byImportance, { preset: 'shortest', params: {} });
    assert.equal(titles(shortest.rows as ItemQueryRow[])[0], 'SMALL');
    const deadline = await run(byImportance, { preset: 'deadline', params: {} });
    assert.equal(titles(deadline.rows as ItemQueryRow[])[0], 'DUE');
    const weighted = await run(byImportance, {
      preset: 'weighted',
      params: { weights: { dueSoon: 10 } },
    });
    assert.equal(titles(weighted.rows as ItemQueryRow[])[0], 'DUE');
  });

  it('a page without a preset uses Weighted with the defaults', async () => {
    const result = await run(byImportance);
    const explicit = await run(byImportance, { preset: 'weighted', params: {} });
    assert.deepEqual(result.rows, explicit.rows);
  });

  it('importance is a 0-100 integer on each row, and filters', async () => {
    const all = await run(byImportance, { preset: 'fair', params: {} });
    for (const row of all.rows as ItemQueryRow[]) {
      assert.ok(Number.isInteger(row.importance));
      assert.ok((row.importance ?? -1) >= 0 && (row.importance ?? 101) <= 100);
    }
    const top = await run(
      {
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'importance', operator: '>=', value: 70 }] },
      },
      { preset: 'fair', params: {} },
    );
    assert.deepEqual(titles(top.rows as ItemQueryRow[]), ['BIG']);
  });

  it('a query that does not use importance gets no score', async () => {
    const result = await run({ source: 'items' });
    assert.ok((result.rows as ItemQueryRow[]).every((row) => row.importance === undefined));
  });
});

describe('attribute fields in queries', () => {
  it('the built-in Importance reads 3 when unset; a set value filters and sorts', async () => {
    await items.updateOverlay(ctx, userId, ids['SMALL'] ?? '', { attrs: { importance: 5 } });
    await items.updateOverlay(ctx, userId, ids['BIG'] ?? '', { attrs: { importance: 1 } });
    const atLeastThree = await run({
      source: 'items',
      where: { combinator: 'and', rules: [{ field: 'attr.importance', operator: '>=', value: 3 }] },
      sort: [{ field: 'attr.importance', dir: 'desc' }],
    });
    // DUE has no value: it counts as 3. BIG (1) is out.
    assert.deepEqual(titles(atLeastThree.rows as ItemQueryRow[]), ['SMALL', 'DUE']);
  });

  it('the Importance weight in the Weighted preset follows the attribute', async () => {
    const result = await run(
      { source: 'items', sort: [{ field: 'importance', dir: 'desc' }] },
      {
        preset: 'weighted',
        params: { weights: { priority: 0, dueSoon: 0, importance: 10, pinned: 0 } },
      },
    );
    assert.deepEqual(titles(result.rows as ItemQueryRow[]), ['SMALL', 'DUE', 'BIG']);
  });

  it('refuses an attribute the workspace does not define (400)', async () => {
    await assert.rejects(
      run({
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'attr.nope', operator: '=', value: 1 }] },
      }),
      { statusCode: 400 },
    );
  });
});

describe('a number attribute with a zero range', () => {
  it('a Weighted page still ranks (the factor is 0), it does not fail the query', async () => {
    const { WorkspaceMongoModel } = await import('../models/mongoose/Workspace.js');
    await WorkspaceMongoModel.collection.updateOne(
      { _id: ctx.id as never },
      {
        $push: {
          'settings.attributes': {
            key: 'legacy',
            name: 'Legacy',
            type: 'number',
            min: 100,
            builtIn: false,
          },
        } as never,
      },
    );
    const before = ctx;
    ctx = await contextFor(ctx.id, userId);
    try {
      const result = await run(
        { source: 'items', sort: [{ field: 'importance', dir: 'desc' }] },
        { preset: 'weighted', params: { weights: { 'attr.legacy': 10, priority: 1 } } },
      );
      assert.equal(result.total, 3);
      for (const row of result.rows as ItemQueryRow[]) assert.ok(Number.isInteger(row.importance));
    } finally {
      ctx = before;
    }
  });
});

describe('provider fields in queries', () => {
  it('accepts a path the workspace synced and refuses one it did not', async () => {
    const ok = await run({
      source: 'items',
      where: {
        combinator: 'and',
        rules: [{ field: 'props.jira.storyPoints', operator: '>=', value: 5 }],
      },
    });
    assert.deepEqual(titles(ok.rows as ItemQueryRow[]), ['BIG']);
    for (const field of ['props.jira.neverSynced', 'props.github.stars', 'props.jira.token']) {
      await assert.rejects(
        run({
          source: 'items',
          where: { combinator: 'and', rules: [{ field, operator: '=', value: 1 }] },
        }),
        { statusCode: 400 },
      );
    }
  });
});
