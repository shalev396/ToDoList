/**
 * orphaned-topics, against a throwaway MongoDB: the topics of a workspace that is gone or
 * soft-deleted are removed; a live workspace's (one stored without `deletedAt` too) are left
 * exactly as they were, document for document; it answers counts only; a second run, and a
 * database with no topics, change nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: Migration;

const NOW = new Date('2026-11-16T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_orphaned_topics');
  ({ orphanedTopics: migration } = await import('./orphanedTopics.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

/** Two topics of the workspace, as the app stores them. */
async function topicsOf(workspaceId: string): Promise<void> {
  await raw.collection<Doc>('Topics').insertMany(
    ['work', 'personal'].map((slug, order) => ({
      _id: `topic-${slug}-${workspaceId}` as never,
      workspaceId,
      name: slug,
      slug,
      icon: null,
      colour: null,
      order,
      createdBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
}

async function storedTopics(workspaceId: string): Promise<Doc[]> {
  return raw.collection<Doc>('Topics').find({ workspaceId }).sort({ _id: 1 }).toArray();
}

describe('orphaned-topics', () => {
  it('answers zero on a database without topics', async () => {
    assert.deepEqual(await migration.run(raw, NOW), { topics: 0 });
  });

  it('removes what deleted and missing workspaces left, never a live one’s, once', async () => {
    await raw.collection<Doc>('Workspaces').insertMany([
      { _id: 'w-live' as never, name: 'Live', deletedAt: null },
      { _id: 'w-old' as never, name: 'Stored before deletedAt existed' },
      { _id: 'w-deleted' as never, name: 'Deleted', deletedAt: NOW },
    ]);
    for (const workspaceId of ['w-live', 'w-old', 'w-deleted', 'w-missing']) {
      await topicsOf(workspaceId);
    }
    const liveBefore = [...(await storedTopics('w-live')), ...(await storedTopics('w-old'))];

    assert.deepEqual(await migration.run(raw, NOW), { topics: 4 });
    for (const workspaceId of ['w-deleted', 'w-missing']) {
      assert.deepEqual(await storedTopics(workspaceId), [], workspaceId);
    }
    // A live workspace's topics, document for document as they were.
    assert.deepEqual(
      [...(await storedTopics('w-live')), ...(await storedTopics('w-old'))],
      liveBefore,
    );
    assert.equal(liveBefore.length, 4);

    assert.deepEqual(await migration.run(raw, NOW), { topics: 0 });
  });
});
