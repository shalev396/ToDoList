/**
 * TaskEdit, without a database: a mirrored item's provider fields, validated (a one-line title),
 * compared with the item: unchanged fields dropped, a changed field its provider doesn't take
 * refused (`field_not_writable`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FieldNotWritableError } from '../../errors/FieldNotWritableError.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { TaskEdit } from './TaskEdit.js';

const TZ = 'Asia/Jerusalem';
const DUE = new Date('2026-11-20T21:59:00.000Z');
const URL = 'https://acme.atlassian.net/browse/ABC-7';

const item = (over: Partial<ItemData> = {}): ItemData =>
  ({
    id: 'it-1',
    workspaceId: 'w-1',
    integrationId: 'i-1',
    kind: 'issue',
    title: 'Write the report',
    status: 'open',
    statusRaw: 'To Do',
    priority: 2,
    startAt: null,
    dueAt: DUE,
    allDay: true,
    source: { provider: 'jira', url: URL },
    ...over,
  }) as ItemData;

const status400 = { statusCode: 400 };
const JIRA = ['title', 'status', 'dueAt', 'priority'] as const;

describe('TaskEdit', () => {
  it('validates: provider fields only, at least one, each of its type, a one-line title', () => {
    for (const bad of [
      {},
      { title: '   ' },
      { title: 'x'.repeat(256) },
      { title: 'Two\nlines' },
      { title: 'Tab\there' },
      { status: 'merged' },
      { priority: 5 },
      { priority: 1.5 },
      { dueAt: '2026-11-20' },
      { dueAt: new Date('nope') },
      { allDay: true },
      { allDay: true, dueAt: null },
      // TodoList's own fields go through the overlay path, never here.
      { note: 'x' },
      { pinned: true },
      { topicOverride: 'personal' },
      { attrs: {} },
      { labels: ['x'] },
      null,
      'title',
    ]) {
      assert.throws(() => TaskEdit.parse(bad), status400, JSON.stringify(bad));
    }
    const edit = TaskEdit.parse({ title: '  Ship it  ', priority: 3 });
    assert.ok(Object.isFrozen(edit));
    assert.deepEqual(edit.fields, ['title', 'priority']);
    assert.ok(edit.equals(TaskEdit.parse({ priority: 3, title: 'Ship it' })));
  });

  it('sends the changed fields; a field set to what the item has is dropped', () => {
    const edit = TaskEdit.parse({
      title: 'Ship it',
      status: 'open',
      dueAt: new Date('2026-11-22T10:00:00Z'),
      priority: 2,
    });
    assert.deepEqual(edit.against(item(), JIRA, TZ), {
      patch: {
        timeZone: TZ,
        title: 'Ship it',
        due: { at: new Date('2026-11-22T10:00:00Z'), allDay: true },
      },
      fields: ['title', 'dueAt'],
    });
    // An edit that resends the item as it is changes nothing: no write (and no write gate).
    const same = TaskEdit.parse({
      title: 'Write the report',
      status: 'open',
      dueAt: DUE,
      priority: 2,
    });
    assert.equal(same.against(item(), JIRA, TZ), null);
    // allDay alone flips the due date: that is a change.
    const flip = TaskEdit.parse({ dueAt: DUE, allDay: false }).against(item(), JIRA, TZ);
    assert.deepEqual(flip?.patch.due, { at: DUE, allDay: false });
  });

  it('a changed field the provider doesn’t take is 422 field_not_writable, naming only those', () => {
    const edit = TaskEdit.parse({ title: 'Ship it', startAt: new Date('2026-11-18T08:00:00Z') });
    assert.throws(
      () => edit.against(item(), JIRA, TZ),
      (error: unknown) =>
        error instanceof FieldNotWritableError &&
        error.statusCode === 422 &&
        error.code === 'field_not_writable' &&
        error.fields.join() === 'startAt' &&
        error.openIn?.url === URL,
    );
    // Unchanged, it is no write, so it isn't refused either.
    assert.deepEqual(
      TaskEdit.parse({ title: 'Ship it', startAt: null }).against(item(), JIRA, TZ)?.fields,
      ['title'],
    );
    // A kind that takes no write-back (a pull request): every changed field is refused.
    assert.throws(
      () => TaskEdit.parse({ title: 'x' }).against(item({ kind: 'pr' }), [], TZ),
      FieldNotWritableError,
    );
  });
});
