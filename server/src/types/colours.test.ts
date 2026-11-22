import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AttributeDef } from './attributes.js';
import { TOPIC_COLOURS } from './topics.js';
import {
  FAMILY_ASSIGN_ORDER,
  nextFamily,
  resolveColour,
  roleOf,
  subjectOf,
  subjectsOf,
  type ColourContext,
  type ColourInput,
  type ColourSubject,
} from './colours.js';

const SUBJECTS: ColourSubject[] = [
  { name: 'Calculus', family: 'blue', patterns: ['*calc*', '*חדו"א*'] },
  { name: 'Algebra', family: 'pink', patterns: ['*algebra*'] },
  { name: 'Physics', family: 'green', patterns: [] },
];

const input = (over: Partial<ColourInput> = {}): ColourInput => ({
  kind: 'event',
  provider: 'google_calendar',
  title: 'x',
  topicId: null,
  topicOverride: null,
  subject: null,
  layer: null,
  ...over,
});

const context = (over: Partial<ColourContext> = {}): ColourContext => ({
  topicFamilies: new Map([
    ['t-work', 'blue'],
    ['t-college', 'orange'],
  ]),
  subjects: SUBJECTS,
  ...over,
});

describe('roleOf', () => {
  it('maps kinds to roles', () => {
    const role = (
      kind: ColourInput['kind'],
      provider = 'x',
      layer: ColourInput['layer'] = null,
    ): string => roleOf({ kind, provider, layer });
    assert.equal(role('event', 'google_calendar'), 'scheduled');
    assert.equal(role('event', 'moodle'), 'scheduled');
    assert.equal(role('event', 'local'), 'work');
    for (const kind of [
      'todo',
      'issue',
      'task',
      'assignment',
      'deadline',
      'pr',
      'message',
    ] as const) {
      assert.equal(role(kind), 'work', kind);
    }
    assert.equal(role('block', 'local', 'block'), 'work');
    assert.equal(role('block', 'local', 'area'), 'area');
    assert.equal(role('travel', 'local'), 'travel');
  });
});

describe('subjectOf', () => {
  it('prefers the explicit value over an earlier pattern match', () => {
    assert.equal(subjectOf({ subject: 'Algebra', title: 'calc quiz' }, SUBJECTS)?.name, 'Algebra');
  });
  it('falls to patterns when the explicit value is no subject', () => {
    assert.equal(subjectOf({ subject: 'Gone', title: 'calc quiz' }, SUBJECTS)?.name, 'Calculus');
  });
  it('picks the first in option order when two match', () => {
    assert.equal(
      subjectOf({ subject: null, title: 'calc and algebra' }, SUBJECTS)?.name,
      'Calculus',
    );
  });
  it('matches Hebrew patterns with quotes and mixed case', () => {
    assert.equal(subjectOf({ subject: null, title: 'הרצאה: חדו"א 1' }, SUBJECTS)?.name, 'Calculus');
    assert.equal(subjectOf({ subject: null, title: 'calculus quiz' }, SUBJECTS)?.name, 'Calculus');
    assert.equal(subjectOf({ subject: null, title: 'CALC' }, SUBJECTS)?.name, 'Calculus');
  });
  it('never matches a subject without patterns', () => {
    assert.equal(subjectOf({ subject: null, title: 'Physics' }, SUBJECTS), null);
  });
});

describe('resolveColour', () => {
  it('lets the subject beat the topic', () => {
    const colour = resolveColour(input({ title: 'Calc', topicId: 't-college' }), context());
    assert.deepEqual(
      [colour.family, colour.from, colour.subject, colour.topicId],
      ['blue', 'subject', 'Calculus', 't-college'],
    );
  });
  it('lets topicOverride beat topicId', () => {
    const colour = resolveColour(
      input({ topicId: 't-work', topicOverride: 't-college' }),
      context(),
    );
    assert.deepEqual([colour.family, colour.from], ['orange', 'topic']);
  });
  it('falls to gray for an override naming a deleted topic', () => {
    const colour = resolveColour(input({ topicId: 't-work', topicOverride: 't-gone' }), context());
    assert.deepEqual([colour.family, colour.from], ['gray', 'unsorted']);
  });
  it('falls to the topic when the subject value is no longer an option', () => {
    const colour = resolveColour(input({ subject: 'Gone', topicId: 't-work' }), context());
    assert.deepEqual([colour.family, colour.from, colour.subject], ['blue', 'topic', null]);
  });
  it('reads a topic missing from the map, and no topic, as gray', () => {
    assert.equal(resolveColour(input({ topicId: 't-new' }), context()).family, 'gray');
    assert.equal(resolveColour(input(), context()).from, 'unsorted');
  });
  it('shares a family between a lecture and a block, with their own roles', () => {
    const lecture = resolveColour(input({ title: 'Calculus 1' }), context());
    const block = resolveColour(
      input({ kind: 'block', provider: 'local', title: 'Calculus', layer: 'block' }),
      context(),
    );
    assert.deepEqual([lecture.family, lecture.role], ['blue', 'scheduled']);
    assert.deepEqual([block.family, block.role], ['blue', 'work']);
  });
  it('does not give a travel leg titled like a subject pattern that subject', () => {
    const leg = resolveColour(
      input({ kind: 'travel', provider: 'local', title: 'Calculus drive', topicId: 't-college' }),
      context(),
    );
    assert.deepEqual(
      [leg.family, leg.role, leg.from, leg.subject],
      ['orange', 'travel', 'topic', null],
    );
  });
});

describe('nextFamily', () => {
  const eight = ['blue', 'orange', 'teal', 'amber', 'pink', 'green', 'violet', 'red'] as const;
  it('walks the assignment order, ignoring gray and null', () => {
    assert.equal(nextFamily([]), 'blue');
    assert.equal(nextFamily(['blue', null, 'gray']), 'orange');
  });
  it('reuses from the start once every family is taken', () => {
    assert.equal(nextFamily(eight), 'blue');
    assert.equal(nextFamily([...eight, 'blue']), 'orange');
  });
});

describe('the magenta family', () => {
  it('is one of the ten families a topic or a Subject may name', () => {
    assert.equal(TOPIC_COLOURS.length, 10);
    assert.equal(new Set(TOPIC_COLOURS).size, 10);
    assert.ok((TOPIC_COLOURS as readonly string[]).includes('magenta'));
  });
  it('is chosen by hand, never auto-assigned', () => {
    assert.equal((FAMILY_ASSIGN_ORDER as readonly string[]).includes('magenta'), false);
    const eight = [...FAMILY_ASSIGN_ORDER];
    assert.equal(nextFamily([...eight, 'magenta']), 'blue');
    assert.equal(nextFamily(['magenta']), 'blue');
  });
  it('colours an item whose Subject is magenta, in its role', () => {
    const subjects: ColourSubject[] = [{ name: 'TLVTech', family: 'magenta', patterns: [] }];
    const area = resolveColour(
      input({ kind: 'block', provider: 'local', layer: 'area', subject: 'TLVTech' }),
      { topicFamilies: new Map(), subjects },
    );
    assert.deepEqual([area.family, area.role, area.from], ['magenta', 'area', 'subject']);
  });
});

describe('subjectsOf', () => {
  const def = (over: Partial<AttributeDef>): AttributeDef => ({
    key: 'subject',
    name: 'Subject',
    type: 'select',
    builtIn: false,
    ...over,
  });
  it('is empty without the attribute or for a non-select', () => {
    assert.deepEqual(subjectsOf([]), []);
    assert.deepEqual(subjectsOf([def({ type: 'text' })]), []);
  });
  it('keeps option order and leaves out options without a look', () => {
    const subjects = subjectsOf([
      def({
        options: ['C', 'A', 'B'],
        optionLooks: [
          { option: 'B', colour: 'teal', patterns: ['*b*'] },
          { option: 'C', colour: 'red', patterns: [] },
        ],
      }),
    ]);
    assert.deepEqual(subjects, [
      { name: 'C', family: 'red', patterns: [] },
      { name: 'B', family: 'teal', patterns: ['*b*'] },
    ]);
  });
});
