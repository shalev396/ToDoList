import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColourFamily, ColourRole, ItemColour } from '@api-types/colours.ts';
import { legendEntries } from './legend.ts';

const NAMES: Record<string, string> = { work: 'Work', college: 'College' };

const colour = (family: ColourFamily, topicId: string | null, role: ColourRole = 'work') => ({
  colour: { family, role, from: 'topic', subject: null, topicId } satisfies ItemColour,
});
const labelOf = (c: ItemColour): string =>
  c.subject ?? (c.topicId === null ? undefined : NAMES[c.topicId]) ?? c.topicId ?? 'Unsorted';

describe('legendEntries', () => {
  it('lists each family and name once, in the order first seen', () => {
    const { entries, more } = legendEntries(
      [
        colour('orange', 'work'),
        colour('teal', 'college', 'scheduled'),
        colour('orange', 'work', 'scheduled'),
      ],
      labelOf,
    );
    assert.deepEqual(
      entries.map((entry) => [entry.label, entry.colour.family]),
      [
        ['Work', 'orange'],
        ['College', 'teal'],
      ],
    );
    assert.equal(new Set(entries.map((entry) => entry.key)).size, 2);
    assert.equal(more, 0);
  });

  it('shows six at most and counts the rest', () => {
    const families: ColourFamily[] = [
      'blue',
      'orange',
      'teal',
      'amber',
      'pink',
      'green',
      'violet',
      'red',
    ];
    const { entries, more } = legendEntries(
      families.map((family) => colour(family, family)),
      labelOf,
    );
    assert.deepEqual(
      entries.map((entry) => entry.label),
      ['blue', 'orange', 'teal', 'amber', 'pink', 'green'],
    );
    assert.equal(more, 2);
  });

  it('keeps a subject apart from its topic, and skips marks without a colour', () => {
    const calculus: ItemColour = {
      family: 'violet',
      role: 'scheduled',
      from: 'subject',
      subject: 'Calculus',
      topicId: 'college',
    };
    const { entries } = legendEntries(
      [{ colour: calculus }, {}, colour('teal', 'college')],
      labelOf,
    );
    assert.deepEqual(
      entries.map((entry) => entry.label),
      ['Calculus', 'College'],
    );
  });
});
