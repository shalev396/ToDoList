/**
 * The data migrations (migrations/index.ts) against a throwaway MongoDB: each runs once, is
 * recorded, and running them again changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Migrations from './index.js';

let db: TestDatabase;
let migrations: typeof Migrations;
let raw: mongoose.mongo.Db;

const NOW = new Date('2026-11-13T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations');
  migrations = await import('./index.js');
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

describe('drop member area scoping', () => {
  it('unsets areaScope on memberships and invites, once, and records it', async () => {
    await raw.collection('Memberships').insertMany([
      {
        _id: 'm-1' as never,
        workspaceId: 'w-1',
        userId: 'u-1',
        role: 'viewer',
        areaScope: ['college'],
        status: 'active',
      },
      {
        _id: 'm-2' as never,
        workspaceId: 'w-1',
        userId: 'u-2',
        role: 'owner',
        areaScope: null,
        status: 'active',
      },
      { _id: 'm-3' as never, workspaceId: 'w-1', userId: 'u-3', role: 'editor', status: 'active' },
    ]);
    await raw.collection('Invites').insertOne({
      _id: 'i-1' as never,
      workspaceId: 'w-1',
      email: 'friend@example.test',
      role: 'editor',
      areaScope: ['personal'],
      status: 'pending',
    });

    const lines = await migrations.runMigrations(raw, NOW);

    assert.ok(lines.some((line) => line.startsWith('2026-11-13-drop-area-scope: applied')));
    const scoped = await raw
      .collection('Memberships')
      .countDocuments({ areaScope: { $exists: true } });
    assert.equal(scoped, 0);
    assert.equal(
      await raw.collection('Invites').countDocuments({ areaScope: { $exists: true } }),
      0,
    );
    // Nothing else changed.
    const viewer = await raw.collection('Memberships').findOne({ _id: 'm-1' as never });
    assert.deepEqual([viewer?.['role'], viewer?.['status']], ['viewer', 'active']);

    const recorded = await raw
      .collection('Migrations')
      .findOne({ _id: '2026-11-13-drop-area-scope' as never });
    assert.deepEqual(recorded?.['appliedAt'], NOW);
  });

  it('runs nothing the second time', async () => {
    assert.deepEqual(await migrations.pendingMigrationIds(raw), []);
    const lines = await migrations.runMigrations(raw, NOW);
    assert.ok(
      lines.every((line) => line.endsWith('already applied')),
      lines.join('\n'),
    );
  });
});
