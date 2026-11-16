import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { OPERATORS, type DisplayRule, type Operator, type Rule } from '@api-types/builder.ts';
import {
  OPERATOR_EVALUATORS,
  applyDisplayRules,
  displayRow,
  type DisplayContext,
} from './applyDisplayRules.ts';

const ctx: DisplayContext = {
  now: new Date('2026-11-12T10:00:00Z'),
  timeZone: 'Asia/Jerusalem',
  userId: 'u-me',
};

const row = {
  id: 'i1',
  title: 'Algorithms homework 3',
  status: 'open',
  kind: 'assignment',
  priority: 2,
  dueAt: '2026-11-12T21:30:00.000Z', // 23:30 in Jerusalem
  startAt: null,
  allDay: false,
  labels: ['exam', 'Course A'],
  assignees: ['u-me', 'u-2'],
  source: { provider: 'moodle', key: null, url: 'https://moodle.example/1' },
  overlay: { pinned: true, hidden: null },
  props: { points: 10, tags: ['x'] },
};

const covered = new Set<Operator>();

/** Whether a rule on `row` matches: one rule whose effect is a badge. */
function matches(rule: Rule, target: object = row, context: DisplayContext = ctx): boolean {
  covered.add(rule.operator);
  return displayRow(target, [{ if: rule, then: { badge: 'hit' } }], context).badges.length === 1;
}

describe('operators (the server’s list, so the two never drift)', () => {
  it('has an evaluator for exactly the operators the server allows', () => {
    assert.deepEqual(Object.keys(OPERATOR_EVALUATORS).sort(), [...OPERATORS].sort());
  });

  it('= and != on text, numbers, nested fields and booleans', () => {
    assert.equal(matches({ field: 'status', operator: '=', value: 'open' }), true);
    assert.equal(matches({ field: 'status', operator: '=', value: 'done' }), false);
    assert.equal(matches({ field: 'source.provider', operator: '=', value: 'moodle' }), true);
    assert.equal(matches({ field: 'priority', operator: '=', value: 2 }), true);
    assert.equal(matches({ field: 'status', operator: '!=', value: 'done' }), true);
    assert.equal(matches({ field: 'status', operator: '!=', value: 'open' }), false);
    // A missing boolean reads as false, as the server compiles it.
    assert.equal(matches({ field: 'overlay.pinned', operator: '=', value: true }), true);
    assert.equal(matches({ field: 'overlay.hidden', operator: '=', value: false }), true);
    assert.equal(matches({ field: 'overlay.hidden', operator: '!=', value: true }), true);
    assert.equal(matches({ field: 'overlay.pinned', operator: '!=', value: false }), true);
    // A missing field differs from any value.
    assert.equal(matches({ field: 'nothing', operator: '!=', value: 'x' }), true);
  });

  it('<, <=, >, >= on numbers and dates; never on a missing value', () => {
    assert.equal(matches({ field: 'priority', operator: '<', value: 3 }), true);
    assert.equal(matches({ field: 'priority', operator: '<=', value: 2 }), true);
    assert.equal(matches({ field: 'priority', operator: '>', value: 2 }), false);
    assert.equal(matches({ field: 'priority', operator: '>=', value: 2 }), true);
    assert.equal(
      matches({ field: 'dueAt', operator: '>', value: '2026-11-12T00:00:00+02:00' }),
      true,
    );
    assert.equal(matches({ field: 'dueAt', operator: '<', value: '@now' }), false);
    assert.equal(matches({ field: 'startAt', operator: '<', value: '@now' }), false);
    assert.equal(matches({ field: 'startAt', operator: '>=', value: '@now' }), false);
  });

  it('in and notIn on values and lists (a list field matches by any item)', () => {
    assert.equal(
      matches({ field: 'status', operator: 'in', value: ['open', 'in_progress'] }),
      true,
    );
    assert.equal(matches({ field: 'status', operator: 'in', value: 'open' }), true);
    assert.equal(matches({ field: 'labels', operator: 'in', value: ['exam', 'quiz'] }), true);
    assert.equal(matches({ field: 'status', operator: 'notIn', value: ['done'] }), true);
    assert.equal(matches({ field: 'labels', operator: 'notIn', value: ['exam'] }), false);
    assert.equal(matches({ field: 'nothing', operator: 'notIn', value: ['x'] }), true);
    assert.equal(matches({ field: 'status', operator: 'in', value: [] }), false);
  });

  it('contains: an item of a list, or text anywhere in a string, ignoring case', () => {
    assert.equal(matches({ field: 'labels', operator: 'contains', value: 'exam' }), true);
    assert.equal(matches({ field: 'labels', operator: 'contains', value: 'ex' }), false);
    assert.equal(matches({ field: 'title', operator: 'contains', value: 'HOMEWORK' }), true);
    assert.equal(matches({ field: 'assignees', operator: 'contains', value: '@me' }), true);
  });

  it('beginsWith: the start of a string, ignoring case', () => {
    assert.equal(matches({ field: 'title', operator: 'beginsWith', value: 'algo' }), true);
    assert.equal(matches({ field: 'title', operator: 'beginsWith', value: 'homework' }), false);
  });

  it('null and notNull (an empty list counts as null)', () => {
    assert.equal(matches({ field: 'startAt', operator: 'null' }), true);
    assert.equal(matches({ field: 'nothing', operator: 'null' }), true);
    assert.equal(matches({ field: 'dueAt', operator: 'notNull' }), true);
    assert.equal(matches({ field: 'labels', operator: 'notNull' }), true);
    assert.equal(matches({ field: 'empty', operator: 'null' }, { ...row, empty: [] }), true);
  });

  it('within: a date preset in the workspace’s time zone, or a {from, to} variable', () => {
    assert.equal(matches({ field: 'dueAt', operator: 'within', value: 'today' }), true);
    assert.equal(matches({ field: 'dueAt', operator: 'within', value: 'tomorrow' }), false);
    assert.equal(matches({ field: 'dueAt', operator: 'within', value: 'this_week' }), true);
    const vars = { range: { from: '2026-11-12T21:00:00Z', to: '2026-11-12T22:00:00Z' } };
    assert.equal(
      matches({ field: 'dueAt', operator: 'within', value: '$page.range' }, row, { ...ctx, vars }),
      true,
    );
    assert.equal(matches({ field: 'dueAt', operator: 'within', value: 'soon' }), false);
  });

  it('between: two dates, both included', () => {
    assert.equal(
      matches({
        field: 'dueAt',
        operator: 'between',
        value: ['2026-11-12T21:30:00Z', '2026-11-13T00:00:00Z'],
      }),
      true,
    );
    assert.equal(
      matches({ field: 'dueAt', operator: 'between', value: ['@today', '@now'] }),
      false,
    );
    assert.equal(matches({ field: 'dueAt', operator: 'between', value: ['@today'] }), false);
  });

  it('H4 text and list operators', () => {
    assert.equal(matches({ field: 'title', operator: 'notContains', value: 'homework' }), false);
    assert.equal(matches({ field: 'title', operator: 'notContains', value: 'quiz' }), true);
    assert.equal(matches({ field: 'labels', operator: 'notContains', value: 'exam' }), false);
    assert.equal(matches({ field: 'title', operator: 'endsWith', value: ' 3' }), true);
    assert.equal(matches({ field: 'title', operator: 'endsWith', value: 'work' }), false);
    assert.equal(
      matches({ field: 'labels', operator: 'allOf', value: ['exam', 'course a'] }),
      false,
    );
    assert.equal(
      matches({ field: 'labels', operator: 'allOf', value: ['exam', 'Course A'] }),
      true,
    );
    assert.equal(matches({ field: 'labels', operator: 'noneOf', value: ['quiz'] }), true);
    assert.equal(matches({ field: 'labels', operator: 'noneOf', value: ['exam'] }), false);
  });

  it('H4 number and date operators, in the workspace time zone', () => {
    assert.equal(matches({ field: 'priority', operator: 'between', value: [1, 3] }), true);
    assert.equal(matches({ field: 'priority', operator: 'notBetween', value: [1, 3] }), false);
    assert.equal(matches({ field: 'priority', operator: 'notBetween', value: [3, 4] }), true);
    // Due 23:30 on 12 Nov, Jerusalem; "now" is 12:00 that day.
    assert.equal(matches({ field: 'dueAt', operator: 'on', value: '2026-11-12T08:00:00Z' }), true);
    assert.equal(
      matches({ field: 'dueAt', operator: 'notOn', value: '2026-11-12T08:00:00Z' }),
      false,
    );
    assert.equal(matches({ field: 'dueAt', operator: 'on', value: '2026-11-13T08:00:00Z' }), false);
    assert.equal(matches({ field: 'dueAt', operator: 'inNext', value: [1, 'days'] }), true);
    assert.equal(matches({ field: 'dueAt', operator: 'notInNext', value: [1, 'days'] }), false);
    assert.equal(matches({ field: 'dueAt', operator: 'inLast', value: [3, 'days'] }), true);
    assert.equal(matches({ field: 'dueAt', operator: 'notInLast', value: [3, 'days'] }), false);
    assert.equal(matches({ field: 'dueAt', operator: 'moreThanAgo', value: [1, 'days'] }), false);
    assert.equal(matches({ field: 'startAt', operator: 'inNext', value: [1, 'days'] }), false);
    assert.equal(matches({ field: 'dueAt', operator: 'inNext', value: [1, 'years'] }), false);
  });

  it('H4 attribute fields read the overlay; the built-in Importance reads 3 when unset', () => {
    const rated = { ...row, overlay: { pinned: null, attrs: { stars: 4 } } };
    assert.equal(matches({ field: 'attr.stars', operator: '>=', value: 4 }, rated), true);
    assert.equal(matches({ field: 'attr.stars', operator: '>=', value: 5 }, rated), false);
    assert.equal(matches({ field: 'attr.importance', operator: '=', value: 3 }, rated), true);
    assert.equal(matches({ field: 'attr.stars', operator: 'null' }, row), true);
  });

  after(() => {
    assert.deepEqual([...covered].sort(), [...OPERATORS].sort(), 'a test for every operator');
  });
});

describe('date tokens across local midnight (Asia/Jerusalem)', () => {
  const late = { dueAt: '2026-11-12T21:30:00.000Z' }; // 23:30 on 12 Nov
  const before = { ...ctx, now: new Date('2026-11-12T21:59:00Z') }; // 23:59 on 12 Nov
  const after = { ...ctx, now: new Date('2026-11-12T22:01:00Z') }; // 00:01 on 13 Nov

  it('@today is local midnight: due today until midnight, before today right after it', () => {
    const rule: Rule = { field: 'dueAt', operator: '<', value: '@today' };
    assert.equal(matches(rule, late, before), false);
    assert.equal(matches(rule, late, after), true);
  });

  it('within today follows the local day', () => {
    const rule: Rule = { field: 'dueAt', operator: 'within', value: 'today' };
    assert.equal(matches(rule, late, before), true);
    assert.equal(matches(rule, late, after), false);
  });

  it('@now is the instant', () => {
    const rule: Rule = { field: 'dueAt', operator: '<', value: '@now' };
    assert.equal(matches(rule, late, before), true);
    assert.equal(matches(rule, { dueAt: '2026-11-12T22:00:00.000Z' }, before), false);
  });

  it('the DST end day (25 hours) is one day', () => {
    const day = { ...ctx, now: new Date('2026-10-25T10:00:00Z') };
    const rule: Rule = { field: 'dueAt', operator: 'within', value: 'today' };
    assert.equal(matches(rule, { dueAt: '2026-10-24T21:00:00Z' }, day), true); // 00:00 local
    assert.equal(matches(rule, { dueAt: '2026-10-25T21:59:00Z' }, day), true); // 23:59 local
    assert.equal(matches(rule, { dueAt: '2026-10-25T22:00:00Z' }, day), false); // 00:00 the 26th
  });
});

describe('applyDisplayRules', () => {
  const rules: DisplayRule[] = [
    { if: { field: 'dueAt', operator: '<', value: '@now' }, then: { tone: 'destructive' } },
    { if: { field: 'status', operator: '=', value: 'done' }, then: { hide: true } },
    { if: { field: 'status', operator: '=', value: 'done' }, then: { tone: 'muted' } },
    { if: { field: 'labels', operator: 'contains', value: 'exam' }, then: { badge: 'Exam' } },
    { if: { field: 'priority', operator: '>=', value: 2 }, then: { badge: 'P2+' } },
    { if: { field: 'priority', operator: '>=', value: 1 }, then: { badge: 'P2+' } },
  ];
  const rows = [
    { id: 'overdue', dueAt: '2026-11-11T08:00:00Z', status: 'open', labels: ['exam'], priority: 3 },
    { id: 'done', dueAt: '2026-11-20T08:00:00Z', status: 'done', labels: [], priority: 0 },
    { id: 'plain', dueAt: null, status: 'open', labels: [], priority: null },
  ];

  it('gives each row its tone, badges and whether it is hidden, in order', () => {
    const shown = applyDisplayRules(rows, rules, ctx);
    assert.deepEqual(
      shown.map(({ row: r, tone, badges, hidden }) => ({ id: r.id, tone, badges, hidden })),
      [
        { id: 'overdue', tone: 'destructive', badges: ['Exam', 'P2+'], hidden: false },
        { id: 'done', tone: 'muted', badges: [], hidden: true },
        { id: 'plain', tone: undefined, badges: [], hidden: false },
      ],
    );
  });

  it('the first matching tone wins; badges are listed once', () => {
    const shown = displayRow(
      { status: 'done', dueAt: '2026-11-01T00:00:00Z' },
      [
        { if: { field: 'status', operator: '=', value: 'done' }, then: { tone: 'muted' } },
        { if: { field: 'dueAt', operator: '<', value: '@now' }, then: { tone: 'destructive' } },
      ],
      ctx,
    );
    assert.equal(shown.tone, 'muted');
  });

  it('keeps the row itself untouched, its own `hidden` field included', () => {
    const container = { id: 'c1', name: 'Course A', hidden: true };
    const [shown] = applyDisplayRules([container], [], ctx);
    assert.ok(shown);
    assert.equal(shown.row, container);
    assert.equal(shown.hidden, false);
    assert.equal(container.hidden, true);
  });

  it('without rules, every row is shown as it is', () => {
    assert.deepEqual(
      applyDisplayRules(rows, undefined, ctx).map((entry) => entry.hidden),
      [false, false, false],
    );
  });

  it('a rule on an unset page variable does nothing', () => {
    const rule: DisplayRule = {
      if: { field: 'status', operator: '=', value: '$page.status' },
      then: { hide: true },
    };
    assert.equal(displayRow(row, [rule], ctx).hidden, false);
    assert.equal(displayRow(row, [rule], { ...ctx, vars: { status: null } }).hidden, false);
    assert.equal(displayRow(row, [rule], { ...ctx, vars: { status: 'open' } }).hidden, true);
  });

  it('never reads through a prototype', () => {
    assert.equal(matches({ field: 'constructor', operator: 'notNull' }, {}), false);
    assert.equal(matches({ field: '__proto__.x', operator: 'null' }, {}), true);
    assert.equal(matches({ field: 'title.length', operator: '>', value: 1 }), false);
  });
});
