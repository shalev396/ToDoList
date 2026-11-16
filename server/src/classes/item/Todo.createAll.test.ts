/**
 * Todo.createAll and Todo.keysTaken: the demo seed's to-dos in one write, each as Todo.create makes
 * it (a topic of the workspace, else `personal`), listed by creation in the order given.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { addDefaultTopics, callerOf } from '../../testing/workspaceFixtures.js';
import type { Caller } from '../base/Caller.js';
import type * as Items from './index.js';
import type { ItemData } from '../../models/definitions/Item.js';
import type * as Models from '../../models/index.js';

let db: TestDatabase;
let Todo: typeof Items.Todo;
let models: typeof Models;

const OWNER = 'u-owner';
let workspaces = 0;

before(async () => {
  db = await startTestDatabase('todolist_todo_create_all_test');
  ({ Todo } = await import('./index.js'));
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function editor(): Promise<{ caller: Caller; topics: Record<string, string> }> {
  workspaces += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'To-dos', slug: `todos-${String(workspaces)}`, ownerId: OWNER });
  const topics = await addDefaultTopics(created.id);
  const caller = callerOf({ id: created.id, role: 'editor', settings: created.settings }, OWNER);
  return { caller, topics };
}

describe('Todo.createAll', () => {
  it('creates each to-do as Todo.create would, in the order given', async () => {
    const { caller, topics } = await editor();
    const dueAt = new Date('2026-11-20T21:59:00.000Z');
    const made = await Todo.createAll(caller, [
      { title: 'First', topicId: topics['work'], dueAt, priority: 3, idempotencyKey: 'k1' },
      { title: 'Second', note: 'A note', idempotencyKey: 'k2' },
      { title: 'Third', topicId: null },
    ]);
    assert.deepEqual(
      made.map((todo) => [todo.title, todo.topicId]),
      [
        ['First', topics['work']],
        ['Second', topics['personal']],
        ['Third', null],
      ],
    );
    const single = await Todo.create(caller, { title: 'Second', note: 'A note' });
    const [, second] = made;
    assert.ok(second);
    /** What a to-do is, apart from its id, times and idempotency key. */
    const fields = (todo: { toJSON(): ItemData }): Record<string, unknown> => {
      const data = todo.toJSON();
      return {
        ...data,
        id: '',
        createdAt: null,
        updatedAt: null,
        props: {},
        source: { ...data.source, externalId: '', url: '' },
      };
    };
    assert.deepEqual(fields(second), fields(single.todo));

    const times = made.map((todo) => todo.toJSON().createdAt.getTime());
    assert.ok(times.every((time, index) => index === 0 || time > (times[index - 1] ?? Infinity)));
  });

  it('answers the keys already used, live or deleted', async () => {
    const { caller } = await editor();
    const [kept, gone] = await Todo.createAll(caller, [
      { title: 'Kept', idempotencyKey: 'kept' },
      { title: 'Gone', idempotencyKey: 'gone' },
    ]);
    assert.ok(kept && gone);
    await gone.delete(caller);
    assert.deepEqual([...(await Todo.keysTaken(caller, ['kept', 'gone', 'never']))].sort(), [
      'gone',
      'kept',
    ]);
  });

  it('refuses a topic of another workspace, and a viewer', async () => {
    const { caller } = await editor();
    await assert.rejects(Todo.createAll(caller, [{ title: 'Lost', topicId: 'nowhere' }]), {
      message: 'Unknown topic',
    });
    const viewer = callerOf({ ...caller.context, role: 'viewer' }, OWNER);
    await assert.rejects(Todo.createAll(viewer, [{ title: 'Nope' }]));
  });
});
