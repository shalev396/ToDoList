import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARITY_CASES, type ParityCase } from './cases.js';
import {
  MAX_OCCURRENCES_PER_SERIES,
  MAX_SLOTS_TO_END,
  expandOccurrences,
  isSeriesRow,
  localExceptionsOf,
  recurrenceEndOf,
  seriesHasSlot,
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
          ...(o.inactive === null ? {} : { inactive: o.inactive }),
        })),
        c.expected,
      );
    });
  }
});

describe('expandOccurrences: EXDATE on a Google master', () => {
  const ZONE = 'Asia/Jerusalem';
  // Sun 8 Nov – Sat 14 Nov 2026, Jerusalem (UTC+2).
  const WEEK = {
    from: new Date('2026-11-07T22:00:00.000Z'),
    to: new Date('2026-11-14T22:00:00.000Z'),
  };
  /** Every Sunday, Tuesday and Thursday at 10:00–11:00 local, from Sun 1 Nov 2026. */
  const master = (exdates: string[], fields: Partial<TimeRow> = {}): TimeRow => ({
    id: 'master',
    kind: 'event',
    title: 'Lecture',
    status: 'open',
    startAt: '2026-11-01T08:00:00.000Z',
    endAt: '2026-11-01T09:00:00.000Z',
    dueAt: null,
    allDay: false,
    source: {
      provider: 'google_calendar',
      key: null,
      url: 'https://calendar.google.com/x',
      externalId: 'master',
    },
    props: {
      calendarId: 'c',
      eventId: 'e1',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU,TU,TH', ...exdates],
    },
    ...fields,
  });
  const starts = (row: TimeRow, zone = ZONE): string[] =>
    expandOccurrences([row], WEEK, zone).map((o) => o.start.toISOString());

  it('without one, every slot of the week', () => {
    assert.deepEqual(starts(master([])), [
      '2026-11-08T08:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
      '2026-11-12T08:00:00.000Z',
    ]);
  });

  it('a TZID wall time, as Google writes it, takes its slot out', () => {
    assert.deepEqual(starts(master(['EXDATE;TZID=Asia/Jerusalem:20261110T100000'])), [
      '2026-11-08T08:00:00.000Z',
      '2026-11-12T08:00:00.000Z',
    ]);
  });

  it('a UTC value, and several values on one line', () => {
    assert.deepEqual(starts(master(['EXDATE:20261108T080000Z,20261112T080000Z'])), [
      '2026-11-10T08:00:00.000Z',
    ]);
  });

  it('a TZID other than the workspace zone is read in its own zone', () => {
    // 03:00 in New York on 10 Nov (UTC−5) is 08:00Z: the 10:00 Jerusalem slot.
    assert.deepEqual(starts(master(['EXDATE;TZID=America/New_York:20261110T030000'])), [
      '2026-11-08T08:00:00.000Z',
      '2026-11-12T08:00:00.000Z',
    ]);
  });

  it('a floating value is read in the workspace zone; a date takes that day out', () => {
    assert.deepEqual(starts(master(['EXDATE:20261112T100000'])), [
      '2026-11-08T08:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
    ]);
    assert.deepEqual(starts(master(['EXDATE;VALUE=DATE:20261108'])), [
      '2026-11-10T08:00:00.000Z',
      '2026-11-12T08:00:00.000Z',
    ]);
  });

  it('a value that names no slot, or can not be read, takes nothing out', () => {
    assert.deepEqual(
      starts(master(['EXDATE;TZID=Asia/Jerusalem:20261110T110000', 'EXDATE:garbage', 'EXDATE'])),
      ['2026-11-08T08:00:00.000Z', '2026-11-10T08:00:00.000Z', '2026-11-12T08:00:00.000Z'],
    );
  });

  it('holds across a DST change: the slot keeps its wall time', () => {
    // Sunday 25 Oct 2026, the clocks fall back that night: 10:00 local is 08:00Z after, 07:00Z before.
    const range = {
      from: new Date('2026-10-17T21:00:00.000Z'),
      to: new Date('2026-10-31T22:00:00.000Z'),
    };
    const row = master(['EXDATE;TZID=Asia/Jerusalem:20261020T100000,20261027T100000'], {
      startAt: '2026-10-18T07:00:00.000Z',
      endAt: '2026-10-18T08:00:00.000Z',
    });
    assert.deepEqual(
      expandOccurrences([row], range, ZONE).map((o) => o.start.toISOString()),
      [
        '2026-10-18T07:00:00.000Z',
        '2026-10-22T07:00:00.000Z',
        '2026-10-25T08:00:00.000Z',
        '2026-10-29T08:00:00.000Z',
      ],
    );
  });
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

  it('a series mirrored through two accounts has no single master: moved rows name none', () => {
    const out = expand(parityCase('google-series-mirrored-twice'));
    const moved = out.filter((o) => o.row.id.startsWith('moved'));
    assert.equal(moved.length, 2);
    for (const o of moved) {
      assert.equal(o.seriesRowId, null);
      assert.equal(o.originalStart?.toISOString(), '2026-11-12T08:00:00.000Z');
    }
    // Each master still names itself on its own occurrences.
    assert.deepEqual(
      out.filter((o) => o.row.id.startsWith('mirror')).map((o) => o.seriesRowId),
      ['mirrorA', 'mirrorB', 'mirrorA', 'mirrorB'],
    );
  });

  it('every parity case gives unique keys', () => {
    for (const c of PARITY_CASES) {
      const keys = expand(c).map((o) => o.key);
      assert.equal(new Set(keys).size, keys.length, c.name);
    }
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

describe('recurrenceEndOf', () => {
  const ZONE = 'Asia/Jerusalem';
  /** Sundays 13:00–15:00 in Jerusalem from 13 September (summer time, UTC+3). */
  function series(
    recurrence: unknown,
    props: Record<string, unknown> = {},
  ): Pick<TimeRow, 'startAt' | 'endAt' | 'props'> {
    return {
      startAt: '2026-09-13T10:00:00.000Z',
      endAt: '2026-09-13T12:00:00.000Z',
      props: { recurrence, ...props },
    };
  }

  it('a COUNT series ends with its last occurrence, on the wall clock across a DST change', () => {
    // 13 Sep … 1 Nov; the clocks went back on 25 Oct, so 1 Nov 13:00–15:00 is 11:00–13:00Z.
    assert.equal(
      recurrenceEndOf(series(['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=8']), ZONE),
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('an UNTIL series ends with its last occurrence on or before UNTIL', () => {
    assert.equal(
      recurrenceEndOf(
        series(['EXDATE:20260920T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261020T000000Z']),
        ZONE,
      ),
      '2026-10-18T12:00:00.000Z',
    );
  });

  it('a local occurrence moved past the last slot extends the end; a skipped one does not', () => {
    const rule = ['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=8'];
    assert.equal(
      recurrenceEndOf(
        series(rule, {
          exceptions: [
            {
              originalStart: '2026-11-01T11:00:00.000Z',
              startAt: '2026-11-03T16:00:00.000Z',
              endAt: '2026-11-03T18:00:00.000Z',
            },
          ],
        }),
        ZONE,
      ),
      '2026-11-03T18:00:00.000Z',
    );
    // A new start alone keeps the series' two hours.
    assert.equal(
      recurrenceEndOf(
        series(rule, {
          exceptions: [
            { originalStart: '2026-11-01T11:00:00.000Z', startAt: '2026-11-02T08:00:00.000Z' },
          ],
        }),
        ZONE,
      ),
      '2026-11-02T10:00:00.000Z',
    );
    assert.equal(
      recurrenceEndOf(
        series(rule, {
          exceptions: [
            {
              originalStart: '2026-11-01T11:00:00.000Z',
              startAt: '2026-12-01T08:00:00.000Z',
              skipped: true,
            },
          ],
        }),
        ZONE,
      ),
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('is null for a series that never ends, a rule it cannot read, or no series at all', () => {
    assert.equal(recurrenceEndOf(series(['RRULE:FREQ=WEEKLY;BYDAY=SU']), ZONE), null);
    assert.equal(recurrenceEndOf(series(['RRULE:FREQ=SOMETIMES;COUNT=3']), ZONE), null);
    assert.equal(recurrenceEndOf(series(null), ZONE), null);
    assert.equal(recurrenceEndOf(series(['EXDATE:20260920T100000Z']), ZONE), null);
    assert.equal(
      recurrenceEndOf({ ...series(['RRULE:FREQ=DAILY;COUNT=3']), startAt: null }, ZONE),
      null,
    );
  });

  it(`works out at most MAX_SLOTS_TO_END slots; a longer series reads as never ending`, () => {
    assert.equal(MAX_SLOTS_TO_END, 5000);
    const hourly = (count: number): string | null =>
      recurrenceEndOf(series([`RRULE:FREQ=HOURLY;COUNT=${String(count)}`]), ZONE);
    // The 5000th hourly slot starts 4999 hours after the first; it lasts two hours.
    assert.equal(
      hourly(MAX_SLOTS_TO_END),
      new Date(Date.parse('2026-09-13T12:00:00.000Z') + 4999 * 3_600_000).toISOString(),
    );
    assert.equal(hourly(MAX_SLOTS_TO_END + 1), null);
  });
});

describe('seriesHasSlot', () => {
  const ZONE = 'Asia/Jerusalem';
  /** Sundays 13:00 in Jerusalem from 13 September (summer time, UTC+3). */
  const weekly = (recurrence: unknown): Pick<TimeRow, 'startAt' | 'props'> => ({
    startAt: '2026-09-13T10:00:00.000Z',
    props: { recurrence },
  });

  it('is true for an original start of the series, on the wall clock across a DST change', () => {
    const rule = ['RRULE:FREQ=WEEKLY;BYDAY=SU'];
    assert.equal(seriesHasSlot(weekly(rule), new Date('2026-09-13T10:00:00.000Z'), ZONE), true);
    // After the clocks went back on 25 October, 13:00 is 11:00Z.
    assert.equal(seriesHasSlot(weekly(rule), new Date('2026-11-01T11:00:00.000Z'), ZONE), true);
    assert.equal(seriesHasSlot(weekly(rule), new Date('2027-03-07T11:00:00.000Z'), ZONE), true);
  });

  it('is false for another time or day, before the first, after the last, or no series', () => {
    const rule = ['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=3'];
    for (const instant of [
      '2026-11-01T10:00:00.000Z',
      '2026-09-14T10:00:00.000Z',
      '2026-09-06T10:00:00.000Z',
      '2026-10-04T10:00:00.000Z',
    ]) {
      assert.equal(seriesHasSlot(weekly(rule), new Date(instant), ZONE), false, instant);
    }
    assert.equal(seriesHasSlot(weekly(rule), new Date('2026-09-27T10:00:00.000Z'), ZONE), true);
    assert.equal(seriesHasSlot(weekly(null), new Date('2026-09-13T10:00:00.000Z'), ZONE), false);
    assert.equal(
      seriesHasSlot({ ...weekly(rule), startAt: null }, new Date('2026-09-13T10:00:00.000Z'), ZONE),
      false,
    );
    assert.equal(seriesHasSlot(weekly(rule), new Date(NaN), ZONE), false);
  });
});
