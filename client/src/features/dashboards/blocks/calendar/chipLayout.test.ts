import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EVENT_MIN_PX,
  PX_PER_MINUTE,
  READABLE_MINUTES,
  STACKED_MIN_PX,
  TIME_GRID_LAYOUT,
  chipLayout,
  chipMinutes,
  drawnOverlap,
  drawnSpan,
  TAP_PX,
  stretchedEvents,
  tapReach,
} from './chipLayout.ts';

/** `HH:MM` as minutes of the day. */
const at = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
};
const span = (start: string, end: string) => drawnSpan(at(start), at(end));

describe('the week grid: touching and overlapping events', () => {
  it('a 15-minute meeting that ends when the lecture starts only touches it', () => {
    // Monday in the owner's screenshot: AutoDS 10:15-10:30, then the lecture from 10:30.
    const meeting = span('10:15', '10:30');
    const lecture = span('10:30', '12:00');
    assert.equal(drawnOverlap(meeting, lecture), false);
    assert.equal(drawnOverlap(lecture, meeting), false);
  });

  it('a lecture that ends when the next starts only touches it', () => {
    assert.equal(drawnOverlap(span('08:30', '10:00'), span('10:00', '11:30')), false);
  });

  it('a 15-minute meeting inside a lecture overlaps it (they sit side by side)', () => {
    // Thursday: AutoDS 11:00-11:15 during the 10:30-12:00 lecture.
    assert.equal(drawnOverlap(span('11:00', '11:15'), span('10:30', '12:00')), true);
  });

  it('two events at the same times overlap', () => {
    assert.equal(drawnOverlap(span('10:30', '12:00'), span('10:30', '12:00')), true);
  });

  it('a 10-minute walk that ends when the lecture starts only touches it', () => {
    assert.equal(drawnOverlap(span('08:20', '08:30'), span('08:30', '10:00')), false);
  });

  it('a 5-minute event that ends when the next starts only touches it', () => {
    assert.equal(drawnOverlap(span('09:55', '10:00'), span('10:00', '11:00')), false);
  });

  it('a 5-minute event inside a lecture still overlaps it', () => {
    assert.equal(drawnOverlap(span('10:20', '10:25'), span('10:00', '11:00')), true);
  });

  it('every event is drawn (for the overlap math) at its true height, however short', () => {
    assert.equal(EVENT_MIN_PX, 0);
    for (const [start, end] of [
      ['10:15', '10:30'],
      ['08:20', '08:30'],
      ['09:00', '09:05'],
    ] as const) {
      assert.deepEqual(span(start, end), {
        top: at(start) * PX_PER_MINUTE,
        bottom: at(end) * PX_PER_MINUTE,
      });
    }
  });

  it('overlapping events go side by side, not over one another', () => {
    assert.equal(TIME_GRID_LAYOUT.slotEventOverlap, false);
    assert.equal(TIME_GRID_LAYOUT.eventMinHeight, EVENT_MIN_PX);
  });
});

describe('chipMinutes', () => {
  const wall = (iso: string) => new Date(`${iso}Z`);

  it('is the event’s length on one day', () => {
    assert.equal(
      chipMinutes(wall('2026-11-19T10:30:00'), wall('2026-11-19T12:00:00'), true, true),
      90,
    );
  });

  it('is half an hour for an event without an end', () => {
    assert.equal(chipMinutes(wall('2026-11-19T10:30:00'), null, true, true), 30);
  });

  it('is each day’s part of an event past midnight', () => {
    const start = wall('2026-11-19T23:00:00');
    const end = wall('2026-11-20T01:30:00');
    assert.equal(chipMinutes(start, end, true, false), 60);
    assert.equal(chipMinutes(start, end, false, true), 90);
    assert.equal(chipMinutes(start, wall('2026-11-22T01:00:00'), false, false), 24 * 60);
  });
});

describe('chipLayout', () => {
  it('a quarter hour: the icon and the title on one line', () => {
    assert.deepEqual(chipLayout(15), { kind: 'inline', titleLines: 1 });
  });

  it('half an hour: the icon line, then one line of title', () => {
    assert.deepEqual(chipLayout(30), { kind: 'stacked', titleLines: 1 });
  });

  it('a lecture: the title takes every whole line below the icon', () => {
    assert.deepEqual(chipLayout(90), { kind: 'stacked', titleLines: 5 });
    assert.deepEqual(chipLayout(60), { kind: 'stacked', titleLines: 3 });
  });

  it('a shorter event keeps its true height and shows its icon only (no title line)', () => {
    assert.deepEqual(chipLayout(10), { kind: 'tiny', titleLines: 0, linePx: 9 });
    assert.deepEqual(chipLayout(5), { kind: 'tiny', titleLines: 0, linePx: 4 });
  });

  it('a shorter event stretched over free time is a full line', () => {
    assert.deepEqual(chipLayout(5, true), { kind: 'inline', titleLines: 1 });
    assert.deepEqual(chipLayout(10, true), { kind: 'inline', titleLines: 1 });
  });

  it("agrees with FullCalendar's short events", () => {
    assert.equal(TIME_GRID_LAYOUT.eventShortHeight, STACKED_MIN_PX);
    for (let minutes = 5; minutes <= 120; minutes += 5) {
      const short = minutes * PX_PER_MINUTE < TIME_GRID_LAYOUT.eventShortHeight;
      assert.equal(chipLayout(minutes).kind !== 'stacked', short, `${String(minutes)} minutes`);
    }
  });
});

describe('stretchedEvents', () => {
  const day = Date.UTC(2026, 10, 19);
  const event = (key: string, start: string, end: string) => ({
    key,
    start: day + at(start) * 60_000,
    end: day + at(end) * 60_000,
  });

  it('a quarter hour is a line already: never stretched', () => {
    assert.equal(READABLE_MINUTES, 15);
    assert.deepEqual([...stretchedEvents([event('meeting', '10:15', '10:30')])], []);
  });

  it('a short event with free time after it is stretched', () => {
    const walk = event('walk', '08:20', '08:30');
    const lecture = event('lecture', '08:45', '10:00');
    assert.deepEqual([...stretchedEvents([walk, lecture])], ['walk']);
  });

  it('a 10-minute walk that ends when the lecture starts keeps its true height', () => {
    const walk = event('walk', '08:20', '08:30');
    const lecture = event('lecture', '08:30', '10:00');
    assert.deepEqual([...stretchedEvents([walk, lecture])], []);
  });

  it('a 5-minute event with another starting within its line keeps its true height', () => {
    const short = event('short', '09:55', '10:00');
    const next = event('next', '10:05', '11:00');
    assert.deepEqual([...stretchedEvents([short, next])], []);
  });

  it('an event that overlaps it (another lane) does not stop the stretch', () => {
    const short = event('short', '10:20', '10:25');
    const lecture = event('lecture', '10:00', '11:00');
    assert.deepEqual([...stretchedEvents([short, lecture])], ['short']);
  });
});

describe('tapReach', () => {
  const day = Date.UTC(2026, 10, 19);
  const event = (key: string, start: string, end: string) => ({
    key,
    start: day + at(start) * 60_000,
    end: day + at(end) * 60_000,
  });
  const reachOf = (events: ReturnType<typeof event>[]) => tapReach(events, stretchedEvents(events));

  it('a 10-minute walk that ends when the lecture starts reaches up, never into the lecture', () => {
    const reach = reachOf([event('walk', '08:20', '08:30'), event('lecture', '08:30', '10:00')]);
    assert.deepEqual(reach.get('walk'), { above: TAP_PX - 10 * PX_PER_MINUTE, below: 0 });
    assert.equal(reach.has('lecture'), false);
  });

  it('reaches only as far as the free time on either side', () => {
    const reach = reachOf([
      event('before', '09:00', '09:52'),
      event('short', '09:55', '10:00'),
      event('after', '10:00', '11:00'),
    ]);
    assert.deepEqual(reach.get('short'), { above: 3 * PX_PER_MINUTE, below: 0 });
  });

  it('reaches into the time after it first, when that is free', () => {
    const reach = reachOf([
      event('short', '09:55', '10:00'),
      event('after', '10:05', '11:00'),
      event('before', '08:00', '09:00'),
    ]);
    assert.deepEqual(reach.get('short'), {
      below: 5 * PX_PER_MINUTE,
      above: TAP_PX - 5 * PX_PER_MINUTE - 5 * PX_PER_MINUTE,
    });
  });

  it('a stretched event, and one of a quarter hour, need none', () => {
    const reach = reachOf([event('alone', '09:00', '09:05'), event('meeting', '11:00', '11:15')]);
    assert.equal(reach.size, 0);
  });
});
