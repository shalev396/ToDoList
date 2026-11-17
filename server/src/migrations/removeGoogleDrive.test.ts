/**
 * remove-google-drive, against a throwaway MongoDB: a Drive integration is disconnected with its
 * credential, items and containers; file-tree blocks leave drafts and published copies with their
 * layout cells; nothing else changes; a second run changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let removeGoogleDrive: Migration;

const NOW = new Date('2026-11-15T09:00:00Z');
const W = 'w-drive';

before(async () => {
  db = await startTestDatabase('todolist_migrations_drive');
  ({ removeGoogleDrive } = await import('./removeGoogleDrive.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

const tree = { id: 'blk_files', type: 'fileTree', viz: { kind: 'fileTree' } };
const list = { id: 'blk_list', type: 'list', viz: { kind: 'list' } };
const cells = [
  { i: 'blk_list', x: 0, y: 0, w: 6, h: 4 },
  { i: 'blk_files', x: 6, y: 0, w: 6, h: 4 },
];

describe('remove-google-drive', () => {
  it('disconnects Drive integrations and strips file trees, once', async () => {
    await raw.collection('Integrations').insertMany([
      { _id: 'i-drive' as never, workspaceId: W, provider: 'google_drive', deletedAt: null },
      { _id: 'i-jira' as never, workspaceId: W, provider: 'jira', deletedAt: null },
    ]);
    await raw.collection('Credentials').insertMany([
      { _id: 'c-drive' as never, workspaceId: W, integrationId: 'i-drive' },
      { _id: 'c-jira' as never, workspaceId: W, integrationId: 'i-jira' },
    ]);
    await raw.collection('Items').insertMany([
      { _id: 'it-drive' as never, workspaceId: W, integrationId: 'i-drive', deletedAt: null },
      { _id: 'it-jira' as never, workspaceId: W, integrationId: 'i-jira', deletedAt: null },
    ]);
    await raw.collection('Dashboards').insertOne({
      _id: 'd-1' as never,
      workspaceId: W,
      deletedAt: null,
      blocks: [list, tree],
      layouts: { lg: cells },
      published: { blocks: [tree, list], layouts: { lg: cells } },
    });

    const first = await removeGoogleDrive.run(raw, NOW);
    assert.deepEqual(first, {
      integrations: 1,
      credentials: 1,
      items: 1,
      containers: 0,
      fileTrees: 2,
    });

    const drive = await raw.collection('Integrations').findOne({ _id: 'i-drive' as never });
    assert.deepEqual(drive?.['deletedAt'], NOW);
    const jira = await raw.collection('Integrations').findOne({ _id: 'i-jira' as never });
    assert.equal(jira?.['deletedAt'], null);
    assert.equal(
      await raw.collection('Credentials').countDocuments({ integrationId: 'i-drive' }),
      0,
    );
    assert.equal(
      await raw.collection('Credentials').countDocuments({ integrationId: 'i-jira' }),
      1,
    );
    const jiraItem = await raw.collection('Items').findOne({ _id: 'it-jira' as never });
    assert.equal(jiraItem?.['deletedAt'], null);
    const dashboard = await raw.collection('Dashboards').findOne({ _id: 'd-1' as never });
    assert.ok(dashboard);
    assert.deepEqual(dashboard['blocks'], [list]);
    assert.deepEqual(dashboard['layouts'], { lg: [cells[0]] });
    assert.deepEqual(dashboard['published'], { blocks: [list], layouts: { lg: [cells[0]] } });

    assert.deepEqual(await removeGoogleDrive.run(raw, NOW), {
      integrations: 0,
      credentials: 0,
      items: 0,
      containers: 0,
      fileTrees: 0,
    });
  });
});
