import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttributeDef } from '@api-types/attributes.ts';
import type { ItemQueryRow } from '@api-types/builder.ts';
import { resolveColour } from '@api-types/colours.ts';
import { colourContextOf, colourInputOf, type ColourRow } from './rowColour.ts';

function row(overrides: Partial<ColourRow> = {}): ColourRow {
  return {
    kind: 'event',
    title: 'Calculus lecture',
    topicId: 't-college',
    source: { provider: 'google_calendar' },
    props: {},
    overlay: { topicOverride: null, attrs: {} },
    ...overrides,
  };
}

/** A block query's row, as the server sends it: the shape every view colours from. */
const QUERY_ROW: ItemQueryRow = {
  id: 'i1',
  kind: 'task',
  topicId: null,
  title: 'Homework 3',
  status: 'open',
  statusRaw: null,
  priority: null,
  startAt: null,
  dueAt: null,
  endAt: null,
  allDay: false,
  containerId: null,
  labels: [],
  assignees: [],
  source: { provider: 'moodle', key: null, url: 'https://moodle.example', externalId: 'm1' },
  props: { layer: 'block' },
  overlay: {
    pinned: null,
    note: null,
    hidden: null,
    topicOverride: 't-work',
    calendarSync: null,
    plannedAt: null,
    editedAt: null,
    attrs: { subject: 'Algebra' },
  },
  closedAt: null,
};

const SUBJECT: AttributeDef = {
  key: 'subject',
  name: 'Subject',
  type: 'select',
  options: ['Calculus', 'Algebra', 'Physics'],
  optionLooks: [
    { option: 'Calculus', colour: 'violet', patterns: ['*calculus*', '*חדו"א*'] },
    { option: 'Algebra', colour: 'pink', patterns: [] },
  ],
  builtIn: false,
};

describe('colourInputOf', () => {
  it("reads the item's own subject and a time block's layer", () => {
    const input = colourInputOf(
      row({
        kind: 'event',
        props: { layer: 'area' },
        overlay: { topicOverride: 't-work', attrs: { subject: 'Calculus' } },
      }),
    );
    assert.equal(input.subject, 'Calculus');
    assert.equal(input.layer, 'area');
    assert.equal(input.topicOverride, 't-work');
    assert.equal(input.topicId, 't-college');
    assert.equal(input.provider, 'google_calendar');
    assert.equal(input.title, 'Calculus lecture');
    assert.equal(input.kind, 'event');
  });

  it('ignores a subject that is not text and a layer it does not know', () => {
    const input = colourInputOf(
      row({ props: { layer: 'x' }, overlay: { topicOverride: null, attrs: { subject: 3 } } }),
    );
    assert.equal(input.subject, null);
    assert.equal(input.layer, null);
    assert.equal(colourInputOf(row()).layer, null);
    assert.equal(colourInputOf(row()).subject, null);
  });

  it('takes a block query row as it is', () => {
    const input = colourInputOf(QUERY_ROW);
    assert.equal(input.provider, 'moodle');
    assert.equal(input.subject, 'Algebra');
    assert.equal(input.layer, 'block');
    assert.equal(input.topicOverride, 't-work');
  });
});

describe('colourContextOf', () => {
  it('maps a topic without a family to gray', () => {
    const context = colourContextOf(
      [
        { id: 't-work', colour: 'blue' },
        { id: 't-new', colour: null },
      ],
      [],
    );
    assert.equal(context.topicFamilies.get('t-work'), 'blue');
    assert.equal(context.topicFamilies.get('t-new'), 'gray');
    assert.deepEqual(context.subjects, []);
  });

  it('builds the subjects from the subject select, in option order', () => {
    const other: AttributeDef = {
      key: 'course',
      name: 'Course',
      type: 'select',
      options: ['A'],
      optionLooks: [{ option: 'A', colour: 'red', patterns: ['*'] }],
      builtIn: false,
    };
    const context = colourContextOf([], [other, SUBJECT]);
    assert.deepEqual(context.subjects, [
      { name: 'Calculus', family: 'violet', patterns: ['*calculus*', '*חדו"א*'] },
      { name: 'Algebra', family: 'pink', patterns: [] },
    ]);
  });

  it('colours a row through the shared rule', () => {
    const context = colourContextOf([{ id: 't-college', colour: 'orange' }], [SUBJECT]);
    assert.deepEqual(resolveColour(colourInputOf(row()), context), {
      family: 'violet',
      role: 'scheduled',
      from: 'subject',
      subject: 'Calculus',
      topicId: 't-college',
    });
    assert.deepEqual(
      resolveColour(colourInputOf(row({ title: 'Office hours', kind: 'task' })), context),
      { family: 'orange', role: 'work', from: 'topic', subject: null, topicId: 't-college' },
    );
  });
});
