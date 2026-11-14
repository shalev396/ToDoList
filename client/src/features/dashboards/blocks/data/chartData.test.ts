import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { segmentsTotal, toSegments } from './chartData.ts';

describe('toSegments', () => {
  it('orders sources by slot and the total equals the sum of the segments', () => {
    const segments = toSegments([
      { key: { 'source.provider': 'github' }, value: 4 },
      { key: { 'source.provider': 'jira' }, value: 9 },
      { key: { 'source.provider': 'local' }, value: 2 },
      { key: { 'source.provider': 'moodle' }, value: 0 },
    ]);
    assert.deepEqual(
      segments.map((segment) => segment.key),
      ['jira', 'github', 'local'],
    );
    assert.equal(segmentsTotal(segments), 15);
  });

  it('orders other groups by value and drops non-numeric values', () => {
    const segments = toSegments([
      { key: { status: 'done' }, value: 1 },
      { key: { status: 'open' }, value: 5 },
      { key: { status: 'x' }, value: '7' },
      { key: { status: null }, value: null },
    ]);
    assert.deepEqual(
      segments.map((segment): unknown[] => [segment.key, segment.value, segment.provider]),
      [
        ['open', 5, undefined],
        ['done', 1, undefined],
      ],
    );
    assert.equal(segmentsTotal(segments), 6);
  });

  it('is empty without groups', () => {
    assert.deepEqual(toSegments([]), []);
    assert.equal(segmentsTotal([]), 0);
  });
});
