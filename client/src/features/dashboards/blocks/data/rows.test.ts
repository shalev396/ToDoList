import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryRow } from '@api-types/builder.ts';
import { counterValue, dateOf, isItemRow, presetDays } from './rows.ts';

const result = (partial: Partial<QueryResult>): QueryResult => ({
  total: 0,
  appliedVars: {},
  warnings: [],
  ...partial,
});

describe('rows helpers', () => {
  it('tells item rows from container rows', () => {
    assert.equal(isItemRow({ title: 'x', kind: 'task' } as unknown as QueryRow), true);
    assert.equal(isItemRow({ name: 'x', type: 'course' } as unknown as QueryRow), false);
  });

  it('reads dates from ISO strings and ignores bad values', () => {
    assert.equal(dateOf('2026-11-11T10:00:00.000Z')?.getTime(), Date.UTC(2026, 10, 11, 10));
    assert.equal(dateOf('nope'), undefined);
    assert.equal(dateOf(null), undefined);
    assert.equal(dateOf(5), undefined);
  });

  it('the counter reads the one group, else the total, else nothing', () => {
    assert.equal(counterValue(result({ groups: [{ key: {}, value: 7 }], total: 9 })), 7);
    assert.equal(counterValue(result({ total: 4 })), 4);
    assert.equal(
      counterValue(
        result({
          groups: [
            { key: { a: 1 }, value: 1 },
            { key: { a: 2 }, value: 2 },
          ],
        }),
      ),
      undefined,
    );
    assert.equal(counterValue(undefined), undefined);
  });

  it('reads the days of a preset', () => {
    assert.equal(presetDays('upcoming_14d'), 14);
    assert.equal(presetDays('today'), undefined);
    assert.equal(presetDays({ from: 'x' }), undefined);
  });
});
