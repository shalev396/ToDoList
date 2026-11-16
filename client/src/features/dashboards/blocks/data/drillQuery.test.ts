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
    assert.deepEqual(query.sort, [{ field: 'dueAt', dir: 'asc' }]);
  });

  it('carries a number as a number (priority)', () => {
    const query = drillQuery({ source: 'items', groupBy: ['priority'] }, 'priority', 2);
    assert.deepEqual(query.where, {
      combinator: 'and',
      rules: [{ field: 'priority', operator: '=', value: 2 }],
    });
  });

  it('carries a boolean as a boolean (allDay)', () => {
    const query = drillQuery({ source: 'items', groupBy: ['allDay'] }, 'allDay', false);
    assert.deepEqual(query.where, {
      combinator: 'and',
      rules: [{ field: 'allDay', operator: '=', value: false }],
    });
  });

  it('does not sort containers by dueAt, which they do not have', () => {
    const query = drillQuery({ source: 'containers', groupBy: ['type'] }, 'type', 'project');
    assert.deepEqual(query.sort, [{ field: 'name', dir: 'asc' }]);
  });
});
