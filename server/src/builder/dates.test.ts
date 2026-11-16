import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDatePreset, SEMESTERS, type DateBounds } from './dates.js';

const TZ = 'Asia/Jerusalem';
const HOUR = 60 * 60 * 1000;

function at(iso: string): Date {
  return new Date(iso);
}

function range(bounds: DateBounds): [string, string] {
  return [bounds.from.toISOString(), bounds.to.toISOString()];
}

function contains(bounds: DateBounds, instant: Date): boolean {
  return bounds.from.getTime() <= instant.getTime() && instant.getTime() < bounds.to.getTime();
}

function hours(bounds: DateBounds): number {
  return (bounds.to.getTime() - bounds.from.getTime()) / HOUR;
}

describe('resolveDatePreset: weeks', () => {
  it('starts the week on Sunday 00:00 local', () => {
    // Wednesday 2026-11-11, 10:00 in Jerusalem (UTC+2).
    const week = resolveDatePreset('this_week', at('2026-11-11T08:00:00Z'), TZ, 'sun');
    assert.deepEqual(range(week), ['2026-11-07T22:00:00.000Z', '2026-11-14T22:00:00.000Z']);
  });

  it('starts it on Monday when the workspace says so', () => {
    const week = resolveDatePreset('this_week', at('2026-11-11T08:00:00Z'), TZ, 'mon');
    assert.deepEqual(range(week), ['2026-11-08T22:00:00.000Z', '2026-11-15T22:00:00.000Z']);
  });

  it('a Sunday opens a new week, and Saturday 23:30 still belongs to the old one', () => {
    const sunday = resolveDatePreset('this_week', at('2026-11-15T10:00:00Z'), TZ, 'sun');
    assert.equal(sunday.from.toISOString(), '2026-11-14T22:00:00.000Z');
    const saturdayNight = resolveDatePreset('this_week', at('2026-11-14T21:30:00Z'), TZ, 'sun');
    assert.equal(saturdayNight.from.toISOString(), '2026-11-07T22:00:00.000Z');
    const sundayForMonday = resolveDatePreset('this_week', at('2026-11-15T10:00:00Z'), TZ, 'mon');
    assert.equal(sundayForMonday.from.toISOString(), '2026-11-08T22:00:00.000Z');
  });
});

describe('resolveDatePreset: days', () => {
  it('today runs from local midnight to the next one; 23:30 local is inside', () => {
    const now = at('2026-11-11T08:00:00Z');
    const today = resolveDatePreset('today', now, TZ, 'sun');
    assert.deepEqual(range(today), ['2026-11-10T22:00:00.000Z', '2026-11-11T22:00:00.000Z']);
    assert.ok(contains(today, at('2026-11-11T21:30:00Z')), '23:30 local is today');
    assert.ok(!contains(today, at('2026-11-11T22:30:00Z')), '00:30 local is tomorrow');
    const lateNow = resolveDatePreset('today', at('2026-11-11T21:30:00Z'), TZ, 'sun');
    assert.deepEqual(range(lateNow), range(today));
  });

  it('2026-11-15T21:59:00Z (23:59 in Jerusalem) falls on local Nov 15', () => {
    const today = resolveDatePreset('today', at('2026-11-15T21:59:00Z'), TZ, 'sun');
    assert.deepEqual(range(today), ['2026-11-14T22:00:00.000Z', '2026-11-15T22:00:00.000Z']);
    const morning = resolveDatePreset('today', at('2026-11-15T05:00:00Z'), TZ, 'sun');
    assert.ok(contains(morning, at('2026-11-15T21:59:00Z')));
    const tomorrow = resolveDatePreset('tomorrow', at('2026-11-14T12:00:00Z'), TZ, 'sun');
    assert.ok(contains(tomorrow, at('2026-11-15T21:59:00Z')));
  });

  it('tomorrow is the next local day', () => {
    const tomorrow = resolveDatePreset('tomorrow', at('2026-11-11T21:30:00Z'), TZ, 'sun');
    assert.deepEqual(range(tomorrow), ['2026-11-11T22:00:00.000Z', '2026-11-12T22:00:00.000Z']);
  });
});

describe('resolveDatePreset: daylight saving time in Asia/Jerusalem', () => {
  it('2026-03-27 (IST → IDT) is 23 hours long', () => {
    const today = resolveDatePreset('today', at('2026-03-27T09:00:00Z'), TZ, 'sun');
    assert.deepEqual(range(today), ['2026-03-26T22:00:00.000Z', '2026-03-27T21:00:00.000Z']);
    assert.equal(hours(today), 23);
    const tomorrow = resolveDatePreset('tomorrow', at('2026-03-26T09:00:00Z'), TZ, 'sun');
    assert.deepEqual(range(tomorrow), range(today));
    const week = resolveDatePreset('this_week', at('2026-03-27T09:00:00Z'), TZ, 'sun');
    assert.deepEqual(range(week), ['2026-03-21T22:00:00.000Z', '2026-03-28T21:00:00.000Z']);
    assert.equal(hours(week), 7 * 24 - 1);
  });

  it('2026-10-25 (IDT → IST) is 25 hours long', () => {
    const today = resolveDatePreset('today', at('2026-10-25T09:00:00Z'), TZ, 'sun');
    assert.deepEqual(range(today), ['2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z']);
    assert.equal(hours(today), 25);
    const week = resolveDatePreset('this_week', at('2026-10-25T09:00:00Z'), TZ, 'sun');
    assert.equal(hours(week), 7 * 24 + 1);
  });

  it('a day that starts in a DST gap starts when the clock jumps (America/Santiago)', () => {
    // 2026-09-06: Santiago skips from 23:59:59 (UTC-4) to 01:00 (UTC-3); there is no midnight.
    const gap = resolveDatePreset('today', at('2026-09-06T15:00:00Z'), 'America/Santiago', 'sun');
    assert.deepEqual(range(gap), ['2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z']);
    // 2026-04-04 repeats 23:00–23:59, so it is 25 hours long.
    const repeat = resolveDatePreset(
      'today',
      at('2026-04-04T15:00:00Z'),
      'America/Santiago',
      'sun',
    );
    assert.deepEqual(range(repeat), ['2026-04-04T03:00:00.000Z', '2026-04-05T04:00:00.000Z']);
  });
});

describe('resolveDatePreset: rolling and calendar ranges', () => {
  const now = at('2026-11-11T08:00:00Z');

  it('next_7d and next_14d run from now', () => {
    assert.deepEqual(range(resolveDatePreset('next_7d', now, TZ, 'sun')), [
      '2026-11-11T08:00:00.000Z',
      '2026-11-18T08:00:00.000Z',
    ]);
    assert.deepEqual(range(resolveDatePreset('next_14d', now, TZ, 'sun')), [
      '2026-11-11T08:00:00.000Z',
      '2026-11-25T08:00:00.000Z',
    ]);
  });

  it('overdue runs from the epoch to now', () => {
    assert.deepEqual(range(resolveDatePreset('overdue', now, TZ, 'sun')), [
      '1970-01-01T00:00:00.000Z',
      '2026-11-11T08:00:00.000Z',
    ]);
  });

  it('upcoming_7d and upcoming_14d run from the epoch, so overdue items are included', () => {
    assert.deepEqual(range(resolveDatePreset('upcoming_7d', now, TZ, 'sun')), [
      '1970-01-01T00:00:00.000Z',
      '2026-11-18T08:00:00.000Z',
    ]);
    assert.deepEqual(range(resolveDatePreset('upcoming_14d', now, TZ, 'sun')), [
      '1970-01-01T00:00:00.000Z',
      '2026-11-25T08:00:00.000Z',
    ]);
    // Exactly overdue + next_14d: a year-old deadline and one 13 days out are both in.
    const upcoming = resolveDatePreset('upcoming_14d', now, TZ, 'sun');
    assert.ok(contains(upcoming, at('2025-11-11T08:00:00Z')));
    assert.ok(contains(upcoming, at('2026-11-24T08:00:00Z')));
    assert.ok(!contains(upcoming, at('2026-11-25T08:00:00Z')));
    assert.equal(upcoming.to.getTime(), resolveDatePreset('next_14d', now, TZ, 'sun').to.getTime());
    assert.equal(
      upcoming.from.getTime(),
      resolveDatePreset('overdue', now, TZ, 'sun').from.getTime(),
    );
  });

  it('this_month is the local calendar month, across the year end too', () => {
    assert.deepEqual(range(resolveDatePreset('this_month', now, TZ, 'sun')), [
      '2026-10-31T22:00:00.000Z',
      '2026-11-30T22:00:00.000Z',
    ]);
    // 23:30 on Nov 30 local is still November.
    const lastEvening = resolveDatePreset('this_month', at('2026-11-30T21:30:00Z'), TZ, 'sun');
    assert.equal(lastEvening.from.toISOString(), '2026-10-31T22:00:00.000Z');
    assert.deepEqual(
      range(resolveDatePreset('this_month', at('2026-12-15T12:00:00Z'), TZ, 'sun')),
      ['2026-11-30T22:00:00.000Z', '2026-12-31T22:00:00.000Z'],
    );
  });

  it('returns fresh dates: callers may not share them', () => {
    const bounds = resolveDatePreset('overdue', now, TZ, 'sun');
    assert.notEqual(bounds.to, now);
  });
});

describe('resolveDatePreset: this_semester', () => {
  const fall2026 = ['2026-10-14T21:00:00.000Z', '2027-02-15T22:00:00.000Z'];
  const spring2026 = ['2026-02-28T22:00:00.000Z', '2026-07-15T21:00:00.000Z'];
  const spring2027 = ['2027-02-28T22:00:00.000Z', '2027-07-15T21:00:00.000Z'];
  const semester = (iso: string): [string, string] =>
    range(resolveDatePreset('this_semester', at(iso), TZ, 'sun'));

  it('uses the constants: fall Oct 15 – Feb 15, spring Mar 1 – Jul 15', () => {
    assert.deepEqual(
      SEMESTERS.map((s) => [s.name, s.first.month, s.first.day, s.last.month, s.last.day]),
      [
        ['fall', 10, 15, 2, 15],
        ['spring', 3, 1, 7, 15],
      ],
    );
  });

  it('is the semester containing now, across the new year', () => {
    assert.deepEqual(semester('2026-11-12T10:00:00Z'), fall2026);
    assert.deepEqual(semester('2027-01-20T10:00:00Z'), fall2026);
    assert.deepEqual(semester('2026-05-01T10:00:00Z'), spring2026);
    assert.deepEqual(semester('2026-01-10T10:00:00Z'), [
      '2025-10-14T21:00:00.000Z',
      '2026-02-15T22:00:00.000Z',
    ]);
  });

  it('includes the first and last day, local time', () => {
    assert.deepEqual(semester('2026-10-14T21:00:00Z'), fall2026); // Oct 15 00:00
    assert.deepEqual(semester('2027-02-15T21:59:00Z'), fall2026); // Feb 15 23:59
    assert.deepEqual(semester('2026-07-15T20:59:00Z'), spring2026); // Jul 15 23:59
  });

  it('between semesters, is the next one', () => {
    assert.deepEqual(semester('2027-02-15T22:00:00Z'), spring2027); // Feb 16 00:00
    assert.deepEqual(semester('2026-07-15T21:00:00Z'), fall2026); // Jul 16 00:00
    assert.deepEqual(semester('2026-08-20T10:00:00Z'), fall2026);
    assert.deepEqual(semester('2026-10-14T20:59:00Z'), fall2026); // Oct 14 23:59
  });
});
