/**
 * Item changes reach their listeners (plan Ruling 17): travel hears of every to-do and time-block
 * write through ItemChanges, which loading classes/index.js wires, so Todo and TimeBlock never
 * import travel. A listener that throws is logged and swallowed: it never fails the write.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type * as Classes from '../index.js';
import type { Caller } from '../base/Caller.js';
import type { ItemChange } from './ItemChanges.js';

let db: TestDatabase;
let classes: typeof Classes;
let models: typeof Models;

const A = 'u-item-changes';
const HOUR = 3_600_000;

before(async () => {
  db = await startTestDatabase('todolist_item_changes_test');
  classes = await import('../index.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function owner(): Promise<Caller> {
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Changes', slug: 'changes', ownerId: A });
  await (await models.getMembershipRepository()).create(created.id, { userId: A, role: 'owner' });
  return callerOf({ id: created.id, settings: created.settings, role: 'owner' }, A);
}

describe('ItemChanges', () => {
  it('importing classes/index.js subscribes travel', () => {
    assert.ok(classes.ItemChanges.isSubscribed(classes.TravelPlanner.onItemChange));
  });

  it('a throwing listener does not fail the write', async () => {
    const caller = await owner();
    const heard: string[] = [];
    const throwing = (_caller: Caller, change: ItemChange): Promise<void> => {
      heard.push(`${change.kind}:${change.itemId}`);
      return Promise.reject(new Error('the listener is down'));
    };
    classes.ItemChanges.subscribe(throwing);
    try {
      const { todo } = await classes.Todo.create(caller, { title: 'Read' });
      const edited = await todo.update(caller, classes.ItemEdit.of({ title: 'Read more' }));
      assert.equal(edited.title, 'Read more');
      const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);
      const { block } = await classes.TimeBlock.create(caller, {
        layer: 'block',
        title: 'Focus',
        startAt: start,
        endAt: new Date(start.getTime() + HOUR),
      });
      const moved = await block.editSeries(caller, {
        startAt: new Date(start.getTime() + HOUR),
      });
      await moved.delete(caller);
      await edited.delete(caller);

      assert.deepEqual(heard, [
        `todo:${todo.id}`,
        `todo:${todo.id}`,
        `block:${block.id}`,
        `block:${block.id}`,
        `block:${block.id}`,
        `todo:${todo.id}`,
      ]);
      const items = await models.getItemRepository();
      // Each write went through: the deletes too (soft-deleted items are not found).
      assert.equal(await items.findById(caller.workspaceId, todo.id), null);
      assert.equal(await items.findById(caller.workspaceId, block.id), null);
    } finally {
      classes.ItemChanges.unsubscribe(throwing);
    }
    assert.ok(!classes.ItemChanges.isSubscribed(throwing));
  });
});
