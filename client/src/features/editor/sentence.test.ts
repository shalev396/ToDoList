import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Query } from '@api-types/builder.ts';
import {
  addRule,
  fromSentence,
  removeClause,
  replaceRule,
  setKinds,
  setProviders,
  setSort,
  templateParts,
  toSentence,
  type Sentence,
} from './sentence.ts';
import { defaultValue, fitsOperator, valueAfterOperatorChange, valueKind } from './ruleValue.ts';

function read(query: Query): Sentence {
  const result = toSentence(query);
  assert.ok(result.ok, JSON.stringify(result));
  return result.sentence;
}

const SHOWCASE: Query = {
  source: 'items',
  where: {
    combinator: 'and',
    rules: [
      { field: 'kind', operator: 'in', value: ['task'] },
      { field: 'source.provider', operator: 'in', value: ['clickup', 'jira'] },
      { field: 'status', operator: '!=', value: 'done' },
      { field: 'dueAt', operator: 'inNext', value: [7, 'days'] },
    ],
  },
  sort: [{ field: 'importance', dir: 'desc' }],
  limit: 30,
  dateRange: 'this_week',
};

describe('sentence round trip', () => {
  const QUERIES: [string, Query][] = [
    ['the showcase sentence', SHOWCASE],
    ['no filter at all', { source: 'items' }],
    ['only a sort', { source: 'items', sort: [{ field: 'dueAt', dir: 'asc' }] }],
    [
      'rules in an unusual order, a second kind rule, a var',
      {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [
            { field: 'title', operator: 'notContains', value: 'x' },
            { field: 'source.provider', operator: 'in', value: ['jira'] },
            { field: 'kind', operator: 'in', value: ['issue', 'pr'] },
            { field: 'kind', operator: '=', value: 'issue' },
            { field: 'topic', operator: '=', value: '$page.topic' },
            { field: 'labels', operator: 'allOf', value: ['a', 'b'] },
            { field: 'priority', operator: 'notBetween', value: [1, 3] },
            { field: 'dueAt', operator: 'null' },
          ],
        },
        sort: [
          { field: 'attr.importance', dir: 'desc' },
          { field: 'dueAt', dir: 'asc' },
        ],
      },
    ],
    [
      'a single-rule OR is the same as AND',
      {
        source: 'items',
        where: { combinator: 'or', rules: [{ field: 'status', operator: '=', value: 'open' }] },
      },
    ],
  ];

  for (const [name, query] of QUERIES) {
    it(`${name}: query → sentence → query is exact (AND of one rule aside)`, () => {
      const back = fromSentence(query, read(query));
      const expected =
        query.where?.combinator === 'or'
          ? { ...query, where: { ...query.where, combinator: 'and' } }
          : query;
      assert.deepEqual(back, expected);
    });

    it(`${name}: sentence → query → sentence is exact`, () => {
      const sentence = read(query);
      assert.deepEqual(read(fromSentence(query, sentence)), sentence);
    });
  }

  it('keeps every part of the query the sentence does not show', () => {
    const next = fromSentence(SHOWCASE, setProviders(read(SHOWCASE), ['jira']));
    assert.equal(next.limit, 30);
    assert.equal(next.dateRange, 'this_week');
    assert.deepEqual(next.sort, SHOWCASE.sort);
  });
});

describe('sentence slots', () => {
  it('reads the slots from the rules', () => {
    const sentence = read(SHOWCASE);
    assert.deepEqual(
      sentence.clauses.map((clause) => clause.type),
      ['kinds', 'providers', 'rule', 'rule'],
    );
    assert.deepEqual(sentence.sort, { field: 'importance', dir: 'desc' });
  });

  it('setKinds replaces in place, removes when empty, and inserts first', () => {
    const sentence = read(SHOWCASE);
    const changed = setKinds(sentence, ['task', 'issue']);
    assert.deepEqual(changed.clauses[0], { type: 'kinds', values: ['task', 'issue'] });
    assert.equal(changed.clauses.length, 4);
    const removed = setKinds(sentence, []);
    assert.equal(removed.clauses.length, 3);
    const inserted = setKinds(removed, ['event']);
    assert.deepEqual(inserted, {
      ...sentence,
      clauses: [{ type: 'kinds', values: ['event'] }, ...removed.clauses],
    });
  });

  it('setProviders inserts after the kinds slot', () => {
    const sentence = setProviders(setKinds(read({ source: 'items' }), ['task']), ['jira']);
    assert.deepEqual(
      sentence.clauses.map((clause) => clause.type),
      ['kinds', 'providers'],
    );
    const noKinds = setProviders(read({ source: 'items' }), ['jira']);
    assert.equal(noKinds.clauses[0]?.type, 'providers');
  });

  it('adds, replaces and removes conditions; the slot clauses are not replaced as rules', () => {
    let sentence = read({ source: 'items' });
    sentence = addRule(sentence, { field: 'status', operator: '=', value: 'open' });
    sentence = replaceRule(sentence, 0, { field: 'status', operator: '!=', value: 'done' });
    assert.deepEqual(fromSentence({ source: 'items' }, sentence).where?.rules, [
      { field: 'status', operator: '!=', value: 'done' },
    ]);
    const slots = read(SHOWCASE);
    assert.deepEqual(replaceRule(slots, 0, { field: 'title', operator: '=', value: 'x' }), slots);
    const empty = removeClause(sentence, 0);
    assert.equal(fromSentence({ source: 'items', where: SHOWCASE.where }, empty).where, undefined);
  });

  it('setSort replaces the first key and drops it from the kept ones', () => {
    const base = read({
      source: 'items',
      sort: [
        { field: 'dueAt', dir: 'asc' },
        { field: 'priority', dir: 'desc' },
      ],
    });
    const next = setSort(base, { field: 'priority', dir: 'asc' });
    assert.deepEqual(next.moreSort, []);
    assert.deepEqual(fromSentence({ source: 'items' }, next).sort, [
      { field: 'priority', dir: 'asc' },
    ]);
    assert.equal(
      fromSentence({ source: 'items', sort: [{ field: 'dueAt', dir: 'asc' }] }, setSort(base, null))
        .sort?.length,
      1,
    );
  });
});

describe('queries the sentence cannot show', () => {
  it('reports why, so the editor offers Advanced', () => {
    const rule = { field: 'status', operator: '=', value: 'open' } as const;
    assert.deepEqual(toSentence({ source: 'containers' }), { ok: false, reason: 'containers' });
    assert.deepEqual(
      toSentence({
        source: 'items',
        where: { combinator: 'and', rules: [{ combinator: 'or', rules: [rule, rule] }] },
      }),
      { ok: false, reason: 'groups' },
    );
    assert.deepEqual(
      toSentence({ source: 'items', where: { combinator: 'or', rules: [rule, rule] } }),
      {
        ok: false,
        reason: 'or',
      },
    );
    assert.deepEqual(
      toSentence({ source: 'items', where: { combinator: 'and', not: true, rules: [rule] } }),
      {
        ok: false,
        reason: 'not',
      },
    );
  });
});

describe('templateParts: the language orders the sentence', () => {
  const slots = { kinds: 'K', providers: 'P', rules: 'R', sort: 'S' };
  it('English order', () => {
    assert.deepEqual(
      templateParts('Show {kinds} from {providers}{rules}, sorted by {sort}', slots),
      ['Show ', 'K', ' from ', 'P', 'R', ', sorted by ', 'S'],
    );
  });
  it('Hebrew order is its own, not word by word', () => {
    assert.deepEqual(templateParts('הצג {kinds} מ{providers}{rules}, לפי {sort}', slots), [
      'הצג ',
      'K',
      ' מ',
      'P',
      'R',
      ', לפי ',
      'S',
    ]);
  });
  it('ignores a slot the template omits and unknown slots', () => {
    assert.deepEqual(templateParts('{sort} {nope}', slots), ['S', ' ']);
  });
});

describe('rule values by operator', () => {
  it('knows the value shape of every operator', () => {
    assert.equal(valueKind('inNext'), 'relative');
    assert.equal(valueKind('notBetween'), 'pair');
    assert.equal(valueKind('allOf'), 'list');
    assert.equal(valueKind('notNull'), 'none');
    assert.equal(valueKind('on'), 'date');
    assert.equal(valueKind('endsWith'), 'single');
  });

  it('defaults and keeps values when switching operators', () => {
    assert.deepEqual(defaultValue('inLast', 'date'), [7, 'days']);
    assert.deepEqual(defaultValue('between', 'number'), [0, 10]);
    assert.deepEqual(defaultValue('between', 'date'), ['@today', '@today']);
    assert.equal(defaultValue('null', 'date'), undefined);
    assert.equal(defaultValue('=', 'enum', ['open', 'done']), 'open');
    // Same kind: kept. A different kind: the new default.
    assert.equal(valueAfterOperatorChange('=', '!=', 'open', 'enum'), 'open');
    assert.deepEqual(valueAfterOperatorChange('inLast', 'inNext', [3, 'weeks'], 'date'), [
      3,
      'weeks',
    ]);
    assert.deepEqual(valueAfterOperatorChange('=', 'inNext', '@today', 'date'), [7, 'days']);
    assert.equal(valueAfterOperatorChange('=', 'null', 'x', 'string'), undefined);
    assert.equal(fitsOperator('inNext', [7, 'days']), true);
    assert.equal(fitsOperator('inNext', ['7', 'days']), false);
  });
});
