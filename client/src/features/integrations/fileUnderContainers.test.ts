import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactRuleFor } from '@api-types/topicRules.ts';
import type { FacetContainer } from '@api-types/items.ts';
import { containersOf } from './fileUnderContainers.ts';

function container(id: string, name: string, integrationId: string): FacetContainer {
  return {
    id,
    name,
    matchKey: name,
    type: 'calendar',
    topicId: null,
    provider: 'google_calendar',
    integrationId,
    externalId: id,
  };
}

test('a container rule is the exact, case-insensitive match key', () => {
  assert.equal(exactRuleFor([{ match: 'BRAUDE', topicId: 's' }], 'braude')?.topicId, 's');
});

test('a glob is not an exact rule', () => {
  assert.equal(exactRuleFor([{ match: '*braude*', topicId: 's' }], 'braude'), null);
});

test('containersOf keeps one connection and sorts by name, ignoring case', () => {
  const all = [
    container('1', 'Beta', 'a'),
    container('2', 'other', 'b'),
    container('3', 'alpha', 'a'),
  ];
  assert.deepEqual(
    containersOf(all, 'a').map((c) => c.name),
    ['alpha', 'Beta'],
  );
});
