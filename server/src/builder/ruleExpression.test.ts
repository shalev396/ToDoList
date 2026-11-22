/**
 * filterExpression on a real mongod: for every operator the rule compiler allows, on every kind of
 * field, the expression is true for exactly the documents the compiled `$match` matches, missing
 * fields, nulls, lists, empty lists and values of another type included. And a user's text that
 * starts with `$` stays text.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ItemAccessFilter } from '../classes/policies/ItemAccessFilter.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Rule, RuleGroup } from '../types/builder.js';
import { compileQuery, type CompileContext } from './compile.js';
import { FilterExpressionError, filterExpression } from './ruleExpression.js';

type Doc = Record<string, unknown>;

const NOW = new Date('2026-11-11T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

/** Every shape a field can come in: values, null, missing, lists, empty lists, other types. */
const DOCS: Doc[] = [
  {
    _id: 'd1',
    status: 'done',
    title: 'Plan',
    labels: ['a', 'B'],
    priority: 3,
    dueAt: at(-DAY),
    allDay: true,
    props: { x: 5 },
    topicId: 't1',
  },
  {
    _id: 'd2',
    status: 'open',
    title: 'plan the week',
    labels: ['c'],
    priority: 1,
    dueAt: at(2 * DAY),
    allDay: false,
    props: { x: 'five' },
    topicId: null,
  },
  {
    _id: 'd3',
    status: null,
    title: null,
    labels: [],
    priority: null,
    dueAt: null,
    allDay: null,
    props: { x: null },
  },
  { _id: 'd4' },
  {
    _id: 'd5',
    status: 'in_progress',
    title: '$title',
    labels: 'a',
    priority: '3',
    dueAt: '2026-11-10T08:00:00Z',
    allDay: 'true',
    props: { x: ['five', 7] },
    topicId: 't2',
  },
  { _id: 'd6', title: 42, labels: ['A'], priority: 4.5, dueAt: at(10 * DAY), props: { x: true } },
  {
    _id: 'd7',
    status: 'cancelled',
    title: 'AN END',
    labels: [null],
    priority: -1,
    dueAt: at(-5 * DAY),
    props: { x: NOW },
  },
  {
    _id: 'd8',
    title: 'xPlANx',
    labels: ['a', 'a'],
    priority: 0,
    dueAt: at(HOUR / 2),
    props: { x: 10 },
  },
];

const ISO = at(-DAY).toISOString();
const LATER = at(3 * DAY).toISOString();

/** [field, operator, value] for every operator, on every type the catalog has. */
const CASES: [string, Rule['operator'], unknown][] = [
  ['status', '=', 'done'],
  ['status', '!=', 'done'],
  ['status', 'in', ['open', 'done']],
  ['status', 'notIn', ['open']],
  ['status', 'null', undefined],
  ['status', 'notNull', undefined],
  ['topic', '=', 't1'],
  ['topic', 'null', undefined],
  ['title', '=', 'Plan'],
  ['title', '!=', 'Plan'],
  ['title', '=', '$title'],
  ['title', 'contains', 'pla'],
  ['title', 'notContains', 'pla'],
  ['title', 'beginsWith', 'pl'],
  ['title', 'endsWith', 'AN'],
  ['title', 'contains', '$t'],
  ['title', 'in', ['Plan', 'AN END']],
  ['title', 'notIn', ['Plan']],
  ['title', 'null', undefined],
  ['title', 'notNull', undefined],
  ['labels', 'contains', 'a'],
  ['labels', 'notContains', 'a'],
  ['labels', 'in', ['a', 'z']],
  ['labels', 'allOf', ['a', 'B']],
  ['labels', 'noneOf', ['a']],
  ['labels', 'null', undefined],
  ['labels', 'notNull', undefined],
  ['priority', '<', 3],
  ['priority', '<=', 3],
  ['priority', '>', 1],
  ['priority', '>=', 1],
  ['priority', 'between', [1, 3]],
  ['priority', 'notBetween', [1, 3]],
  ['priority', 'in', [1, 4.5]],
  ['priority', 'notIn', [1]],
  ['priority', 'null', undefined],
  ['priority', 'notNull', undefined],
  ['dueAt', '<', ISO],
  ['dueAt', '>=', '@now'],
  ['dueAt', 'on', ISO],
  ['dueAt', 'notOn', ISO],
  ['dueAt', 'within', 'this_week'],
  ['dueAt', 'between', [ISO, LATER]],
  ['dueAt', 'notBetween', [ISO, LATER]],
  ['dueAt', 'inLast', [3, 'days']],
  ['dueAt', 'notInLast', [3, 'days']],
  ['dueAt', 'inNext', [3, 'days']],
  ['dueAt', 'notInNext', [3, 'days']],
  ['dueAt', 'moreThanAgo', [2, 'days']],
  ['dueAt', 'null', undefined],
  ['dueAt', 'notNull', undefined],
  ['allDay', '=', true],
  ['allDay', '!=', true],
  ['allDay', '=', false],
  ['allDay', '!=', false],
  ['props.x', '=', 5],
  ['props.x', '=', 'five'],
  ['props.x', '!=', 5],
  ['props.x', '<', 10],
  ['props.x', '>', 'b'],
  ['props.x', 'contains', 'iv'],
  ['props.x', 'in', [5, 'five']],
  ['props.x', 'notIn', [5]],
  ['props.x', 'between', [1, 10]],
  ['props.x', 'null', undefined],
  ['props.x', 'notNull', undefined],
];

const CONTEXT: CompileContext = {
  ws: { id: 'w-expr' },
  userId: 'u-1',
  access: { userId: 'u-1', integrations: [], local: 'visible' },
  vars: {},
  now: NOW,
  timeZone: 'Asia/Jerusalem',
  weekStart: 'sun',
  preview: false,
};

let db: TestDatabase;
let ids: (match: Doc) => Promise<string[]>;

before(async () => {
  db = await startTestDatabase('todolist_rule_expression');
  const mongoose = (await import('mongoose')).default;
  const collection = mongoose.connection.collection('ExpressionProbe');
  await collection.insertMany(DOCS);
  ids = async (match): Promise<string[]> =>
    (await collection.find(match).toArray()).map((doc) => String(doc._id)).sort();
});

after(async () => {
  await db.stop();
});

/** The compiled `$match` of a where group: the stage right before H5's absorption. */
function compiledFilter(where: RuleGroup): Doc {
  const { pipeline } = compileQuery({ source: 'items', where }, CONTEXT);
  const at = pipeline.findIndex((stage) => ItemAccessFilter.isCopyAbsorption(stage));
  const stage = pipeline[at - 1];
  assert.ok(stage !== undefined && '$match' in stage);
  return stage['$match'] as Doc;
}

async function agree(where: RuleGroup, label: string): Promise<void> {
  const filter = compiledFilter(where);
  const matched = await ids(filter);
  const computed = await ids({ $expr: filterExpression(filter) });
  assert.deepEqual(computed, matched, `${label}: ${JSON.stringify(filter)}`);
}

describe('filterExpression', () => {
  it('agrees with $match for every operator on every kind of field', async () => {
    let nonTrivial = 0;
    for (const [field, operator, value] of CASES) {
      const rule = { field, operator, ...(value === undefined ? {} : { value }) } as Rule;
      const where: RuleGroup = { combinator: 'and', rules: [rule] };
      await agree(where, `${field} ${operator} ${JSON.stringify(value)}`);
      const matched = (await ids(compiledFilter(where))).length;
      if (matched > 0 && matched < DOCS.length) nonTrivial += 1;
    }
    // Not vacuous: most cases split the documents.
    assert.ok(nonTrivial > CASES.length / 2, String(nonTrivial));
  });

  it('agrees for and, or and not groups', async () => {
    const done: Rule = { field: 'status', operator: '=', value: 'done' };
    const soon: Rule = { field: 'dueAt', operator: 'inNext', value: [3, 'days'] };
    const labelled: Rule = { field: 'labels', operator: 'contains', value: 'a' };
    await agree({ combinator: 'or', rules: [done, soon] }, 'or');
    await agree(
      { combinator: 'and', rules: [labelled, { combinator: 'or', rules: [done, soon] }] },
      'and',
    );
    await agree({ combinator: 'or', not: true, rules: [done, labelled] }, 'not');
  });

  it('keeps a user’s text that starts with $ as text, never a field', async () => {
    const filter = compiledFilter({
      combinator: 'and',
      rules: [{ field: 'title', operator: '=', value: '$title' }],
    });
    assert.deepEqual(await ids({ $expr: filterExpression(filter) }), ['d5']);
  });

  it('refuses a shape the rule compiler never emits', () => {
    assert.throws(() => filterExpression({ $where: 'true' }), FilterExpressionError);
    assert.throws(() => filterExpression({ title: { $elemMatch: {} } }), FilterExpressionError);
    assert.throws(() => filterExpression({ labels: ['a'] }), FilterExpressionError);
  });
});
