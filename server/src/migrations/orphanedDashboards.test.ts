/**
 * orphaned-dashboards, against a throwaway MongoDB: the dashboards (deleted ones too), dashboard
 * versions and views of a workspace that is gone or soft-deleted are removed; a live workspace's
 * (one stored without `deletedAt` too) are left alone; it answers counts only; a second run
 * changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: Migration;

const NOW = new Date('2026-11-15T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_orphaned_dashboards');
  ({ orphanedDashboards: migration } = await import('./orphanedDashboards.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

/** One dashboard, a version of it and a view in the workspace. */
async function contentOf(workspaceId: string, deletedDashboard = false): Promise<void> {
  await raw.collection<Doc>('Dashboards').insertOne({
    _id: `dash-${workspaceId}` as never,
    workspaceId,
    ownerUserId: 'u-1',
    title: 'Page',
    deletedAt: deletedDashboard ? NOW : null,
  });
  await raw.collection<Doc>('DashboardVersions').insertOne({
    _id: `ver-${workspaceId}` as never,
    workspaceId,
    dashboardId: `dash-${workspaceId}`,
    version: 1,
  });
  await raw.collection<Doc>('Views').insertOne({
    _id: `view-${workspaceId}` as never,
    workspaceId,
    ownerUserId: 'u-1',
    title: 'View',
  });
}

async function countOf(collection: string, workspaceId: string): Promise<number> {
  return raw.collection<Doc>(collection).countDocuments({ workspaceId });
}

describe('orphaned-dashboards', () => {
  it('removes what deleted and missing workspaces left, keeps live ones, once', async () => {
    await raw.collection<Doc>('Workspaces').insertMany([
      { _id: 'w-live' as never, name: 'Live', deletedAt: null },
      { _id: 'w-old' as never, name: 'Stored before deletedAt existed' },
      { _id: 'w-deleted' as never, name: 'Deleted', deletedAt: NOW },
    ]);
    await contentOf('w-live');
    await contentOf('w-old');
    await contentOf('w-deleted', true);
    await contentOf('w-missing');

    assert.deepEqual(await migration.run(raw, NOW), { dashboards: 2, versions: 2, views: 2 });
    for (const workspaceId of ['w-deleted', 'w-missing']) {
      for (const collection of ['Dashboards', 'DashboardVersions', 'Views']) {
        assert.equal(await countOf(collection, workspaceId), 0, `${collection} of ${workspaceId}`);
      }
    }
    for (const workspaceId of ['w-live', 'w-old']) {
      for (const collection of ['Dashboards', 'DashboardVersions', 'Views']) {
        assert.equal(await countOf(collection, workspaceId), 1, `${collection} of ${workspaceId}`);
      }
    }
    assert.deepEqual(await migration.run(raw, NOW), { dashboards: 0, versions: 0, views: 0 });
  });
});
