/**
 * The edit value objects, without a database: TaskEdit (a mirrored item's edit, validated, split
 * into what its provider takes and what stays here) and EventEdit (a Google event's patch).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ItemData } from '../../models/definitions/Item.js';
import { EventEdit } from './EventEdit.js';
import { TaskEdit } from './TaskEdit.js';

const TZ = 'Asia/Jerusalem';
const DUE = new Date('2026-11-20T21:59:00.000Z');

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
    ...over,
  }) as ItemData;

const status400 = { statusCode: 400 };

describe('TaskEdit', () => {
  it('validates: known fields only, at least one, each of its type', () => {
    for (const bad of [
      {},
      { title: '   ' },
      { title: 'x'.repeat(256) },
      { status: 'merged' },
      { priority: 5 },
      { priority: 1.5 },
      { dueAt: '2026-11-20' },
      { dueAt: new Date('nope') },
      { allDay: true },
      { allDay: true, dueAt: null },
      { labels: ['x'] },
      { bodyPreview: 'x' },
      { note: 'x'.repeat(5001) },
      { attrs: { 'Not A Key': 1 } },
      null,
      'title',
    ]) {
      assert.throws(() => TaskEdit.parse(bad), status400, JSON.stringify(bad));
    }
    const edit = TaskEdit.parse({ title: '  Ship it  ', note: 'mine' });
    assert.ok(Object.isFrozen(edit));
    assert.deepEqual(edit.taskFields, ['title']);
    assert.ok(edit.equals(TaskEdit.parse({ note: 'mine', title: 'Ship it' })));
  });

  it('sends the changed fields its provider takes; the rest stays here', () => {
    const edit = TaskEdit.parse({
      title: 'Ship it',
      status: 'done',
      dueAt: new Date('2026-11-22T10:00:00Z'),
      startAt: new Date('2026-11-18T08:00:00Z'),
      priority: 4,
      note: 'mine',
      pinned: true,
    });
    // Jira: title, status, due date, priority; it has no start date.
    const split = edit.split(item(), ['title', 'status', 'dueAt', 'priority'], TZ);
    assert.deepEqual(split.provider, {
      timeZone: TZ,
      title: 'Ship it',
      status: 'done',
      due: { at: new Date('2026-11-22T10:00:00Z'), allDay: true },
      priority: 4,
    });
    assert.deepEqual(split.providerFields, ['title', 'status', 'dueAt', 'priority']);
    assert.deepEqual(split.local, {
      columns: { startAt: new Date('2026-11-18T08:00:00Z') },
      overlay: { note: 'mine', pinned: true },
    });
  });

  it('a field set to what the item has is not sent; TodoList’s own fields never are', () => {
    const edit = TaskEdit.parse({
      title: 'Write the report',
      status: 'open',
      dueAt: DUE,
      hidden: true,
    });
    const split = edit.split(item(), ['title', 'status', 'dueAt'], TZ);
    assert.equal(split.provider, null);
    assert.deepEqual(split.providerFields, []);
    assert.deepEqual(split.local, { columns: {}, overlay: { hidden: true } });
    assert.ok(!edit.touches(['priority']) && edit.touches(['status']));
    // allDay alone flips the due date: that is a change.
    const flip = TaskEdit.parse({ dueAt: DUE, allDay: false }).split(item(), ['dueAt'], TZ);
    assert.deepEqual(flip.provider?.due, { at: DUE, allDay: false });
  });

  it('a provider without the field keeps it here (GitHub: the due date)', () => {
    const split = TaskEdit.parse({ dueAt: null, priority: null }).split(
      item(),
      ['title', 'status'],
      TZ,
    );
    assert.equal(split.provider, null);
    assert.deepEqual(split.local.columns, { dueAt: null, priority: null });
  });
});

describe('EventEdit', () => {
  it('a timed event: both times with the zone, the all-day form cleared', () => {
    const edit = EventEdit.parse(
      {
        title: ' Dentist ',
        start: new Date('2026-11-20T08:00:00Z'),
        end: new Date('2026-11-20T09:00:00Z'),
      },
      TZ,
    );
    assert.deepEqual(edit.changes, {
      summary: 'Dentist',
      start: { dateTime: '2026-11-20T08:00:00.000Z', timeZone: TZ, date: null },
      end: { dateTime: '2026-11-20T09:00:00.000Z', timeZone: TZ, date: null },
    });
    assert.deepEqual(edit.fields, ['title', 'time']);
  });

  it('an all-day event: the days in the zone, end exclusive; an end on the start’s day is one day', () => {
    // 20 Nov 23:30 in Jerusalem is still the 20th there (21:30 UTC).
    const oneDay = EventEdit.parse(
      {
        start: new Date('2026-11-20T21:30:00Z'),
        end: new Date('2026-11-20T21:30:00Z'),
        allDay: true,
      },
      TZ,
    );
    assert.deepEqual(oneDay.changes, {
      start: { date: '2026-11-20', dateTime: null, timeZone: null },
      end: { date: '2026-11-21', dateTime: null, timeZone: null },
    });
    // As a pulled item keeps it: local midnight to the next local midnight.
    const asStored = EventEdit.parse(
      {
        start: new Date('2026-11-19T22:00:00Z'),
        end: new Date('2026-11-21T22:00:00Z'),
        allDay: true,
      },
      TZ,
    );
    assert.deepEqual(asStored.changes.end, { date: '2026-11-22', dateTime: null, timeZone: null });
  });

  it('a description (null clears it), and the rules: a time is whole and ends after it starts', () => {
    assert.deepEqual(EventEdit.parse({ description: null }, TZ).changes, { description: '' });
    for (const bad of [
      {},
      { start: new Date('2026-11-20T08:00:00Z') },
      { allDay: true },
      { start: new Date('2026-11-20T09:00:00Z'), end: new Date('2026-11-20T08:00:00Z') },
      { start: new Date('2026-11-20T09:00:00Z'), end: new Date('2026-11-20T09:00:00Z') },
      { title: '' },
      { location: 'x' },
    ]) {
      assert.throws(() => EventEdit.parse(bad, TZ), status400, JSON.stringify(bad));
    }
  });
});
