import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARITY_CASES, type ParityCase } from './cases.js';
import {
  MAX_OCCURRENCES_PER_SERIES,
  expandOccurrences,
  isSeriesRow,
  localExceptionsOf,
  type TimeRow,
} from './occurrences.js';

function parityCase(name: string): ParityCase {
  const found = PARITY_CASES.find((c) => c.name === name);
  assert.ok(found, `no parity case named ${name}`);
  return found;
}

function expand(c: ParityCase): ReturnType<typeof expandOccurrences> {
  return expandOccurrences(
    c.rows,
    { from: new Date(c.range.from), to: new Date(c.range.to) },
    c.timeZone,
  );
}

describe('expandOccurrences: parity cases', () => {
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

describe('expandOccurrences: occurrence identity', () => {
  it('a moved Google occurrence carries its original slot and its master', () => {
    const moved = expand(parityCase('google-moved-occurrence')).find((o) => o.row.id === 'x2');
    assert.ok(moved);
    assert.equal(moved.originalStart?.toISOString(), '2026-11-12T08:00:00.000Z');
    assert.equal(moved.seriesRowId, 'master');
  });

  it("a Google master's own occurrences name the master and their slot", () => {
    const [first] = expand(parityCase('google-moved-occurrence'));
    assert.ok(first);
    assert.equal(first.seriesRowId, 'master');
    assert.equal(first.originalStart?.toISOString(), first.start.toISOString());
  });

  it('a moved Google occurrence whose master is not among the rows keys on itself', () => {
    const c = parityCase('google-moved-occurrence');
    const alone = c.rows.filter((r) => r.id === 'x2');
    const out = expandOccurrences(
      alone,
      { from: new Date(c.range.from), to: new Date(c.range.to) },
      c.timeZone,
    );
    assert.equal(out.length, 1);
    const [moved] = out;
    assert.ok(moved);
    assert.equal(moved.seriesRowId, null);
    assert.equal(moved.originalStart?.toISOString(), '2026-11-12T08:00:00.000Z');
    assert.equal(moved.key, `x2@${String(Date.parse('2026-11-12T08:00:00.000Z'))}`);
  });

  it('a moved local occurrence keeps its original slot', () => {
    const [moved] = expand(parityCase('local-moved'));
    assert.ok(moved);
    assert.equal(moved.originalStart?.toISOString(), '2026-11-08T11:00:00.000Z');
    assert.equal(moved.seriesRowId, 'block');
  });

  it('a single item is not an occurrence of anything', () => {
    const [single] = expand(parityCase('single-timed'));
    assert.ok(single);
    assert.equal(single.originalStart, null);
    assert.equal(single.seriesRowId, null);
    assert.equal(single.dueOnly, false);
  });

  it('exceptions on a Google row are not read: only local series have them', () => {
    const c = parityCase('google-moved-occurrence');
    const master = c.rows.find((r) => r.id === 'master');
    assert.ok(master);
    const withExceptions: TimeRow = {
      ...master,
      props: {
        ...master.props,
        exceptions: [{ originalStart: '2026-11-08T08:00:00.000Z', skipped: true }],
      },
    };
    const out = expandOccurrences(
      [withExceptions],
      { from: new Date(c.range.from), to: new Date(c.range.to) },
      c.timeZone,
    );
    assert.equal(out.length, 3);
  });

  it('a moved slot with only a new start keeps the series length', () => {
    const c = parityCase('local-weekly-block');
    const [block] = c.rows;
    assert.ok(block);
    const row: TimeRow = {
      ...block,
      props: {
        ...block.props,
        exceptions: [
          { originalStart: '2026-11-08T11:00:00.000Z', startAt: '2026-11-08T12:00:00.000Z' },
        ],
      },
    };
    const out = expandOccurrences(
      [row],
      { from: new Date('2026-11-07T22:00:00.000Z'), to: new Date('2026-11-14T22:00:00.000Z') },
      c.timeZone,
    );
    assert.deepEqual(
      out.map((o) => [o.start.toISOString(), o.end?.toISOString()]),
      [['2026-11-08T12:00:00.000Z', '2026-11-08T16:00:00.000Z']],
    );
  });

  it('caps a series at MAX_OCCURRENCES_PER_SERIES', () => {
    assert.equal(MAX_OCCURRENCES_PER_SERIES, 400);
    const [block] = parityCase('local-weekly-block').rows;
    assert.ok(block);
    const hourly: TimeRow = { ...block, props: { recurrence: ['RRULE:FREQ=HOURLY'] } };
    const out = expandOccurrences(
      [hourly],
      { from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-12-31T00:00:00.000Z') },
      'Asia/Jerusalem',
    );
    assert.equal(out.length, MAX_OCCURRENCES_PER_SERIES);
  });
});

describe('localExceptionsOf', () => {
  it('reads well-formed exceptions and drops the rest', () => {
    assert.deepEqual(
      localExceptionsOf({
        exceptions: [
          { originalStart: '2026-11-08T11:00:00.000Z', skipped: true },
          {
            originalStart: '2026-11-15T11:00:00.000Z',
            startAt: '2026-11-15T12:00:00.000Z',
            endAt: '2026-11-15T15:00:00.000Z',
          },
          { originalStart: 'not a date', skipped: true },
          { startAt: '2026-11-15T12:00:00.000Z' },
          { originalStart: '2026-11-22T11:00:00.000Z', startAt: 42, skipped: 'yes' },
          'RRULE:FREQ=DAILY',
          null,
        ],
      }),
      [
        { originalStart: '2026-11-08T11:00:00.000Z', skipped: true },
        {
          originalStart: '2026-11-15T11:00:00.000Z',
          startAt: '2026-11-15T12:00:00.000Z',
          endAt: '2026-11-15T15:00:00.000Z',
        },
        { originalStart: '2026-11-22T11:00:00.000Z' },
      ],
    );
  });

  it('is empty when there are none', () => {
    assert.deepEqual(localExceptionsOf({}), []);
    assert.deepEqual(localExceptionsOf({ exceptions: 'none' }), []);
  });
});

describe('isSeriesRow', () => {
  it('is true when props.recurrence holds an RRULE line', () => {
    assert.equal(isSeriesRow({ props: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'] } }), true);
    assert.equal(
      isSeriesRow({ props: { recurrence: ['EXDATE:20261108T110000Z', 'rrule:FREQ=DAILY'] } }),
      true,
    );
  });

  it('is false otherwise', () => {
    assert.equal(isSeriesRow({ props: {} }), false);
    assert.equal(isSeriesRow({ props: { recurrence: [] } }), false);
    assert.equal(isSeriesRow({ props: { recurrence: ['EXDATE:20261108T110000Z'] } }), false);
    assert.equal(isSeriesRow({ props: { recurrence: 'RRULE:FREQ=DAILY' } }), false);
  });
});
