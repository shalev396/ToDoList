/**
 * topic-colours, against a throwaway MongoDB: a topic without a colour gets the next family its
 * workspace leaves unused, in sidebar order; a family chosen by hand is kept; a second run
 * changes nothing; it answers counts only.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: Migration;

const NOW = new Date('2026-11-17T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_topic_colours');
  ({ topicColours: migration } = await import('./topicColours.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

async function topics(workspaceId: string, colours: (string | null)[]): Promise<void> {
  await raw.collection<Doc>('Topics').insertMany(
    colours.map((colour, order) => ({
      _id: `${workspaceId}-${String(order)}` as never,
      workspaceId,
      name: `t${String(order)}`,
      slug: `t${String(order)}`,
      icon: null,
      colour,
      order,
      createdBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
}

async function coloursOf(workspaceId: string): Promise<unknown[]> {
  const docs = await raw
    .collection<Doc>('Topics')
    .find({ workspaceId })
    .sort({ order: 1 })
    .toArray();
  return docs.map((doc) => doc['colour']);
}

describe('topic-colours', () => {
  it('answers zero on a database without topics', async () => {
    assert.deepEqual(await migration.run(raw, NOW), { topics: 0 });
  });

  it('fills the missing colours in sidebar order and keeps the chosen one', async () => {
    await topics('w-1', [null, 'orange', null]);
    await topics('w-2', ['red', 'gray']);
    assert.deepEqual(await migration.run(raw, NOW), { topics: 2 });
    assert.deepEqual(await coloursOf('w-1'), ['blue', 'orange', 'teal']);
    assert.deepEqual(await coloursOf('w-2'), ['red', 'gray']);
  });

  it('changes nothing the second time', async () => {
    assert.deepEqual(await migration.run(raw, NOW), { topics: 0 });
    assert.deepEqual(await coloursOf('w-1'), ['blue', 'orange', 'teal']);
  });
});
