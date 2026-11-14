import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Block } from '@api-types/builder.ts';
import type { PageVars } from './urlVars.ts';
import { blockVarNames, selectBlockVars, varsHash } from './blockVars.ts';

const deadlines: Block = {
  id: 'blk_deadlines',
  type: 'deadlines',
  title: 'Deadlines',
  query: {
    source: 'items',
    where: {
      combinator: 'and',
      rules: [
        { field: 'dueAt', operator: 'notNull' },
        {
          combinator: 'or',
          rules: [
            { field: 'topic', operator: '=', value: '$page.topic' },
            // A list value is literal: `$page.kind` inside it is text, not a reference.
            { field: 'kind', operator: 'in', value: ['$page.kind', 'task'] },
          ],
        },
      ],
    },
    dateRange: '$page.range',
  },
  viz: { kind: 'deadlines' },
  listen: ['$page.provider', '$page.topic'],
};

function vars(entries: Record<string, PageVars[string]>): PageVars {
  return Object.assign(Object.create(null) as Record<string, PageVars[string]>, entries);
}

const page = vars({
  topic: 'work',
  provider: ['jira', 'github'],
  range: 'this_week',
  course: 'c-1',
  kind: 'event',
});

describe('blockVarNames', () => {
  it('lists the variables it listens to and the ones its query refers to, once each', () => {
    assert.deepEqual(blockVarNames(deadlines), ['provider', 'range', 'topic']);
  });

  it('is empty for a block without a query or listen', () => {
    const note: Block = { id: 'blk_note1', type: 'note', title: '', viz: { kind: 'note' } };
    assert.deepEqual(blockVarNames(note), []);
  });
});

describe('selectBlockVars', () => {
  it('sends only those variables, keyed $page.<name>', () => {
    assert.deepEqual(selectBlockVars(deadlines, page), {
      '$page.topic': 'work',
      '$page.provider': ['jira', 'github'],
      '$page.range': 'this_week',
    });
  });

  it('keeps an explicit "unset" (it overrides a default) and leaves out unknown names', () => {
    const selected = selectBlockVars(deadlines, vars({ topic: null, range: 'today' }));
    assert.deepEqual(selected, { '$page.topic': null, '$page.range': 'today' });
  });
});

describe('varsHash', () => {
  const base = varsHash(selectBlockVars(deadlines, page));

  it('ignores variables the block neither listens to nor uses', () => {
    const unrelated = vars({ ...page, course: 'c-2', kind: 'task', type: 'exam' });
    assert.equal(varsHash(selectBlockVars(deadlines, unrelated)), base);
  });

  it('changes with a variable the block listens to or uses', () => {
    assert.notEqual(
      varsHash(selectBlockVars(deadlines, vars({ ...page, provider: 'jira' }))),
      base,
    );
    assert.notEqual(varsHash(selectBlockVars(deadlines, vars({ ...page, range: 'today' }))), base);
  });

  it('does not depend on key order', () => {
    const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' };
    assert.equal(
      varsHash({ '$page.b': 1, '$page.a': range }),
      varsHash({ '$page.a': { to: range.to, from: range.from }, '$page.b': 1 }),
    );
  });

  it('tells a value from a one-item list and null from a missing variable', () => {
    assert.notEqual(varsHash({ '$page.a': 'x' }), varsHash({ '$page.a': ['x'] }));
    assert.notEqual(varsHash({ '$page.a': null }), varsHash({}));
  });
});
