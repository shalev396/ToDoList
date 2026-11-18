import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleForTime, dayArcAngles, zonedParts, zonedTime } from './ClockRing.math.ts';
import { buildClockModel } from './clockModel.ts';
import type { TimeRow } from '../time/occurrences.ts';
import type { ItemColour } from '@api-types/colours.ts';

const TZ = 'Asia/Jerusalem';
const at = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  zonedTime(y, m, d, h, min, TZ);

function row(id: string, over: Partial<TimeRow>): TimeRow {
  return {
    id,
    kind: 'event',
    title: id,
    status: 'open',
    startAt: null,
    endAt: null,
    dueAt: null,
    allDay: false,
    source: { provider: 'google_calendar', url: 'https://x', externalId: id, key: null },
    props: {},
    ...over,
  };
}

function defined<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

describe('buildClockModel', () => {
  const now = at(2026, 11, 12, 12, 30);

  it('draws today’s timed events and lists all-day ones apart', () => {
    const model = buildClockModel(
      [
        row('lecture', { startAt: at(2026, 11, 12, 10), endAt: at(2026, 11, 12, 11, 30) }),
        row('holiday', { allDay: true, startAt: at(2026, 11, 12), endAt: at(2026, 11, 13) }),
        row('tomorrow', { startAt: at(2026, 11, 13, 10), endAt: at(2026, 11, 13, 11) }),
      ],
      now,
      TZ,
    );
    assert.deepEqual(
      model.timed.map((e) => e.id),
      ['lecture'],
    );
    assert.deepEqual(
      model.allDay.map((o) => o.row.id),
      ['holiday'],
    );
  });

  it('never draws a cancelled occurrence of a series', () => {
    const master = row('m', {
      startAt: at(2026, 11, 5, 9),
      endAt: at(2026, 11, 5, 10),
      props: { calendarId: 'c', eventId: 'e', recurrence: ['RRULE:FREQ=WEEKLY'] },
    });
    const cancelled = row('x', {
      status: 'cancelled',
      startAt: at(2026, 11, 12, 9),
      props: {
        calendarId: 'c',
        recurringEventId: 'e',
        originalStartAt: at(2026, 11, 12, 9).toISOString(),
      },
    });
    assert.equal(buildClockModel([master], now, TZ).timed.length, 1);
    assert.equal(buildClockModel([master, cancelled], now, TZ).timed.length, 0);
  });

  it('finds now and next', () => {
    const model = buildClockModel(
      [
        row('a', { startAt: at(2026, 11, 12, 12), endAt: at(2026, 11, 12, 13) }),
        row('b', { startAt: at(2026, 11, 12, 15), endAt: at(2026, 11, 12, 16) }),
        row('c', { startAt: at(2026, 11, 12, 17), endAt: at(2026, 11, 12, 18) }),
      ],
      now,
      TZ,
    );
    assert.equal(model.current?.row.id, 'a');
    assert.equal(model.next?.row.id, 'b');
  });

  it('keeps an event that crosses midnight and the ring clips it to 360°', () => {
    const model = buildClockModel(
      [row('late', { startAt: at(2026, 11, 12, 23), endAt: at(2026, 11, 13, 1) })],
      now,
      TZ,
    );
    assert.equal(model.timed.length, 1);
    const e = defined(model.timed[0]);
    const angles = defined(dayArcAngles(e, now, TZ));
    assert.equal(angles.endAngle, 360);
    assert.ok(Math.abs(angles.startAngle - (23 / 24) * 360) < 0.01);
    // The part after midnight shows on the next day's ring, from 0°.
    const next = defined(dayArcAngles(e, at(2026, 11, 13, 12), TZ));
    assert.equal(next.startAngle, 0);
    assert.ok(Math.abs(next.endAngle - 15) < 0.01);
  });

  it('gives an event without an end half an hour', () => {
    const model = buildClockModel([row('p', { startAt: at(2026, 11, 12, 14) })], now, TZ);
    assert.equal(
      defined(model.timed[0]).end.getTime() - defined(model.timed[0]).start.getTime(),
      30 * 60_000,
    );
  });

  it('is right on the 23-hour spring DST day: wall-clock angles, no shift', () => {
    const springNow = at(2026, 3, 27, 12, 0);
    const model = buildClockModel(
      [row('d', { startAt: at(2026, 3, 27, 9), endAt: at(2026, 3, 27, 10) })],
      springNow,
      TZ,
    );
    assert.equal(model.timed.length, 1);
    const a = defined(dayArcAngles(defined(model.timed[0]), springNow, TZ));
    assert.ok(Math.abs(a.startAngle - 135) < 0.01);
    assert.ok(Math.abs(a.endAngle - 150) < 0.01);
  });

  it('turns area rows into areas, never arcs, Now or Next', () => {
    const studying: ItemColour = {
      family: 'teal',
      role: 'area',
      from: 'topic',
      subject: null,
      topicId: 'college',
    };
    const colourOf = (rowId: string): ItemColour =>
      rowId === 'studying' ? studying : { ...studying, role: 'scheduled' };
    const model = buildClockModel(
      [
        row('studying', {
          kind: 'block',
          startAt: at(2026, 11, 12, 12),
          endAt: at(2026, 11, 12, 17),
        }),
        row('lecture', { startAt: at(2026, 11, 12, 14), endAt: at(2026, 11, 12, 15) }),
      ],
      now,
      TZ,
      colourOf,
    );
    assert.deepEqual(
      model.timed.map((e) => e.id),
      ['lecture'],
    );
    assert.equal(model.current, null);
    assert.equal(model.next?.row.id, 'lecture');
    assert.equal(model.areas.length, 1);
    const area = defined(model.areas[0]);
    assert.equal(area.title, 'studying');
    assert.equal(area.start.getTime(), at(2026, 11, 12, 12).getTime());
    assert.equal(area.end.getTime(), at(2026, 11, 12, 17).getTime());
    assert.deepEqual(area.colour, studying);
  });

  it('gives each arc its row colour', () => {
    const colours: Record<string, ItemColour> = {
      lecture: {
        family: 'violet',
        role: 'scheduled',
        from: 'subject',
        subject: 'Calculus',
        topicId: 'c',
      },
      bus: { family: 'teal', role: 'travel', from: 'topic', subject: null, topicId: 'c' },
    };
    const model = buildClockModel(
      [
        row('lecture', { startAt: at(2026, 11, 12, 13), endAt: at(2026, 11, 12, 14) }),
        row('bus', { kind: 'travel', startAt: at(2026, 11, 12, 12), endAt: at(2026, 11, 12, 13) }),
      ],
      now,
      TZ,
      (rowId) => defined(colours[rowId]),
    );
    assert.deepEqual(
      model.timed.map((e) => [e.id, e.colour]),
      [
        ['bus', colours['bus']],
        ['lecture', colours['lecture']],
      ],
    );
  });

  it('without colours, draws every row as an arc in its source colour', () => {
    const model = buildClockModel(
      [
        row('studying', {
          kind: 'block',
          startAt: at(2026, 11, 12, 12),
          endAt: at(2026, 11, 12, 17),
        }),
      ],
      now,
      TZ,
    );
    assert.deepEqual(model.areas, []);
    assert.equal(model.timed.length, 1);
    assert.equal('colour' in defined(model.timed[0]), false);
    assert.equal(defined(model.timed[0]).source, 'google_calendar');
  });

  it('is right on the 25-hour fall DST day', () => {
    const fallNow = at(2026, 10, 25, 12, 0);
    const model = buildClockModel(
      [row('d', { startAt: at(2026, 10, 25, 23), endAt: at(2026, 10, 26, 0, 30) })],
      fallNow,
      TZ,
    );
    assert.equal(defined(dayArcAngles(defined(model.timed[0]), fallNow, TZ)).endAngle, 360);
  });
});

describe('needle angle', () => {
  it('is within 1° of minutes ÷ 1440 × 360, every 7 minutes of a day, DST days included', () => {
    for (const [y, m, d] of [
      [2026, 11, 12],
      [2026, 3, 27],
      [2026, 10, 25],
    ] as const) {
      for (let minute = 0; minute < 24 * 60; minute += 7) {
        const instant = at(y, m, d, 0, 0).getTime() + minute * 60_000;
        const p = zonedParts(new Date(instant), TZ);
        const wallMinutes = p.hour * 60 + p.minute;
        const diff = Math.abs(angleForTime(new Date(instant), TZ) - (wallMinutes / 1440) * 360);
        assert.ok(
          diff <= 1,
          `${String(y)}-${String(m)}-${String(d)} +${String(minute)}: ${String(diff)}`,
        );
      }
    }
  });
});
