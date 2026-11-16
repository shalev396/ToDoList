/**
 * Disconnecting an integration (DATA.md §4) soft-deletes its items and containers: only that
 * integration's live rows, only in that workspace. Local items and other integrations stay.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { SourceRef } from '../definitions/common.js';
import { ContainerMongoModel, ContainerRepository } from '../mongoose/Container.js';
import { ItemMongoModel, ItemRepository } from '../mongoose/Item.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_integration_soft_delete_test');
});

after(async () => {
  await db.stop();
});

function source(account: string, externalId: string): SourceRef {
  return {
    provider: 'jira',
    accountId: account,
    externalId,
    key: null,
    url: `https://example.invalid/${account}/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: `sha1:${account}-${externalId}`,
  };
}

async function seedIntegration(workspaceId: string, integrationId: string): Promise<void> {
  await ContainerRepository.bulkUpsert(workspaceId, [
    {
      integrationId,
      topicId: 'work',
      type: 'project',
      name: `Project ${integrationId}`,
      source: source(integrationId, 'project'),
    },
  ]);
  await ItemRepository.bulkUpsert(
    workspaceId,
    ['one', 'two'].map((externalId) => ({
      integrationId,
      kind: 'issue' as const,
      topicId: 'work' as const,
      title: `Issue ${externalId}`,
      status: 'open' as const,
      source: source(integrationId, externalId),
    })),
  );
}

async function deletedAt(workspaceId: string, integrationId: string | null): Promise<unknown[]> {
  const items = await ItemMongoModel.find({ workspaceId, integrationId }).sort({ title: 1 }).lean();
  const containers = await ContainerMongoModel.find({ workspaceId, integrationId }).lean();
  return [...items, ...containers].map((row) => row.deletedAt);
}

describe('softDeleteForIntegration (Items, Containers)', () => {
  it('marks only that integration’s live rows in that workspace, and keeps earlier deletions', async () => {
    await seedIntegration('w-a', 'i-gone');
    await seedIntegration('w-a', 'i-kept');
    await seedIntegration('w-b', 'i-gone');
    const local = await ItemRepository.createLocal('w-a', {
      ownerUserId: 'u-a',
      title: 'Local',
      topicId: 'personal',
    });
    const earlier = new Date('2026-01-01T00:00:00Z');
    await ItemMongoModel.updateOne(
      { workspaceId: 'w-a', integrationId: 'i-gone', 'source.externalId': 'two' },
      { $set: { deletedAt: earlier } },
    );

    // Another workspace's call never reaches w-a's rows.
    assert.equal(await ItemRepository.softDeleteForIntegration('w-c', 'i-gone'), 0);
    assert.equal(await ContainerRepository.softDeleteForIntegration('w-c', 'i-gone'), 0);

    assert.equal(await ItemRepository.softDeleteForIntegration('w-a', 'i-gone'), 1);
    assert.equal(await ContainerRepository.softDeleteForIntegration('w-a', 'i-gone'), 1);

    const [one, two, project] = await deletedAt('w-a', 'i-gone');
    assert.ok(one instanceof Date && project instanceof Date);
    assert.deepEqual(two, earlier, 'an earlier deletion keeps its date (and its purge clock)');
    assert.deepEqual(await deletedAt('w-a', 'i-kept'), [null, null, null]);
    assert.deepEqual(await deletedAt('w-b', 'i-gone'), [null, null, null]);
    assert.equal((await ItemRepository.findById('w-a', local.id))?.deletedAt, null);

    // Idempotent: nothing left to mark.
    assert.equal(await ItemRepository.softDeleteForIntegration('w-a', 'i-gone'), 0);
    assert.equal(await ContainerRepository.softDeleteForIntegration('w-a', 'i-gone'), 0);
  });
});
