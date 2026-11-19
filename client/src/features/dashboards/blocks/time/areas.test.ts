import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColourRole, ItemColour } from '@api-types/colours.ts';
import { nestInAreas, splitAreas } from './areas.ts';

const colour = (role: ColourRole): ItemColour => ({
  family: 'teal',
  role,
  from: 'topic',
  subject: null,
  topicId: 't',
});

const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 10, 12, hour, minute));

interface Slot {
  id: string;
  start: Date;
  end: Date | null;
}
const slot = (id: string, from: [number, number?], to: [number, number?] | null): Slot => ({
  id,
  start: at(...from),
  end: to === null ? null : at(...to),
});

const ids = (groups: { area: Slot | null; items: Slot[] }[]) =>
  groups.map((group) => [group.area?.id ?? null, group.items.map((item) => item.id)]);

describe('splitAreas', () => {
  it('takes the rows whose role is area apart, in their order', () => {
    const roles: Record<string, ColourRole> = {
      lecture: 'scheduled',
      studying: 'area',
      bus: 'travel',
      work: 'area',
      homework: 'work',
    };
    const occurrences = ['lecture', 'studying', 'bus', 'work', 'homework'].map((id) => ({
      row: { id },
    }));
    const { areas, items } = splitAreas(occurrences, (rowId) => colour(roles[rowId] ?? 'work'));
    assert.deepEqual(
      areas.map((o) => o.row.id),
      ['studying', 'work'],
    );
    assert.deepEqual(
      items.map((o) => o.row.id),
      ['lecture', 'bus', 'homework'],
    );
  });
});

describe('nestInAreas', () => {
  const studying = slot('studying', [13], [17]);

  it('puts an item that starts inside an area under it', () => {
    assert.deepEqual(ids(nestInAreas([slot('lecture', [13, 30], [15])], [studying])), [
      ['studying', ['lecture']],
    ]);
  });

  it('leaves an item that starts as the area ends outside it', () => {
    assert.deepEqual(ids(nestInAreas([slot('dinner', [17], [18])], [studying])), [
      ['studying', []],
      [null, ['dinner']],
    ]);
  });

  it('puts an item in overlapping areas under the earlier one', () => {
    const work = slot('work', [9], [17]);
    const focus = slot('focus', [10], [12]);
    assert.deepEqual(ids(nestInAreas([slot('review', [10, 30], [11])], [focus, work])), [
      ['work', ['review']],
      ['focus', []],
    ]);
  });

  it('puts it under the longer of two areas that start together', () => {
    const short = slot('short', [13], [15]);
    const long = slot('long', [13], [17]);
    assert.deepEqual(ids(nestInAreas([slot('lecture', [13, 30], [14])], [short, long])), [
      ['long', ['lecture']],
      ['short', []],
    ]);
  });

  it('still yields an area with no items', () => {
    assert.deepEqual(ids(nestInAreas([], [studying])), [['studying', []]]);
  });

  it('is chronological, with the items outside every area grouped between', () => {
    const work = slot('work', [9], [12]);
    const items = [
      slot('gym', [18], null),
      slot('lecture', [14], [15]),
      slot('breakfast', [8], [8, 30]),
      slot('lunch', [12, 30], [13]),
      slot('coffee', [12, 45], null),
      slot('standup', [10], [10, 15]),
      slot('bug', [9, 30], [11]),
    ];
    assert.deepEqual(ids(nestInAreas(items, [studying, work])), [
      [null, ['breakfast']],
      ['work', ['bug', 'standup']],
      [null, ['lunch', 'coffee']],
      ['studying', ['lecture']],
      [null, ['gym']],
    ]);
  });
});
