import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemQueryRow, Query, QueryResult } from '@api-types/builder.ts';
import type { ColourRole, ItemColour } from '@api-types/colours.ts';
import { zonedTime } from '../clock/ClockRing.math.ts';
import {
  PLANNED_MINUTES,
  buildTimesheet,
  panelOrder,
  plannedAtFromDrop,
  plannedEventInput,
  plannedInRange,
  selectionPreset,
  truncatedTodos,
  withPlan,
} from './timesheetModel.ts';
import {
  showsBlocks,
  timesheetTopicId,
  topicChoiceOf,
  withTopicChoice,
  withTopicListen,
} from './timesheetTopic.ts';

const TZ = 'Asia/Jerusalem';
const at = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  zonedTime(y, m, d, h, min, TZ);
/** The week of Sunday 22 November 2026 in Jerusalem, as the grid's range. */
const WEEK = { from: at(2026, 11, 22), to: at(2026, 11, 29) };

function row(id: string, over: Partial<ItemQueryRow> = {}): ItemQueryRow {
  return {
    id,
    kind: 'todo',
    topicId: 'work',
    title: id,
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
    source: { provider: 'local', key: null, url: `https://app/items/${id}`, externalId: id },
    props: {},
    overlay: {
      pinned: null,
      note: null,
      hidden: null,
      topicOverride: null,
      calendarSync: null,
      plannedAt: null,
      editedAt: null,
      attrs: {},
    },
    closedAt: null,
    ...over,
  };
}

const planned = (id: string, plannedAt: string, over: Partial<ItemQueryRow> = {}): ItemQueryRow =>
  row(id, { ...over, overlay: { ...row(id).overlay, plannedAt } });

/** A row's colour by its layer: an area paints a band; anything else is work. */
const colourOf =
  (rows: readonly ItemQueryRow[]) =>
  (rowId: string): ItemColour => {
    const found = rows.find((entry) => entry.id === rowId);
    const role: ColourRole =
      found?.kind === 'block' ? (found.props['layer'] === 'area' ? 'area' : 'scheduled') : 'work';
    return { family: 'orange', role, from: 'topic', subject: null, topicId: 'work' };
  };

describe('plannedAtFromDrop: the drop becomes the plan', () => {
  it('reads the wall clock FullCalendar holds, never the browser’s zone', () => {
    // FullCalendar runs in UTC holding the workspace's wall clock: 10:00 there is 10:00 in Jerusalem.
    assert.equal(plannedAtFromDrop(new Date('2026-11-24T10:00:00Z'), false), '2026-11-24T10:00');
  });

  it('lands on the quarter hour the drop falls in', () => {
    for (const [dropped, plan] of [
      ['2026-11-24T10:14:59Z', '2026-11-24T10:00'],
      ['2026-11-24T10:15:00Z', '2026-11-24T10:15'],
      ['2026-11-24T10:44:00Z', '2026-11-24T10:30'],
      ['2026-11-24T23:59:00Z', '2026-11-24T23:45'],
    ] as const) {
      assert.equal(plannedAtFromDrop(new Date(dropped), false), plan, dropped);
    }
  });

  it('a drop on the all-day row plans the day alone', () => {
    assert.equal(plannedAtFromDrop(new Date('2026-11-24T00:00:00Z'), true), '2026-11-24');
  });

  it('round-trips: the chip of a plan sits where the drop was', () => {
    const plan = plannedAtFromDrop(new Date('2026-11-24T13:30:00Z'), false);
    const input = plannedEventInput(planned('a', plan), colourOf([])('a'));
    assert.equal(input?.start, '2026-11-24T13:30:00');
  });
});

describe('plannedInRange: in the visible week, on the workspace’s wall clock', () => {
  it('holds a plan from the first day’s midnight up to the next week’s', () => {
    assert.equal(plannedInRange('2026-11-22T00:00', WEEK, TZ), true);
    assert.equal(plannedInRange('2026-11-28T23:45', WEEK, TZ), true);
    assert.equal(plannedInRange('2026-11-28', WEEK, TZ), true);
    assert.equal(plannedInRange('2026-11-29T00:00', WEEK, TZ), false);
    assert.equal(plannedInRange('2026-11-21T23:59', WEEK, TZ), false);
    assert.equal(plannedInRange(null, WEEK, TZ), false);
    assert.equal(plannedInRange('soon', WEEK, TZ), false);
  });
});

describe('panelOrder: unplanned first, then planned', () => {
  it('puts to-dos with no plan first, soonest due first, then the planned by their plan', () => {
    const rows = [
      planned('planned-late', '2026-11-25T09:00'),
      row('undated-b', { title: 'B' }),
      row('due-later', { dueAt: new Date('2026-12-10T10:00:00Z') }),
      planned('planned-day', '2026-11-24'),
      row('undated-a', { title: 'A' }),
      row('due-soon', { dueAt: new Date('2026-11-23T10:00:00Z') }),
      planned('planned-early', '2026-11-24T08:30'),
    ];
    assert.deepEqual(
      panelOrder(rows).map((entry) => entry.id),
      [
        'due-soon',
        'due-later',
        'undated-a',
        'undated-b',
        'planned-day',
        'planned-early',
        'planned-late',
      ],
    );
  });

  it('reads due dates as JSON strings too, and never changes its input', () => {
    const rows = [
      row('later', { dueAt: '2026-12-01T00:00:00.000Z' as unknown as Date }),
      row('sooner', { dueAt: '2026-11-30T00:00:00.000Z' as unknown as Date }),
    ];
    assert.deepEqual(
      panelOrder(rows).map((entry) => entry.id),
      ['sooner', 'later'],
    );
    assert.deepEqual(
      rows.map((entry) => entry.id),
      ['later', 'sooner'],
    );
  });
});

describe('buildTimesheet: areas, blocks and planned to-dos', () => {
  const area = row('area', {
    kind: 'block',
    title: 'TLVTech',
    startAt: at(2026, 11, 3, 9),
    endAt: at(2026, 11, 3, 17),
    props: { layer: 'area', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] },
  });
  const block = row('block', {
    kind: 'block',
    title: 'Deep work',
    startAt: at(2026, 11, 25, 10),
    endAt: at(2026, 11, 25, 12),
    props: { layer: 'block' },
  });
  const rows = [
    area,
    block,
    row('loose'),
    planned('this-week', '2026-11-24T10:30'),
    planned('next-week', '2026-12-01T10:30'),
  ];

  it('expands the area’s series into the week, draws the block, plans the to-dos', () => {
    const model = buildTimesheet(rows, WEEK, TZ, colourOf(rows), true);
    assert.deepEqual(
      model.areas.map((o) => [o.row.id, o.start.toISOString()]),
      [['area', at(2026, 11, 24, 9).toISOString()]],
    );
    assert.deepEqual(
      model.timed.map((o) => o.row.id),
      ['block'],
    );
    assert.deepEqual(
      model.todos.map((entry) => entry.id),
      ['loose', 'this-week', 'next-week'],
    );
    assert.deepEqual(
      model.planned.map((entry) => entry.id),
      ['this-week'],
    );
  });

  it('showBlocks off keeps the areas and leaves the time blocks out', () => {
    const model = buildTimesheet(rows, WEEK, TZ, colourOf(rows), false);
    assert.equal(model.areas.length, 1);
    assert.deepEqual(model.timed, []);
    assert.equal(showsBlocks({ kind: 'timesheet' }), true);
    assert.equal(showsBlocks({ kind: 'timesheet', showBlocks: true }), true);
    assert.equal(showsBlocks({ kind: 'timesheet', showBlocks: false }), false);
  });
});

describe('plannedEventInput: a planned to-do as a chip', () => {
  const colour = colourOf([])('a');

  it('sits at its plan for 30 minutes, draggable, not resizable, in its colour', () => {
    const input = plannedEventInput(planned('a', '2026-11-24T23:45', { title: 'Report' }), colour);
    assert.ok(input !== null);
    assert.equal(PLANNED_MINUTES, 30);
    assert.deepEqual(
      [input.allDay, input.start, input.end, input.title],
      [false, '2026-11-24T23:45:00', '2026-11-25T00:15:00', 'Report'],
    );
    assert.deepEqual(
      [input.editable, input.startEditable, input.durationEditable],
      [true, true, false],
    );
    assert.deepEqual(input.classNames, ['tc-planned']);
    assert.equal(input.backgroundColor, 'var(--tc-orange-work)');
    assert.deepEqual(input.extendedProps, {
      rowId: 'a',
      planned: true,
      provider: 'local',
      family: 'orange',
      role: 'work',
      plannedAt: '2026-11-24T23:45',
    });
  });

  it('a day without a time is on the all-day row; no plan is no chip', () => {
    const day = plannedEventInput(planned('a', '2026-11-24'), colour);
    assert.deepEqual([day?.allDay, day?.start, day?.end], [true, '2026-11-24', '2026-11-25']);
    assert.equal(plannedEventInput(row('a'), colour), null);
  });

  it('is drawn again when its plan changes (its id carries the plan)', () => {
    const before = plannedEventInput(planned('a', '2026-11-24T10:00'), colour);
    const after = plannedEventInput(planned('a', '2026-11-24T11:00'), colour);
    assert.notEqual(before?.id, after?.id);
  });
});

describe('truncatedTodos: the panel says when the row cap left to-dos out', () => {
  const area = row('area', { kind: 'block', props: { layer: 'area' } });
  const block = row('block', { kind: 'block', props: { layer: 'block' } });
  const result = (rows: ItemQueryRow[], total: number): QueryResult => ({
    rows,
    total,
    appliedVars: {},
    warnings: [],
  });

  it('nothing when every match is here', () => {
    assert.equal(truncatedTodos(result([area, row('a'), row('b')], 3)), null);
    assert.equal(truncatedTodos(result([], 0)), null);
    assert.equal(truncatedTodos(undefined), null);
  });

  it('counts only to-dos: the time is never cut, so every missing row is a to-do', () => {
    // 200 rows came back of 230 matches: 2 of them time, 198 to-dos; 30 to-dos left out.
    const rows = [area, block, ...Array.from({ length: 198 }, (_, i) => row(`t${String(i)}`))];
    assert.deepEqual(truncatedTodos(result(rows, 230)), { shown: 198, total: 228 });
  });
});

describe('withPlan: the optimistic write', () => {
  it('changes the one to-do’s plan in the cached result, and nothing else', () => {
    const data: QueryResult = {
      rows: [row('a'), planned('b', '2026-11-24T10:00')],
      total: 2,
      appliedVars: {},
      warnings: [],
    };
    const next = withPlan(data, 'a', '2026-11-25T09:15');
    const rows = (next?.rows ?? []) as ItemQueryRow[];
    assert.equal(rows[0]?.overlay.plannedAt, '2026-11-25T09:15');
    assert.equal(rows[1]?.overlay.plannedAt, '2026-11-24T10:00');
    assert.equal((data.rows?.[0] as ItemQueryRow).overlay.plannedAt, null, 'a copy');
    const cleared = withPlan(next, 'b', null);
    assert.equal((cleared?.rows?.[1] as ItemQueryRow).overlay.plannedAt, null);
    assert.equal(withPlan(undefined, 'a', null), undefined);
  });
});

describe('selectionPreset: a drag across the grid', () => {
  const area = row('area', {
    kind: 'block',
    topicId: 'studies',
    startAt: at(2026, 11, 24, 9),
    endAt: at(2026, 11, 24, 12),
    props: { layer: 'area' },
  });
  const areas = buildTimesheet([area], WEEK, TZ, colourOf([area]), true).areas;

  it('over free time paints a new area of the timesheet’s topic', () => {
    const preset = selectionPreset(
      { startWall: '2026-11-24T13:00:00', endWall: '2026-11-24T15:00:00' },
      areas,
      TZ,
      'work',
    );
    assert.deepEqual(preset, {
      kind: 'area',
      start: at(2026, 11, 24, 13),
      end: at(2026, 11, 24, 15),
      topicId: 'work',
    });
    // Reading every topic: no topic picked for it.
    assert.equal(
      'topicId' in
        selectionPreset(
          { startWall: '2026-11-24T13:00:00', endWall: '2026-11-24T15:00:00' },
          areas,
          TZ,
          null,
        ),
      false,
    );
    // Touching the area's end is not inside it.
    assert.equal(
      selectionPreset(
        { startWall: '2026-11-24T12:00:00', endWall: '2026-11-24T13:00:00' },
        areas,
        TZ,
        'work',
      ).kind,
      'area',
    );
  });

  it('inside painted time makes a time block there, on the area’s topic', () => {
    assert.deepEqual(
      selectionPreset(
        { startWall: '2026-11-24T10:00:00', endWall: '2026-11-24T11:00:00' },
        areas,
        TZ,
        'work',
      ),
      { kind: 'block', start: at(2026, 11, 24, 10), end: at(2026, 11, 24, 11), topicId: 'studies' },
    );
  });
});

describe('the topic the timesheet reads (its query’s topic rule)', () => {
  const base: Query = {
    source: 'items',
    where: {
      combinator: 'and',
      rules: [
        { field: 'topic', operator: '=', value: '$page.topic' },
        { field: 'kind', operator: '=', value: 'block' },
      ],
    },
  };

  it('reads the page’s topic, one topic, or every topic', () => {
    assert.deepEqual(topicChoiceOf(base), { kind: 'page' });
    assert.deepEqual(topicChoiceOf(withTopicChoice(base, { kind: 'topic', id: 't2' })), {
      kind: 'topic',
      id: 't2',
    });
    assert.deepEqual(topicChoiceOf(withTopicChoice(base, { kind: 'all' })), { kind: 'all' });
    assert.deepEqual(topicChoiceOf({ source: 'items' }), { kind: 'all' });
    assert.deepEqual(topicChoiceOf(undefined), { kind: 'all' });
  });

  it('replaces, adds or takes off the one topic rule, leaving the rest', () => {
    assert.deepEqual(withTopicChoice(base, { kind: 'topic', id: 't2' }).where?.rules, [
      { field: 'topic', operator: '=', value: 't2' },
      { field: 'kind', operator: '=', value: 'block' },
    ]);
    assert.deepEqual(withTopicChoice(base, { kind: 'all' }).where?.rules, [
      { field: 'kind', operator: '=', value: 'block' },
    ]);
    assert.deepEqual(withTopicChoice({ source: 'items' }, { kind: 'page' }).where, {
      combinator: 'and',
      rules: [{ field: 'topic', operator: '=', value: '$page.topic' }],
    });
    // Nothing left: no where at all.
    const only: Query = {
      source: 'items',
      where: { combinator: 'and', rules: [{ field: 'topic', operator: '=', value: 't1' }] },
    };
    assert.equal('where' in withTopicChoice(only, { kind: 'all' }), false);
    // An `or` at the top is kept whole, beside the topic rule.
    const either: Query = {
      source: 'items',
      where: { combinator: 'or', rules: [{ field: 'kind', operator: '=', value: 'block' }] },
    };
    assert.deepEqual(withTopicChoice(either, { kind: 'page' }).where, {
      combinator: 'and',
      rules: [{ field: 'topic', operator: '=', value: '$page.topic' }, either.where],
    });
  });

  it('listens to $page.topic exactly while something of the block reads it', () => {
    const page = withTopicChoice(base, { kind: 'page' });
    const one = withTopicChoice(base, { kind: 'topic', id: 't2' });
    assert.deepEqual(withTopicListen(['$page.range'], page), ['$page.range', '$page.topic']);
    assert.deepEqual(withTopicListen(['$page.topic', '$page.range'], page), [
      '$page.topic',
      '$page.range',
    ]);
    assert.deepEqual(withTopicListen(['$page.range', '$page.topic'], one), ['$page.range']);
    // A display rule that still reads it keeps it.
    const rules = [{ if: { field: 'topic', operator: '=', value: '$page.topic' } }];
    assert.deepEqual(withTopicListen(['$page.topic'], one, rules), ['$page.topic']);
  });

  it('a new area takes the page’s topic, the one picked, or none', () => {
    assert.equal(timesheetTopicId(base, { topic: 't1' }), 't1');
    assert.equal(timesheetTopicId(base, {}), null);
    assert.equal(timesheetTopicId(withTopicChoice(base, { kind: 'topic', id: 't2' }), {}), 't2');
    assert.equal(timesheetTopicId(withTopicChoice(base, { kind: 'all' }), { topic: 't1' }), null);
  });
});
