import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EVENT_MIN_PX,
  PX_PER_MINUTE,
  STACKED_MIN_PX,
  TIME_GRID_LAYOUT,
  chipLayout,
  chipMinutes,
  drawnOverlap,
  drawnSpan,
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

  it('a quarter hour is drawn at its true height, never stretched into the next', () => {
    assert.ok(EVENT_MIN_PX < 15 * PX_PER_MINUTE);
    assert.deepEqual(span('10:15', '10:30'), {
      top: at('10:15') * PX_PER_MINUTE,
      bottom: at('10:30') * PX_PER_MINUTE,
    });
  });

  it('a shorter event is drawn at the minimum height', () => {
    const fiveMinutes = span('09:00', '09:05');
    assert.equal(fiveMinutes.bottom - fiveMinutes.top, EVENT_MIN_PX);
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

  it('a very short event is still one line', () => {
    assert.deepEqual(chipLayout(5), { kind: 'inline', titleLines: 1 });
  });

  it("agrees with FullCalendar's short events", () => {
    assert.equal(TIME_GRID_LAYOUT.eventShortHeight, STACKED_MIN_PX);
    for (let minutes = 5; minutes <= 120; minutes += 5) {
      const short = minutes * PX_PER_MINUTE < TIME_GRID_LAYOUT.eventShortHeight;
      assert.equal(chipLayout(minutes).kind === 'inline', short, `${String(minutes)} minutes`);
    }
  });
});
