import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  asDate,
  asObject,
  asString,
  dateOnlyDueAt,
  epochMsToDate,
  localDateString,
  sortedStrings,
} from './trackerCommon.js';

describe('asObject / asString / asDate', () => {
  it('accept only plain objects, non-blank strings and parseable dates', () => {
    assert.deepEqual(asObject({ a: 1 }), { a: 1 });
    assert.equal(asObject([]), null);
    assert.equal(asObject(null), null);
    assert.equal(asString(' x '), ' x ');
    assert.equal(asString('  '), null);
    assert.equal(asString(3), null);
    assert.equal(asDate('2026-11-09T12:30:00.000Z')?.toISOString(), '2026-11-09T12:30:00.000Z');
    assert.equal(asDate('nope'), null);
    assert.equal(asDate(undefined), null);
  });
});

describe('dateOnlyDueAt', () => {
  it('is 23:59 local time on that date (Asia/Jerusalem, winter)', () => {
    assert.equal(
      dateOnlyDueAt('2026-11-15', 'Asia/Jerusalem')?.toISOString(),
      '2026-11-15T21:59:00.000Z',
    );
  });

  it('follows daylight saving (Asia/Jerusalem, summer)', () => {
    assert.equal(
      dateOnlyDueAt('2026-07-15', 'Asia/Jerusalem')?.toISOString(),
      '2026-07-15T20:59:00.000Z',
    );
  });

  it('uses the given zone', () => {
    assert.equal(
      dateOnlyDueAt('2026-11-15', 'America/New_York')?.toISOString(),
      '2026-11-16T04:59:00.000Z',
    );
  });

  it('refuses anything that is not a calendar date', () => {
    for (const bad of ['', '2026-13-01', '2026-02-30', '15/11/2026', '2026-11-15T10:00:00Z']) {
      assert.equal(dateOnlyDueAt(bad, 'Asia/Jerusalem'), null, bad);
    }
  });
});

describe('epochMsToDate', () => {
  it('reads a string or a number of milliseconds', () => {
    assert.equal(epochMsToDate('1794209400000')?.toISOString(), '2026-11-09T07:30:00.000Z');
    assert.equal(epochMsToDate(1794209400000)?.toISOString(), '2026-11-09T07:30:00.000Z');
  });

  it('is null for empty or unusable values', () => {
    for (const bad of [null, undefined, '', 'abc', 0, '0', Number.NaN]) {
      assert.equal(epochMsToDate(bad), null, String(bad));
    }
  });
});

describe('sortedStrings', () => {
  it('drops blanks and duplicates, and sorts', () => {
    assert.deepEqual(sortedStrings(['b', 'a', '', 'b', '  ']), ['a', 'b']);
  });
});

describe('localDateString', () => {
  it('is the calendar date of the instant in the zone', () => {
    const instant = new Date('2026-11-15T22:30:00.000Z');
    assert.equal(localDateString(instant, 'Asia/Jerusalem'), '2026-11-16');
    assert.equal(localDateString(instant, 'UTC'), '2026-11-15');
  });
});
