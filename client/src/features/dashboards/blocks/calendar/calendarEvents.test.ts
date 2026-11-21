import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventInput } from '@fullcalendar/core';
import { zonedTime } from '../clock/ClockRing.math.ts';
import {
  areaTagsByDay,
  timedSpans,
  toAreaEventInput,
  toAreaPeriodEventInput,
  toEventInput,
} from './calendarEvents.ts';
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
  originalStart: null,
  seriesRowId: null,
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

  it('carries the kind, the layer and the slot an occurrence fills (the sheet opens on it)', () => {
    const plain = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour());
    assert.deepEqual(pick(plain, 'kind', 'layer', 'originalStart'), ['event', null, null]);
    const slot = at(2026, 11, 22, 13);
    const block = toEventInput(
      {
        occurrence: occ({
          row: { ...row('b'), kind: 'block', props: { layer: 'block' } },
          originalStart: slot,
          seriesRowId: 'b',
        }),
        badges: [],
      },
      TZ,
      colour('work'),
    );
    assert.deepEqual(pick(block, 'kind', 'layer', 'originalStart'), [
      'block',
      'block',
      '2026-11-22T11:00:00.000Z',
    ]);
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

describe('toAreaPeriodEventInput', () => {
  it('draws an area as a plain event in the area style, for the month grid and a phone list', () => {
    const slot = at(2026, 11, 12, 10);
    const input = toAreaPeriodEventInput(
      occ({ key: 'area-1', row: { ...row('studying'), title: 'Studying' }, originalStart: slot }),
      { ...colour('area'), family: 'teal' },
      TZ,
    );
    assert.notEqual(input.display, 'background');
    assert.equal(input.title, 'Studying');
    assert.equal(input.backgroundColor, 'var(--tc-teal-area)');
    assert.ok(input.classNames?.toString().includes('tc-area'));
    assert.equal(input.editable, false);
    assert.deepEqual([input.start, input.end], ['2026-11-12T10:00:00', '2026-11-12T11:00:00']);
    assert.deepEqual(pick(input, 'rowId', 'area', 'originalStart'), [
      'studying',
      true,
      slot.toISOString(),
    ]);
  });

  it('keeps an all-day area on whole dates', () => {
    const input = toAreaPeriodEventInput(
      occ({ allDay: true, start: at(2026, 11, 12), end: at(2026, 11, 13) }),
      colour('area'),
      TZ,
    );
    assert.deepEqual([input.allDay, input.start, input.end], [true, '2026-11-12', '2026-11-13']);
  });
});

describe('areaTagsByDay', () => {
  const area = (key: string, over: Partial<Occurrence>): Occurrence =>
    occ({ key, row: { ...row(key), title: key }, ...over });
  const teal = (): ItemColour => ({ ...colour('area'), family: 'teal' });

  it('names an area in its day’s header, with its times and the slot it opens on', () => {
    const slot = at(2026, 11, 19, 8, 30);
    const tags = areaTagsByDay(
      [area('Braude', { start: slot, end: at(2026, 11, 19, 15), originalStart: slot })],
      teal,
      TZ,
    );
    assert.deepEqual([...tags.keys()], ['2026-11-19']);
    assert.deepEqual(tags.get('2026-11-19'), [
      {
        key: 'Braude',
        rowId: 'Braude',
        title: 'Braude',
        family: 'teal',
        originalStart: slot.toISOString(),
        from: '08:30',
        to: '15:00',
      },
    ]);
  });

  it('lists a day’s areas in order of start', () => {
    const tags = areaTagsByDay(
      [
        area('Evening', { start: at(2026, 11, 19, 18), end: at(2026, 11, 19, 20) }),
        area('Morning', { start: at(2026, 11, 19, 8), end: at(2026, 11, 19, 12) }),
      ],
      teal,
      TZ,
    );
    assert.deepEqual(
      tags.get('2026-11-19')?.map((tag) => tag.title),
      ['Morning', 'Evening'],
    );
  });

  it('names an area past midnight on both days; an end at midnight closes the day before', () => {
    const night = areaTagsByDay(
      [area('Night', { start: at(2026, 11, 19, 22), end: at(2026, 11, 20, 2) })],
      teal,
      TZ,
    );
    assert.deepEqual([...night.keys()], ['2026-11-19', '2026-11-20']);
    const toMidnight = areaTagsByDay(
      [area('Late', { start: at(2026, 11, 19, 20), end: at(2026, 11, 20, 0) })],
      teal,
      TZ,
    );
    assert.deepEqual([...toMidnight.keys()], ['2026-11-19']);
  });

  it('names an all-day area on every day it covers, without times', () => {
    const tags = areaTagsByDay(
      [area('Trip', { allDay: true, start: at(2026, 11, 19), end: at(2026, 11, 21) })],
      teal,
      TZ,
    );
    assert.deepEqual([...tags.keys()], ['2026-11-19', '2026-11-20']);
    assert.deepEqual(
      [tags.get('2026-11-20')?.[0]?.from, tags.get('2026-11-20')?.[0]?.to],
      [null, null],
    );
  });
});

describe('a leg’s id', () => {
  const leg = (mode: 'walk' | 'transit', title: string) => ({
    mode,
    title,
    conflict: false,
    past: false,
    moved: false,
    unset: false,
  });
  const idOf = (mode: 'walk' | 'transit', title: string) =>
    toEventInput(
      { occurrence: occ({ key: 'leg1' }), badges: [], leg: leg(mode, title) },
      TZ,
      colour('travel'),
    ).id;

  it('changes with the mode and the title, so the chip is drawn again', () => {
    assert.notEqual(idOf('walk', 'Walk to Braude'), idOf('transit', 'Walk to Braude'));
    assert.notEqual(idOf('transit', 'Bus to Braude'), idOf('transit', 'Bus to Home'));
    assert.equal(idOf('walk', 'Walk to Braude'), idOf('walk', 'Walk to Braude'));
  });
});

describe('an event is drawn again when what its name says changes', () => {
  // A moved occurrence keeps its key (`row@slot`): only the id tells FullCalendar to draw it again,
  // and its name and tooltip (eventDidMount) are where its times are now.
  const base = { occurrence: occ({ key: 'block@slot' }), badges: [] as string[] };
  const idOf = (item: Parameters<typeof toEventInput>[0], role: ColourRole = 'work') =>
    toEventInput(item, TZ, colour(role)).id;

  it('is the same for the same event', () => {
    assert.equal(idOf(base), idOf({ ...base }));
  });

  it('changes when the occurrence moves (this one only, to 14:00)', () => {
    const moved = {
      ...base,
      occurrence: occ({
        key: 'block@slot',
        start: at(2026, 11, 12, 14),
        end: at(2026, 11, 12, 18),
      }),
    };
    assert.notEqual(idOf(base), idOf(moved));
    const longer = { ...base, occurrence: occ({ key: 'block@slot', end: at(2026, 11, 12, 12) }) };
    assert.notEqual(idOf(base), idOf(longer));
  });

  it('changes with the tone, the badges, the title and the colour', () => {
    assert.notEqual(idOf(base), idOf({ ...base, tone: 'destructive' }));
    assert.notEqual(idOf(base), idOf({ ...base, badges: ['Late'] }));
    const renamed = {
      ...base,
      occurrence: occ({ key: 'block@slot', row: { ...row('r'), title: 'New' } }),
    };
    assert.notEqual(idOf(base), idOf(renamed));
    assert.notEqual(idOf(base), idOf(base, 'scheduled'));
  });
});

describe('timedSpans and the stretch', () => {
  it('spans the timed events; a due date lasts its point; all-day ones are left out', () => {
    const start = at(2026, 11, 19, 8, 20);
    const spans = timedSpans([
      { occurrence: occ({ key: 'walk', start, end: at(2026, 11, 19, 8, 30) }), badges: [] },
      { occurrence: occ({ key: 'due', start, end: null, dueOnly: true }), badges: [] },
      { occurrence: occ({ key: 'day', allDay: true, start: at(2026, 11, 19) }), badges: [] },
    ]);
    assert.deepEqual(spans, [
      { key: 'walk', start: start.getTime(), end: start.getTime() + 10 * 60_000 },
      { key: 'due', start: start.getTime(), end: start.getTime() + 30 * 60_000 },
    ]);
  });

  it('marks a stretched event for the page (class and props), and only that one', () => {
    const stretched = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour(), {
      stretched: true,
    });
    assert.ok(stretched.classNames?.toString().includes('tc-stretch'));
    assert.deepEqual(pick(stretched, 'stretched', 'tap'), [true, null]);
    const plain = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour());
    assert.deepEqual(pick(plain, 'stretched', 'tap'), [false, null]);
  });

  it('carries a tiny chip’s hit area', () => {
    const tiny = toEventInput({ occurrence: occ({}), badges: [] }, TZ, colour(), {
      tap: { above: 14, below: 0 },
    });
    assert.deepEqual(pick(tiny, 'stretched', 'tap'), [false, { above: 14, below: 0 }]);
    assert.ok(!(tiny.classNames?.toString() ?? '').includes('tc-stretch'));
  });
});
