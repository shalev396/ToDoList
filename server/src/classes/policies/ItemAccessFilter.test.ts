/**
 * ItemAccessFilter.copyAbsorption on a real mongod (H5): the stages drop a provider copy exactly
 * when its to-do is among the rows that reach them, keep every other row as it is, and leave no
 * field of their own behind. The access filter itself never hides a copy.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { ItemAccessFilter } from './ItemAccessFilter.js';

type Doc = Record<string, unknown>;

let db: TestDatabase;
let aggregate: (stages: Doc[]) => Promise<Doc[]>;

const WS = 'w-absorb';

/** A to-do with two copies (Linear and Jira), a copy whose to-do is gone, and two plain items. */
const DOCS: Doc[] = [
  { _id: 'todo', workspaceId: WS, kind: 'todo', overlay: { copyOf: null }, title: 'Plan' },
  { _id: 'copy-linear', workspaceId: WS, kind: 'issue', overlay: { copyOf: 'todo' } },
  { _id: 'copy-jira', workspaceId: WS, kind: 'issue', overlay: { copyOf: 'todo' } },
  { _id: 'copy-orphan', workspaceId: WS, kind: 'issue', overlay: { copyOf: 'gone' } },
  { _id: 'plain-issue', workspaceId: WS, kind: 'issue', overlay: {} },
  { _id: 'plain-todo', workspaceId: WS, kind: 'todo' },
];

before(async () => {
  db = await startTestDatabase('todolist_item_access_filter');
  const mongoose = (await import('mongoose')).default;
  const collection = mongoose.connection.collection('AbsorptionProbe');
  await collection.insertMany(DOCS);
  aggregate = (stages): Promise<Doc[]> => collection.aggregate<Doc>(stages).toArray();
});

after(async () => {
  await db.stop();
});

const ids = (rows: Doc[]): string[] => rows.map((row) => String(row['_id'])).sort();

describe('ItemAccessFilter.copyAbsorption', () => {
  it('drops every copy of a to-do in the read, and keeps a copy whose to-do is not', async () => {
    const rows = await aggregate([
      { $match: { workspaceId: WS } },
      ...ItemAccessFilter.copyAbsorption(),
    ]);
    assert.deepEqual(ids(rows), ['copy-orphan', 'plain-issue', 'plain-todo', 'todo']);
  });

  it('a read the to-do does not reach keeps its copies as rows of their own', async () => {
    const rows = await aggregate([
      { $match: { workspaceId: WS, kind: 'issue' } },
      ...ItemAccessFilter.copyAbsorption(),
    ]);
    assert.deepEqual(ids(rows), ['copy-jira', 'copy-linear', 'copy-orphan', 'plain-issue']);
  });

  it('never adds a row, and leaves rows as they were (no field of its own)', async () => {
    const rows = await aggregate([
      { $match: { workspaceId: WS } },
      ...ItemAccessFilter.copyAbsorption(),
      { $sort: { _id: 1 } },
    ]);
    const byId = new Map(DOCS.map((doc) => [doc['_id'], doc]));
    for (const row of rows) assert.deepEqual(row, byId.get(row['_id']));
  });

  it('an empty read stays empty', async () => {
    const rows = await aggregate([
      { $match: { workspaceId: 'nobody' } },
      ...ItemAccessFilter.copyAbsorption(),
    ]);
    assert.deepEqual(rows, []);
  });

  it('the access filter holds no absorption: a copy is in it like any item', () => {
    const filter = new ItemAccessFilter({ userId: 'u-1', integrations: [], local: 'visible' });
    const items = filter.items({ id: WS });
    assert.ok(!JSON.stringify(items).includes('copyOf'));
    assert.deepEqual(filter.itemsUnabsorbed({ id: WS }), items);
  });
});
