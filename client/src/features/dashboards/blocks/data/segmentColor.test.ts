import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ColourFamily } from '@api-types/colours.ts';
import type { Segment } from './chartData.ts';
import { segmentColor } from './segmentColor.ts';

const familyOf = (topicId: string | null): ColourFamily => (topicId === 'work' ? 'blue' : 'gray');
const base = { raw: null, value: 1, provider: undefined };

test('a topic segment takes its family Scheduled step', () => {
  const segment: Segment = { ...base, field: 'topic', key: 'work' };
  assert.equal(segmentColor(segment, 0, familyOf), 'var(--tc-blue-scheduled)');
});

test('Unsorted (an empty key) is gray', () => {
  const segment: Segment = { ...base, field: 'topic', key: '' };
  assert.equal(segmentColor(segment, 3, familyOf), 'var(--tc-gray-scheduled)');
});

test('a provider segment keeps its source colour', () => {
  const segment: Segment = { ...base, field: 'source.provider', key: 'jira', provider: 'jira' };
  assert.equal(segmentColor(segment, 0, familyOf), 'var(--color-source-jira)');
  const clickup: Segment = {
    ...base,
    field: 'source.provider',
    key: 'clickup',
    provider: 'clickup',
  };
  assert.equal(segmentColor(clickup, 1, familyOf), 'var(--color-source-clickup)');
});

test('a reserved provider (no slot of its own) is muted, not a chart slot', () => {
  const slack: Segment = { ...base, field: 'source.provider', key: 'slack' };
  assert.equal(segmentColor(slack, 2, familyOf), 'var(--color-source-reserved)');
});

test('Your to-dos keep their own source colour', () => {
  const local: Segment = { ...base, field: 'source.provider', key: 'local', provider: 'local' };
  assert.equal(segmentColor(local, 6, familyOf), 'var(--color-source-local)');
});

test('any other field takes the chart slots in order', () => {
  const segment: Segment = { ...base, field: 'status', key: 'open' };
  assert.equal(segmentColor(segment, 0, familyOf), 'var(--chart-1)');
  assert.equal(segmentColor(segment, 7, familyOf), 'var(--chart-1)');
});
