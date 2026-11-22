import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeScopes,
  selectedContainers,
  ticksEverySource,
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

describe('ticking every source', () => {
  const own = ['i-1', 'i-2'];
  it('is true when all own connections and local are ticked', () => {
    assert.equal(
      ticksEverySource(
        { connectors: ['local', 'i-2', 'i-1'], connectorScopes: undefined },
        own,
        'local',
      ),
      true,
    );
  });
  it('is false when one is missing, or on All sources already, or with no own connection', () => {
    assert.equal(
      ticksEverySource({ connectors: ['i-1', 'i-2'], connectorScopes: undefined }, own, 'local'),
      false,
    );
    assert.equal(
      ticksEverySource({ connectors: undefined, connectorScopes: undefined }, own, 'local'),
      false,
    );
    assert.equal(
      ticksEverySource({ connectors: ['local'], connectorScopes: undefined }, [], 'local'),
      false,
    );
  });
  it('is false when a connection is narrowed to some containers', () => {
    assert.equal(
      ticksEverySource(
        { connectors: ['i-1', 'i-2', 'local'], connectorScopes: { 'i-1': ['a'] } },
        own,
        'local',
      ),
      false,
    );
  });
  it('ignores another member’s connector also on the block', () => {
    assert.equal(
      ticksEverySource(
        { connectors: ['i-1', 'i-2', 'local', 'dana'], connectorScopes: undefined },
        own,
        'local',
      ),
      true,
    );
  });
});
