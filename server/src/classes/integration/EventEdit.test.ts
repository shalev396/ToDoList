/**
 * EventEdit, without a database: a Google event's patch in the item's own names (`title`,
 * `startAt`, `endAt`, `allDay`, plus `description`), its time given whole, a one-line title.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventEdit } from './EventEdit.js';

const TZ = 'Asia/Jerusalem';
const status400 = { statusCode: 400 };

describe('EventEdit', () => {
  it('a timed event: both times with the zone, the all-day form cleared', () => {
    const edit = EventEdit.parse(
      {
        title: ' Dentist ',
        startAt: new Date('2026-11-20T08:00:00Z'),
        endAt: new Date('2026-11-20T09:00:00Z'),
      },
      TZ,
    );
    assert.deepEqual(edit.changes, {
      summary: 'Dentist',
      start: { dateTime: '2026-11-20T08:00:00.000Z', timeZone: TZ, date: null },
      end: { dateTime: '2026-11-20T09:00:00.000Z', timeZone: TZ, date: null },
    });
    assert.deepEqual(edit.fields, ['title', 'startAt', 'endAt']);
  });

  it('an all-day event: the days in the zone, end exclusive; an end on the start’s day is one day', () => {
    // 20 Nov 23:30 in Jerusalem is still the 20th there (21:30 UTC).
    const oneDay = EventEdit.parse(
      {
        startAt: new Date('2026-11-20T21:30:00Z'),
        endAt: new Date('2026-11-20T21:30:00Z'),
        allDay: true,
      },
      TZ,
    );
    assert.deepEqual(oneDay.changes, {
      start: { date: '2026-11-20', dateTime: null, timeZone: null },
      end: { date: '2026-11-21', dateTime: null, timeZone: null },
    });
    // As the item keeps it: local midnight to the next local midnight.
    const asStored = EventEdit.parse(
      {
        startAt: new Date('2026-11-19T22:00:00Z'),
        endAt: new Date('2026-11-21T22:00:00Z'),
        allDay: true,
      },
      TZ,
    );
    assert.deepEqual(asStored.changes.end, { date: '2026-11-22', dateTime: null, timeZone: null });
  });

  it('a description (null clears it), and the rules: a whole time, after its start, one-line title', () => {
    assert.deepEqual(EventEdit.parse({ description: null }, TZ).changes, { description: '' });
    assert.deepEqual(EventEdit.parse({ description: 'x' }, TZ).fields, ['description']);
    for (const bad of [
      {},
      { startAt: new Date('2026-11-20T08:00:00Z') },
      { allDay: true },
      { startAt: new Date('2026-11-20T09:00:00Z'), endAt: new Date('2026-11-20T08:00:00Z') },
      { startAt: new Date('2026-11-20T09:00:00Z'), endAt: new Date('2026-11-20T09:00:00Z') },
      { title: '' },
      { title: 'A\nB' },
      { start: new Date(), end: new Date() },
      { location: 'x' },
    ]) {
      assert.throws(() => EventEdit.parse(bad, TZ), status400, JSON.stringify(bad));
    }
  });
});
