import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { drillQuery } from './drillQuery.ts';

describe('drillQuery', () => {
  it('keeps the filters, adds the segment rule and drops grouping', () => {
    const where = {
      combinator: 'and' as const,
      rules: [{ field: 'status', operator: '=' as const, value: 'open' }],
    };
    const query = drillQuery(
      {
        source: 'items',
        where,
        groupBy: ['source.provider'],
        aggregate: { op: 'count' },
        dateRange: 'today',
      },
      'source.provider',
      'jira',
    );
    assert.equal(query.groupBy, undefined);
    assert.equal(query.aggregate, undefined);
    assert.equal(query.dateRange, 'today');
    assert.equal(query.limit, 20);
    assert.deepEqual(query.where, {
      combinator: 'and',
      rules: [where, { field: 'source.provider', operator: '=', value: 'jira' }],
    });
  });

  it('works without an existing filter', () => {
    const query = drillQuery({ source: 'items', groupBy: ['status'] }, 'status', 'done');
    assert.deepEqual(query.where, {
      combinator: 'and',
      rules: [{ field: 'status', operator: '=', value: 'done' }],
    });
  });
});
