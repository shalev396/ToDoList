import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeScopes,
  selectedContainers,
  toggleConnector,
  toggleContainer,
  type SourcePick,
} from './connectorScopes.ts';

const ALL = ['a', 'b', 'c'];

describe('connector scopes', () => {
  it('reads every container without an entry', () => {
    assert.deepEqual(selectedContainers(undefined, 'g', ALL), ALL);
    assert.deepEqual(selectedContainers({ g: ['b'] }, 'g', ALL), ['b']);
  });
  it('unticking one of all makes an entry with the rest', () => {
    const pick: SourcePick = { connectors: ['g'], connectorScopes: undefined };
    assert.deepEqual(toggleContainer(pick, 'g', ALL, 'b', false), {
      connectors: ['g'],
      connectorScopes: { g: ['a', 'c'] },
    });
  });
  it('ticking the last missing container drops the entry', () => {
    const pick: SourcePick = { connectors: ['g'], connectorScopes: { g: ['a', 'c'] } };
    assert.deepEqual(toggleContainer(pick, 'g', ALL, 'b', true), {
      connectors: ['g'],
      connectorScopes: undefined,
    });
  });
  it('unticking the last container unticks the connector and drops its entry', () => {
    const pick: SourcePick = { connectors: ['g', 'x'], connectorScopes: { g: ['a'], x: ['q'] } };
    assert.deepEqual(toggleContainer(pick, 'g', ALL, 'a', false), {
      connectors: ['x'],
      connectorScopes: { x: ['q'] },
    });
  });
  it('unticking a connector drops its entry; ticking it reads everything', () => {
    const pick: SourcePick = { connectors: ['g'], connectorScopes: { g: ['a'] } };
    assert.deepEqual(toggleConnector(pick, 'g', false), {
      connectors: [],
      connectorScopes: undefined,
    });
    assert.deepEqual(toggleConnector({ connectors: [], connectorScopes: undefined }, 'g', true), {
      connectors: ['g'],
      connectorScopes: undefined,
    });
  });
  it('normalize drops entries of connectors that are gone, and empty ones', () => {
    assert.deepEqual(normalizeScopes({ g: ['a'], x: ['q'], e: [] }, ['g', 'e']), { g: ['a'] });
    assert.equal(normalizeScopes({ g: ['a'] }, ['x']), undefined);
    assert.equal(normalizeScopes({ g: ['a'] }, undefined), undefined);
    assert.equal(normalizeScopes(undefined, ['g']), undefined);
  });
});
