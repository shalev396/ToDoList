import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARITY_CASES } from '@api-types/recurrence/cases.ts';
import { zonedTime } from '../clock/ClockRing.math.ts';
import {
  expandOccurrences,
  monthGridRange,
  visibleRange,
  weekRange,
  wallString,
  type TimeRow,
} from './occurrences.ts';

const TZ = 'Asia/Jerusalem';
const at = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  zonedTime(y, m, d, h, min, TZ);

function row(partial: Partial<TimeRow> & { id: string }): TimeRow {
  return {
    kind: 'event',
    title: partial.id,
    status: 'open',
    startAt: null,
    endAt: null,
    dueAt: null,
    allDay: false,
    source: { provider: 'google_calendar', url: 'https://x', externalId: partial.id, key: null },
    props: {},
    ...partial,
  };
}

const series = (over: Partial<TimeRow> = {}): TimeRow =>
  row({
    id: 'master',
    startAt: at(2026, 11, 1, 10),
    endAt: at(2026, 11, 1, 11),
    props: { calendarId: 'c', eventId: 'e1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU,TU,TH'] },
    ...over,
  });

const WEEK = { from: at(2026, 11, 8), to: at(2026, 11, 15) };

describe('expandOccurrences', () => {
  it('expands a series: one occurrence per matching weekday of the week', () => {
    const out = expandOccurrences([series()], WEEK, TZ);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((o) => wallString(o.start, TZ)),
      ['2026-11-08T10:00:00', '2026-11-10T10:00:00', '2026-11-12T10:00:00'],
    );
    assert.equal(out[0]?.end?.getTime() ?? 0, at(2026, 11, 8, 11).getTime());
  });

  it('excludes a cancelled occurrence (an exdate), and never lists it', () => {
    const cancelled = row({
      id: 'x1',
      status: 'cancelled',
      startAt: at(2026, 11, 10, 10),
      props: {
        calendarId: 'c',
        recurringEventId: 'e1',
        originalStartAt: at(2026, 11, 10, 10).toISOString(),
      },
    });
    const out = expandOccurrences([series(), cancelled], WEEK, TZ);
    assert.deepEqual(
      out.map((o) => wallString(o.start, TZ)),
      ['2026-11-08T10:00:00', '2026-11-12T10:00:00'],
    );
    assert.ok(out.every((o) => o.row.id !== 'x1'));
  });

  it('replaces a moved occurrence by its exception', () => {
    const moved = row({
      id: 'x2',
      startAt: at(2026, 11, 12, 14),
      endAt: at(2026, 11, 12, 15),
      props: {
        calendarId: 'c',
        recurringEventId: 'e1',
        originalStartAt: at(2026, 11, 12, 10).toISOString(),
      },
    });
    const out = expandOccurrences([series(), moved], WEEK, TZ);
    const starts = out.map((o) => wallString(o.start, TZ));
    assert.ok(!starts.includes('2026-11-12T10:00:00'));
    assert.ok(starts.includes('2026-11-12T14:00:00'));
    assert.equal(out.length, 3);
  });

  it('accepts dates that arrived as JSON strings', () => {
    const json = series({
      startAt: at(2026, 11, 1, 10).toISOString(),
      endAt: at(2026, 11, 1, 11).toISOString(),
    });
    assert.equal(expandOccurrences([json], WEEK, TZ).length, 3);
  });

  it('keeps the wall-clock time across the spring DST change', () => {
    const weekly = series({
      startAt: at(2026, 3, 20, 10),
      endAt: at(2026, 3, 20, 11),
      props: { calendarId: 'c', eventId: 'e1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'] },
    });
    // Israel's clocks went forward on Fri 27 Mar 2026.
    const out = expandOccurrences([weekly], { from: at(2026, 3, 20), to: at(2026, 4, 4) }, TZ);
    assert.deepEqual(
      out.map((o) => wallString(o.start, TZ)),
      ['2026-03-20T10:00:00', '2026-03-27T10:00:00', '2026-04-03T10:00:00'],
    );
    assert.equal(
      (out[1]?.start.getTime() ?? 0) - (out[0]?.start.getTime() ?? 0),
      (7 * 24 - 1) * 3600_000,
    );
  });

  it('keeps the wall-clock time across the fall DST change', () => {
    const weekly = series({
      startAt: at(2026, 10, 18, 9),
      endAt: at(2026, 10, 18, 10),
      props: { calendarId: 'c', eventId: 'e1', recurrence: ['RRULE:FREQ=WEEKLY'] },
    });
    // Clocks went back on Sun 25 Oct 2026.
    const out = expandOccurrences([weekly], { from: at(2026, 10, 18), to: at(2026, 11, 2) }, TZ);
    assert.deepEqual(
      out.map((o) => wallString(o.start, TZ)),
      ['2026-10-18T09:00:00', '2026-10-25T09:00:00', '2026-11-01T09:00:00'],
    );
  });

  it('honours COUNT: no occurrence past the last one', () => {
    const counted = series({
      props: { calendarId: 'c', eventId: 'e1', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'] },
    });
    assert.equal(expandOccurrences([counted], WEEK, TZ).length, 1);
  });

  it('puts a due-only item at its due time, marked', () => {
    const due = row({ id: 'hw', kind: 'task', dueAt: at(2026, 11, 11, 23, 0) });
    const out = expandOccurrences([due], WEEK, TZ);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.dueOnly, true);
    assert.equal(out[0].start.getTime(), at(2026, 11, 11, 23).getTime());
  });

  it('keeps all-day items and drops items outside the range', () => {
    const allDay = row({
      id: 'ad',
      allDay: true,
      startAt: at(2026, 11, 9),
      endAt: at(2026, 11, 10),
    });
    const outside = row({ id: 'o', startAt: at(2026, 12, 9, 10), endAt: at(2026, 12, 9, 11) });
    const out = expandOccurrences([allDay, outside], WEEK, TZ);
    assert.deepEqual(
      out.map((o) => o.row.id),
      ['ad'],
    );
    assert.equal(out[0]?.allDay, true);
  });

  it('drops a cancelled single event and an item with no time', () => {
    const gone = row({ id: 'g', status: 'cancelled', startAt: at(2026, 11, 9, 10) });
    const none = row({ id: 'n' });
    assert.equal(expandOccurrences([gone, none], WEEK, TZ).length, 0);
  });
});

describe('visible ranges', () => {
  it('a week starts on Sunday at local midnight and is 7 local days, on a 25-hour day too', () => {
    const fall = weekRange(at(2026, 10, 22, 12), TZ, 'sun');
    assert.equal(fall.from.getTime(), at(2026, 10, 18).getTime());
    assert.equal(fall.to.getTime(), at(2026, 10, 25).getTime());
    const sunday = weekRange(at(2026, 10, 25, 3), TZ, 'sun');
    assert.equal(sunday.from.getTime(), at(2026, 10, 25).getTime());
    assert.equal(sunday.to.getTime(), at(2026, 11, 1).getTime());
    assert.equal(sunday.to.getTime() - sunday.from.getTime(), (7 * 24 + 1) * 3600_000);
  });

  it('a Monday week start moves the week', () => {
    const r = weekRange(at(2026, 11, 8, 12), TZ, 'mon');
    assert.equal(r.from.getTime(), at(2026, 11, 2).getTime());
  });

  it('the month grid is six whole weeks that contain the month', () => {
    const r = monthGridRange(at(2026, 11, 12), TZ, 'sun');
    assert.equal(r.from.getTime(), at(2026, 11, 1).getTime());
    assert.equal(r.to.getTime(), at(2026, 12, 13).getTime());
  });
});

describe('week start setting', () => {
  it('sun and mon give different week ranges for the same Wednesday', () => {
    const wed = at(2026, 11, 11, 12);
    const sun = visibleRange('week', wed, TZ, 'sun');
    const mon = visibleRange('week', wed, TZ, 'mon');
    assert.equal(sun.from.getTime(), at(2026, 11, 8).getTime());
    assert.equal(mon.from.getTime(), at(2026, 11, 9).getTime());
    assert.equal(mon.to.getTime(), at(2026, 11, 16).getTime());
  });

  it('the month grid starts on the chosen weekday', () => {
    const sun = visibleRange('month', at(2026, 11, 12), TZ, 'sun');
    const mon = visibleRange('month', at(2026, 11, 12), TZ, 'mon');
    assert.equal(sun.from.getTime(), at(2026, 11, 1).getTime());
    assert.equal(mon.from.getTime(), at(2026, 10, 26).getTime());
  });
});

describe('parity with the server: every shared case through the client import path', () => {
  for (const c of PARITY_CASES) {
    it(c.name, () => {
      const got = expandOccurrences(
        c.rows,
        { from: new Date(c.range.from), to: new Date(c.range.to) },
        c.timeZone,
      );
      assert.deepEqual(
        got.map((o) => ({
          key: o.key,
          start: o.start.toISOString(),
          end: o.end?.toISOString() ?? null,
        })),
        c.expected,
      );
    });
  }
});
