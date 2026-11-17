/**
 * DueDate: an item's due date as an immutable value object, compared by value (same instant, same
 * kind), and what the push projects a due-only item to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError } from '../../errors/ValidationError.js';
import { projectEvent, type PushItem } from '../../gcal/diff.js';
import { DueDate } from './DueDate.js';

const AT = new Date('2026-12-01T09:30:00Z');

describe('DueDate', () => {
  it('is made from an instant and its kind; none without an instant', () => {
    const due = DueDate.of(AT, false);
    assert.equal(due.at.getTime(), AT.getTime());
    assert.equal(due.allDay, false);
    assert.equal(DueDate.from(null, true), null);
    assert.equal(DueDate.from(AT, true)?.allDay, true);
    assert.throws(() => DueDate.of(new Date('nope'), false), ValidationError);
  });

  it('is immutable: frozen, and holds its own copy of the instant', () => {
    const source = new Date(AT.getTime());
    const due = DueDate.of(source, false);
    source.setUTCFullYear(2030);
    due.at.setUTCFullYear(2031);
    assert.equal(due.at.toISOString(), AT.toISOString());
    assert.ok(Object.isFrozen(due));
    assert.deepEqual(JSON.parse(JSON.stringify(due)), { at: AT.toISOString(), allDay: false });
  });

  it('compares by value: the same instant and the same kind', () => {
    assert.ok(DueDate.of(AT, true).equals(DueDate.of(new Date(AT.getTime()), true)));
    assert.ok(!DueDate.of(AT, true).equals(DueDate.of(AT, false)));
    assert.ok(!DueDate.of(AT, true).equals(DueDate.of(new Date(AT.getTime() + 1), true)));
    assert.ok(!DueDate.of(AT, true).equals(null));
    assert.ok(DueDate.same(null, null));
    assert.ok(!DueDate.same(null, DueDate.of(AT, false)));
    assert.ok(!DueDate.same(DueDate.of(AT, false), null));
    assert.ok(DueDate.same(DueDate.of(AT, false), DueDate.of(AT, false)));
  });
});

describe('the push projects a due-only item through its DueDate', () => {
  const item = (dueAt: Date | null, allDay: boolean): PushItem => ({
    id: 'item-1',
    title: 'Due',
    startAt: null,
    dueAt,
    endAt: null,
    allDay,
    source: { provider: 'local', url: '' },
    calendarSync: null,
    plannedAt: null,
    editedAt: null,
  });

  it('all day: the day it falls on in the zone (end exclusive)', () => {
    const event = projectEvent(item(new Date('2026-12-01T23:30:00Z'), true), 'w', 'Asia/Jerusalem');
    assert.deepEqual([event?.start, event?.end], [{ date: '2026-12-02' }, { date: '2026-12-03' }]);
  });

  it('timed: the 15 minutes up to it', () => {
    const event = projectEvent(item(AT, false), 'w', 'UTC');
    assert.deepEqual(
      [event?.start, event?.end],
      [
        { dateTime: '2026-12-01T09:15:00.000Z', timeZone: 'UTC' },
        { dateTime: '2026-12-01T09:30:00.000Z', timeZone: 'UTC' },
      ],
    );
  });

  it('no date at all: no event', () => {
    assert.equal(projectEvent(item(null, false), 'w', 'UTC'), null);
  });
});
