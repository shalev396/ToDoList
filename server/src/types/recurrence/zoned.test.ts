import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addLocalDays,
  endOfZonedDay,
  fromWallString,
  startOfZonedDay,
  wallDate,
  wallString,
  zonedTime,
} from './zoned.js';

const TZ = 'Asia/Jerusalem';

describe('fromWallString', () => {
  it('is the inverse of wallString', () => {
    for (const iso of [
      '2026-11-12T08:00:00.000Z',
      '2026-07-01T21:59:30.000Z',
      '2026-10-25T11:00:00.000Z',
      '2027-03-26T07:00:00.000Z',
    ]) {
      const date = new Date(iso);
      assert.equal(fromWallString(wallString(date, TZ), TZ).toISOString(), iso);
    }
  });

  it('reads a wall time without seconds', () => {
    assert.equal(fromWallString('2026-11-12T10:00', TZ).toISOString(), '2026-11-12T08:00:00.000Z');
  });

  it('resolves DST edges like zonedTime: a repeated time is its first, a skipped one moves on', () => {
    // 01:30 happens twice on 25 Oct 2026; 02:30 never happens on 26 Mar 2027.
    assert.equal(
      fromWallString('2026-10-25T01:30:00', TZ).getTime(),
      zonedTime(2026, 10, 25, 1, 30, TZ).getTime(),
    );
    assert.equal(
      fromWallString('2026-10-25T01:30:00', TZ).toISOString(),
      '2026-10-24T22:30:00.000Z',
    );
    assert.equal(
      fromWallString('2027-03-26T02:30:00', TZ).toISOString(),
      '2027-03-26T00:30:00.000Z',
    );
  });

  it('gives an invalid date for text that is not a wall time', () => {
    for (const text of ['', 'tomorrow', '2026-13-01T10:00:00', '2026-02-30T10:00', '2026-11-12']) {
      assert.ok(Number.isNaN(fromWallString(text, TZ).getTime()), text);
    }
  });
});

describe('zone helpers', () => {
  it('wallString and wallDate read the wall clock in the zone', () => {
    const date = new Date('2026-11-12T22:30:00.000Z');
    assert.equal(wallString(date, TZ), '2026-11-13T00:30:00');
    assert.equal(wallDate(date, TZ), '2026-11-13');
  });

  it('addLocalDays lands on local midnight, across a 25-hour day', () => {
    const saturday = new Date('2026-10-24T09:00:00.000Z');
    assert.equal(addLocalDays(saturday, 2, TZ).toISOString(), '2026-10-25T22:00:00.000Z');
    assert.equal(addLocalDays(saturday, -1, TZ).toISOString(), '2026-10-22T21:00:00.000Z');
  });

  it('a local day starts at midnight and the DST day is 25 hours long', () => {
    const day = new Date('2026-10-25T12:00:00.000Z');
    const start = startOfZonedDay(day, TZ);
    assert.equal(start.toISOString(), '2026-10-24T21:00:00.000Z');
    assert.equal(endOfZonedDay(day, TZ).getTime() - start.getTime(), 25 * 3600_000);
  });
});
