/**
 * TopicRepository (H2, dynamic topics): a workspace's pages as documents. A slug is unique in its
 * workspace (not across workspaces), the list is in sidebar order, a patch never touches the slug,
 * and every call stays inside the workspace it names.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { ITopicRepository } from '../definitions/Topic.js';

let db: TestDatabase;
let topics: ITopicRepository;

before(async () => {
  db = await startTestDatabase('todolist_topic_repository_test');
  ({ TopicRepository: topics } = await import('../mongoose/Topic.js'));
  const { TopicMongoModel } = await import('../mongoose/Topic.js');
  await TopicMongoModel.syncIndexes();
});

after(async () => {
  await db.stop();
});

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

describe('TopicRepository', () => {
  it('creates a topic with its defaults, under a given id when asked', async () => {
    const created = await topics.create('w-1', {
      id: 'topic-work-1',
      name: 'Work',
      slug: 'work',
      icon: 'briefcase',
      order: 0,
    });
    assert.deepEqual(
      {
        id: created.id,
        workspaceId: created.workspaceId,
        name: created.name,
        slug: created.slug,
        icon: created.icon,
        colour: created.colour,
        order: created.order,
        createdBy: created.createdBy,
      },
      {
        id: 'topic-work-1',
        workspaceId: 'w-1',
        name: 'Work',
        slug: 'work',
        icon: 'briefcase',
        colour: null,
        order: 0,
        createdBy: null,
      },
    );
    const fresh = await topics.create('w-1', { name: 'Side gig', slug: 'side-gig', order: 1 });
    assert.match(fresh.id, /^[0-9a-f-]{36}$/);
  });

  it('refuses a slug taken in the same workspace, not in another one', async () => {
    await assert.rejects(
      topics.create('w-1', { name: 'WORK', slug: 'work', order: 5 }),
      isDuplicateKey,
    );
    const elsewhere = await topics.create('w-2', { name: 'Work', slug: 'work', order: 0 });
    assert.equal(elsewhere.workspaceId, 'w-2');
  });

  it('lists in sidebar order and finds by id and by slug, inside the workspace only', async () => {
    await topics.create('w-1', { name: 'College', slug: 'college', order: -1 });
    const listed = await topics.list('w-1');
    assert.deepEqual(
      listed.map((topic) => topic.slug),
      ['college', 'work', 'side-gig'],
    );
    assert.equal(await topics.count('w-1'), 3);
    assert.equal((await topics.findBySlug('w-1', 'college'))?.name, 'College');
    assert.equal(await topics.findBySlug('w-3', 'college'), null);
    assert.equal(await topics.findById('w-2', 'topic-work-1'), null);
    assert.equal((await topics.findById('w-1', 'topic-work-1'))?.slug, 'work');
  });

  it('patches name, icon, colour and order, and keeps the slug', async () => {
    const updated = await topics.update('w-1', 'topic-work-1', {
      name: 'Acme',
      icon: null,
      colour: 'teal',
      order: 9,
    });
    assert.deepEqual(
      [updated?.name, updated?.slug, updated?.icon, updated?.colour, updated?.order],
      ['Acme', 'work', null, 'teal', 9],
    );
    assert.equal(await topics.update('w-2', 'topic-work-1', { name: 'Nope' }), null);
  });

  it('refuses an icon or colour outside the lists', async () => {
    await assert.rejects(
      topics.update('w-1', 'topic-work-1', { colour: 'chartreuse' as never }),
      /colour/,
    );
  });

  it('deletes inside the workspace only', async () => {
    assert.equal(await topics.delete('w-2', 'topic-work-1'), false);
    assert.equal(await topics.delete('w-1', 'topic-work-1'), true);
    assert.equal(await topics.delete('w-1', 'topic-work-1'), false);
    // The slug is free again once its topic is gone.
    const again = await topics.create('w-1', { name: 'Work', slug: 'work', order: 0 });
    assert.equal(again.slug, 'work');
  });
});
