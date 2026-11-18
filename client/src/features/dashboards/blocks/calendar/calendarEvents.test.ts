import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventInput } from '@fullcalendar/core';
import { zonedTime } from '../clock/ClockRing.math.ts';
import { toAreaEventInput, toEventInput } from './calendarEvents.ts';
import type { Occurrence, TimeRow } from '../time/occurrences.ts';
import type { ColourRole, ItemColour } from '@api-types/colours.ts';

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
const colour = (role: ColourRole = 'work'): ItemColour => ({
  family: 'orange',
  role,
  from: 'topic',
  subject: null,
  topicId: 'work',
});
/** Some of an event's extended props, in the order asked. */
const pick = (input: EventInput, ...keys: string[]): unknown[] => {
  const props: Record<string, unknown> = input.extendedProps ?? {};
  return keys.map((key) => props[key]);
};
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
    const input = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour());
    assert.equal(input.start, '2026-11-12T10:00:00');
    assert.equal(input.end, '2026-11-12T11:00:00');
  });

  it('gives an all-day event whole dates with an exclusive end', () => {
    const input = toEventInput(
      {
        occurrence: occ({ allDay: true, start: at(2026, 11, 12), end: at(2026, 11, 14) }),
        badges: [],
      },
      TZ,
      colour(),
    );
    assert.deepEqual([input.allDay, input.start, input.end], [true, '2026-11-12', '2026-11-14']);
    const single = toEventInput(
      { occurrence: occ({ allDay: true, start: at(2026, 11, 12), end: null }), badges: [] },
      TZ,
      colour(),
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
      colour(),
    );
    assert.equal(input.end, '2026-11-13T00:00:00');
    assert.ok(input.classNames?.toString().includes('fc-due'));
  });

  it('paints an event in its colour: fill, ink and the family and role for the page', () => {
    const input = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour('work'));
    assert.equal(input.backgroundColor, 'var(--tc-orange-work)');
    assert.equal(input.borderColor, 'var(--tc-orange-work)');
    assert.equal(input.textColor, 'var(--tc-orange-work-ink)');
    assert.deepEqual(pick(input, 'family', 'role'), ['orange', 'work']);
    assert.deepEqual(input.classNames, []);
  });

  it('hatches travel, on its muted fill under the page ink', () => {
    const input = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour('travel'));
    assert.deepEqual(input.classNames, ['tc-travel']);
    assert.equal(input.backgroundColor, 'var(--tc-orange-travel)');
    assert.equal(input.textColor, 'var(--foreground)');
    assert.deepEqual(pick(input, 'role'), ['travel']);
  });

  it('never colours by source', () => {
    for (const role of ['scheduled', 'work', 'travel'] as const) {
      const input = toEventInput(
        { occurrence: occ({ dueOnly: true, end: null }), badges: [] },
        TZ,
        colour(role),
      );
      assert.ok(!(input.classNames?.toString() ?? '').includes('fc-src-'));
    }
  });
});

describe('toAreaEventInput', () => {
  it('draws an area as a background band in its tint, with its title', () => {
    const area = occ({ key: 'area-1', row: { ...row('studying'), title: 'Studying' } });
    const input = toAreaEventInput(area, { ...colour('area'), family: 'teal' }, TZ);
    assert.equal(input.display, 'background');
    assert.equal(input.backgroundColor, 'var(--tc-teal-area)');
    assert.deepEqual(input.classNames, ['tc-area']);
    assert.equal(input.title, 'Studying');
    assert.equal(input.id, 'area-1');
    assert.deepEqual([input.start, input.end], ['2026-11-12T10:00:00', '2026-11-12T11:00:00']);
    assert.deepEqual(pick(input, 'rowId', 'area', 'family'), ['studying', true, 'teal']);
  });

  it('gives an all-day area whole dates', () => {
    const input = toAreaEventInput(
      occ({ allDay: true, start: at(2026, 11, 12), end: at(2026, 11, 13) }),
      colour('area'),
      TZ,
    );
    assert.deepEqual([input.allDay, input.start, input.end], [true, '2026-11-12', '2026-11-13']);
  });
});
