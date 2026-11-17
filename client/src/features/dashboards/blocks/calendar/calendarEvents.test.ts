import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zonedTime } from '../clock/ClockRing.math.ts';
import { toEventInput } from './calendarEvents.ts';
import type { Occurrence, TimeRow } from '../time/occurrences.ts';

const TZ = 'Asia/Jerusalem';
const at = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  zonedTime(y, m, d, h, min, TZ);
const row = (id: string): TimeRow => ({
  id,
  kind: 'event',
  title: id,
  status: 'open',
  startAt: null,
  endAt: null,
  dueAt: null,
  allDay: false,
  source: { provider: 'moodle', url: 'https://m', externalId: id, key: null },
  props: {},
});
const occ = (over: Partial<Occurrence>): Occurrence => ({
  key: 'k',
  row: row('r'),
  start: at(2026, 11, 12, 10),
  end: at(2026, 11, 12, 11),
  allDay: false,
  dueOnly: false,
  ...over,
});

describe('toEventInput', () => {
  it('writes the workspace’s wall clock, not the browser’s', () => {
    const input = toEventInput({ occurrence: occ({}), badges: [] }, TZ);
    assert.equal(input.start, '2026-11-12T10:00:00');
    assert.equal(input.end, '2026-11-12T11:00:00');
    assert.ok(input.classNames?.toString().includes('fc-src-moodle'));
  });

  it('gives an all-day event whole dates with an exclusive end', () => {
    const input = toEventInput(
      {
        occurrence: occ({ allDay: true, start: at(2026, 11, 12), end: at(2026, 11, 14) }),
        badges: [],
      },
      TZ,
    );
    assert.deepEqual([input.allDay, input.start, input.end], [true, '2026-11-12', '2026-11-14']);
    const single = toEventInput(
      { occurrence: occ({ allDay: true, start: at(2026, 11, 12), end: null }), badges: [] },
      TZ,
    );
    assert.equal(single.end, '2026-11-13');
  });

  it('marks a due-only item and gives it a short slot', () => {
    const input = toEventInput(
      {
        occurrence: occ({ dueOnly: true, end: null, start: at(2026, 11, 12, 23, 30) }),
        badges: [],
      },
      TZ,
    );
    assert.equal(input.end, '2026-11-13T00:00:00');
    assert.ok(input.classNames?.toString().includes('fc-due'));
  });
});
