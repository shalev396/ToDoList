import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  angleForTime,
  arcPath,
  assignLanes,
  clipToDay,
  dayArcAngles,
  endOfZonedDay,
  polar,
  startOfZonedDay,
  timeZoneOffsetMinutes,
  zonedTime,
} from './ClockRing.math.ts';

const UTC = 'UTC';
const JERUSALEM = 'Asia/Jerusalem';

function near(actual: number, expected: number, tolerance: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ??
      `expected ${String(actual)} to be within ${String(tolerance)} of ${String(expected)}`,
  );
}

describe('angleForTime', () => {
  it('puts 06:00, 12:00 and 18:00 at 90°, 180° and 270°', () => {
    near(angleForTime(new Date('2026-11-11T06:00:00Z'), UTC), 90, 1);
    near(angleForTime(new Date('2026-11-11T12:00:00Z'), UTC), 180, 1);
    near(angleForTime(new Date('2026-11-11T18:00:00Z'), UTC), 270, 1);
  });

  it('puts midnight at 0° and stays below 360°', () => {
    near(angleForTime(new Date('2026-11-11T00:00:00Z'), UTC), 0, 1e-9);
    const lastSecond = angleForTime(new Date('2026-11-11T23:59:59.999Z'), UTC);
    assert.ok(lastSecond < 360 && lastSecond > 359.9);
  });

  it('moves a quarter of a degree per minute', () => {
    const a = angleForTime(new Date('2026-11-11T14:00:00Z'), UTC);
    const b = angleForTime(new Date('2026-11-11T14:01:00Z'), UTC);
    near(b - a, 0.25, 1e-9);
  });

  it('reads the wall clock of the given time zone, not UTC', () => {
    const instant = new Date('2026-11-11T10:00:00Z');
    // Israel is UTC+2 in November: 10:00 UTC is 12:00 in Jerusalem.
    near(angleForTime(instant, UTC), 150, 1);
    near(angleForTime(instant, JERUSALEM), 180, 1);
    // And UTC+3 in summer: 09:00 UTC is 12:00 in Jerusalem.
    near(angleForTime(new Date('2026-07-01T09:00:00Z'), JERUSALEM), 180, 1);
  });
});

describe('time zones', () => {
  it('knows the Jerusalem offset in winter and summer', () => {
    assert.equal(timeZoneOffsetMinutes(new Date('2026-11-11T12:00:00Z'), JERUSALEM), 120);
    assert.equal(timeZoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), JERUSALEM), 180);
    assert.equal(timeZoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), UTC), 0);
  });

  it('finds the local midnight that starts the day', () => {
    // 01:00 on 12 Nov in Jerusalem is 23:00 UTC on 11 Nov.
    const instant = new Date('2026-11-11T23:00:00Z');
    assert.equal(startOfZonedDay(instant, JERUSALEM).toISOString(), '2026-11-11T22:00:00.000Z');
    assert.equal(endOfZonedDay(instant, JERUSALEM).toISOString(), '2026-11-12T22:00:00.000Z');
    assert.equal(startOfZonedDay(instant, UTC).toISOString(), '2026-11-11T00:00:00.000Z');
  });

  it('builds a wall-clock time in a zone', () => {
    assert.equal(
      zonedTime(2026, 11, 13, 14, 30, JERUSALEM).toISOString(),
      '2026-11-13T12:30:00.000Z',
    );
  });

  it('handles the short day when Israel springs forward (27 Mar 2026, 02:00 to 03:00)', () => {
    const noon = zonedTime(2026, 3, 27, 12, 0, JERUSALEM);
    const start = startOfZonedDay(noon, JERUSALEM);
    const end = endOfZonedDay(noon, JERUSALEM);
    assert.equal((end.getTime() - start.getTime()) / 3_600_000, 23);
    // The skipped 02:30 moves forward by the jump.
    assert.equal(
      zonedTime(2026, 3, 27, 2, 30, JERUSALEM).toISOString(),
      '2026-03-27T00:30:00.000Z',
    );
    // The dial reads the wall clock: 03:30 sits at 52.5°.
    near(angleForTime(zonedTime(2026, 3, 27, 3, 30, JERUSALEM), JERUSALEM), 52.5, 1e-9);
  });

  it('handles the long day when Israel falls back (25 Oct 2026, 02:00 to 01:00)', () => {
    const noon = zonedTime(2026, 10, 25, 12, 0, JERUSALEM);
    const start = startOfZonedDay(noon, JERUSALEM);
    const end = endOfZonedDay(noon, JERUSALEM);
    assert.equal((end.getTime() - start.getTime()) / 3_600_000, 25);
  });
});

// Temporal's disambiguation "compatible": a wall time that happens twice resolves to the first
// one; a wall time the clocks skip moves forward by the length of the jump.
describe('zonedTime across DST changes', () => {
  const NEW_YORK = 'America/New_York';

  it('resolves the repeated hour to its first occurrence east of UTC (Jerusalem, 25 Oct 2026)', () => {
    // 01:30 happens at UTC+3 (22:30Z) and again at UTC+2 (23:30Z): the first one wins.
    assert.equal(
      zonedTime(2026, 10, 25, 1, 30, JERUSALEM).toISOString(),
      '2026-10-24T22:30:00.000Z',
    );
    // Either side of the repeated hour is unambiguous.
    assert.equal(
      zonedTime(2026, 10, 25, 0, 30, JERUSALEM).toISOString(),
      '2026-10-24T21:30:00.000Z',
    );
    assert.equal(
      zonedTime(2026, 10, 25, 2, 30, JERUSALEM).toISOString(),
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('moves a skipped time forward by the jump (Jerusalem, 27 Mar 2026, 02:00 to 03:00)', () => {
    // 02:30 never happens; 03:30 at UTC+3 is 00:30Z.
    assert.equal(
      zonedTime(2026, 3, 27, 2, 30, JERUSALEM).toISOString(),
      '2026-03-27T00:30:00.000Z',
    );
    assert.equal(
      zonedTime(2026, 3, 27, 1, 59, JERUSALEM).toISOString(),
      '2026-03-26T23:59:00.000Z',
    );
  });

  it('still resolves both cases west of UTC (New York, 2026)', () => {
    // Falls back on 1 Nov: 01:30 happens at UTC-4 (05:30Z), then at UTC-5 (06:30Z).
    assert.equal(zonedTime(2026, 11, 1, 1, 30, NEW_YORK).toISOString(), '2026-11-01T05:30:00.000Z');
    // Springs forward on 8 Mar: 02:30 is skipped and becomes 03:30 EDT (07:30Z).
    assert.equal(zonedTime(2026, 3, 8, 2, 30, NEW_YORK).toISOString(), '2026-03-08T07:30:00.000Z');
    assert.equal(
      zonedTime(2026, 11, 13, 14, 30, NEW_YORK).toISOString(),
      '2026-11-13T19:30:00.000Z',
    );
  });

  it('starts a day at its first instant when midnight itself is skipped (Beirut, 31 Mar 2024)', () => {
    // Lebanon jumps from 00:00 to 01:00, so the day starts at 01:00 EEST (22:00Z).
    const noon = new Date('2024-03-31T09:00:00Z');
    const start = startOfZonedDay(noon, 'Asia/Beirut');
    assert.equal(start.toISOString(), '2024-03-30T22:00:00.000Z');
    const end = endOfZonedDay(noon, 'Asia/Beirut');
    assert.equal((end.getTime() - start.getTime()) / 3_600_000, 23);
  });
});

describe('clipToDay', () => {
  const day = new Date('2026-11-11T12:00:00Z');

  it('keeps an event that sits inside the day', () => {
    const range = {
      start: new Date('2026-11-11T09:00:00Z'),
      end: new Date('2026-11-11T10:30:00Z'),
    };
    assert.deepEqual(clipToDay(range, day, UTC), range);
  });

  it('cuts an event that crosses midnight at the end of the day', () => {
    const range = {
      start: new Date('2026-11-11T22:00:00Z'),
      end: new Date('2026-11-12T02:00:00Z'),
    };
    const clipped = clipToDay(range, day, UTC);
    assert.ok(clipped);
    assert.equal(clipped.start.toISOString(), '2026-11-11T22:00:00.000Z');
    assert.equal(clipped.end.toISOString(), '2026-11-12T00:00:00.000Z');
    const angles = dayArcAngles(range, day, UTC);
    assert.ok(angles);
    near(angles.startAngle, 330, 1e-9);
    assert.equal(angles.endAngle, 360);
  });

  it('cuts an event that started the night before at the start of the day', () => {
    const range = {
      start: new Date('2026-11-10T23:00:00Z'),
      end: new Date('2026-11-11T01:30:00Z'),
    };
    const clipped = clipToDay(range, day, UTC);
    assert.ok(clipped);
    assert.equal(clipped.start.toISOString(), '2026-11-11T00:00:00.000Z');
    assert.equal(clipped.end.toISOString(), '2026-11-11T01:30:00.000Z');
    const angles = dayArcAngles(range, day, UTC);
    assert.ok(angles);
    assert.equal(angles.startAngle, 0);
    near(angles.endAngle, 22.5, 1e-9);
  });

  it('clips to the local day of the time zone', () => {
    // 21:00 to 23:30 UTC is 23:00 to 01:30 in Jerusalem: only the first hour is on 11 Nov there.
    const range = {
      start: new Date('2026-11-11T21:00:00Z'),
      end: new Date('2026-11-11T23:30:00Z'),
    };
    const clipped = clipToDay(range, day, JERUSALEM);
    assert.ok(clipped);
    assert.equal(clipped.end.toISOString(), '2026-11-11T22:00:00.000Z');
    const angles = dayArcAngles(range, day, JERUSALEM);
    assert.ok(angles);
    near(angles.startAngle, 345, 1e-9);
    assert.equal(angles.endAngle, 360);
  });

  it('returns null for an event on another day or with no length', () => {
    const tomorrow = {
      start: new Date('2026-11-12T09:00:00Z'),
      end: new Date('2026-11-12T10:00:00Z'),
    };
    assert.equal(clipToDay(tomorrow, day, UTC), null);
    assert.equal(dayArcAngles(tomorrow, day, UTC), null);
    const empty = {
      start: new Date('2026-11-11T09:00:00Z'),
      end: new Date('2026-11-11T09:00:00Z'),
    };
    assert.equal(clipToDay(empty, day, UTC), null);
  });

  it('draws an event that covers the whole day as the full ring', () => {
    const range = {
      start: new Date('2026-11-10T20:00:00Z'),
      end: new Date('2026-11-12T04:00:00Z'),
    };
    assert.deepEqual(dayArcAngles(range, day, UTC), { startAngle: 0, endAngle: 360 });
  });
});

describe('arcPath', () => {
  it('places 0° at 12 o’clock and goes clockwise', () => {
    const top = polar(10, 0);
    const right = polar(10, 90);
    near(top.x, 0, 1e-9);
    near(top.y, -10, 1e-9);
    near(right.x, 10, 1e-9);
    near(right.y, 0, 1e-9);
  });

  it('draws a closed ring segment from the outer edge round to the inner edge', () => {
    const d = arcPath({ innerRadius: 80, outerRadius: 100, startAngle: 0, endAngle: 90 });
    assert.equal(d, 'M 0 -100 A 100 100 0 0 1 100 0 L 80 0 A 80 80 0 0 0 0 -80 Z');
  });

  it('sets the large-arc flag past half a turn', () => {
    const d = arcPath({ innerRadius: 80, outerRadius: 100, startAngle: 0, endAngle: 270 });
    assert.match(d, /^M 0 -100 A 100 100 0 1 1 /);
  });

  it('trims half the gap off each end, along each edge', () => {
    const d = arcPath({ innerRadius: 80, outerRadius: 100, startAngle: 0, endAngle: 90, gap: 2 });
    const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    // The outer edge starts 1 unit (along the arc) clockwise of 12 o'clock.
    const [x0 = 0, y0 = 0] = numbers;
    near(x0, 1, 0.01);
    near(y0, -100, 0.01);
    // The path closes on the inner edge's start, also 1 unit clockwise of 12 o'clock.
    const innerStartX = numbers.at(-2) ?? 0;
    near(innerStartX, 1, 0.01);
  });

  it('keeps a sliver for a very short event instead of dropping it', () => {
    const d = arcPath({
      innerRadius: 80,
      outerRadius: 100,
      startAngle: 100,
      endAngle: 100.5,
      gap: 2,
      minLength: 1.5,
    });
    assert.notEqual(d, '');
    assert.ok(!d.includes('NaN'));
  });

  it('returns nothing for an empty arc', () => {
    assert.equal(arcPath({ innerRadius: 80, outerRadius: 100, startAngle: 30, endAngle: 30 }), '');
    assert.equal(arcPath({ innerRadius: 80, outerRadius: 100, startAngle: 40, endAngle: 30 }), '');
  });

  it('draws a whole day as a full ring with a hole', () => {
    const d = arcPath({ innerRadius: 80, outerRadius: 100, startAngle: 0, endAngle: 360 });
    assert.equal(d.match(/M /g)?.length, 2);
    assert.ok(d.includes('A 100 100 0 1 1') && d.includes('A 80 80 0 1 0'));
  });
});

describe('assignLanes', () => {
  const at = (start: string, end: string) => ({
    start: new Date(`2026-11-11T${start}:00Z`),
    end: new Date(`2026-11-11T${end}:00Z`),
  });

  it('keeps events that only touch in the same lane', () => {
    assert.deepEqual(assignLanes([at('09:00', '10:00'), at('10:00', '11:00')]), [0, 0]);
  });

  it('moves an overlapping event to the next lane in', () => {
    assert.deepEqual(
      assignLanes([at('09:00', '12:00'), at('10:00', '10:30'), at('13:00', '14:00')]),
      [0, 1, 0],
    );
  });

  it('never uses more lanes than allowed', () => {
    const lanes = assignLanes(
      [at('09:00', '12:00'), at('09:00', '12:00'), at('09:00', '12:00'), at('09:00', '12:00')],
      3,
    );
    assert.ok(lanes.every((lane) => lane >= 0 && lane < 3));
  });
});
