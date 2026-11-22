import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindTemplateConnectors, storedConnectorScopes, withoutConnector } from './connectors.js';
import type { Block } from '../types/builder.js';

describe('connector scopes on stored blocks', () => {
  it('reads the lists of ids, and nothing else', () => {
    assert.equal(storedConnectorScopes({ id: 'b' }), undefined);
    assert.equal(storedConnectorScopes({ connectorScopes: ['x'] }), undefined);
    assert.deepEqual(
      storedConnectorScopes({ connectorScopes: { a: ['c-1', 2, 'c-2'], b: 'x', c: [] } }),
      { a: ['c-1', 'c-2'] },
    );
  });

  it('a connector taken off a block takes its scope with it', () => {
    const [kept, dropped, untouched] = withoutConnector(
      [
        { id: 'b1', connectors: ['i-1', 'i-2'], connectorScopes: { 'i-1': ['c'], 'i-2': ['d'] } },
        { id: 'b2', connectors: ['i-1'], connectorScopes: { 'i-1': ['c'] } },
        { id: 'b3', connectors: ['i-2'], connectorScopes: { 'i-2': ['d'] } },
      ],
      'i-1',
    );
    assert.deepEqual(kept, {
      id: 'b1',
      connectors: ['i-2'],
      connectorScopes: { 'i-2': ['d'] },
      sourceRemoved: true,
    });
    assert.deepEqual(dropped, { id: 'b2', connectors: [], sourceRemoved: true });
    assert.deepEqual(untouched, {
      id: 'b3',
      connectors: ['i-2'],
      connectorScopes: { 'i-2': ['d'] },
    });
  });
});

describe('binding a template to the member own integrations', () => {
  const integrations = [
    { id: 'i-gh', provider: 'github' as const },
    { id: 'i-jira', provider: 'jira' as const },
  ];
  const everything = {
    id: 'all',
    type: 'list',
    query: { source: 'items' },
  } as unknown as Block;
  const noStaticFilter = {
    id: 'or',
    type: 'list',
    query: {
      source: 'items',
      where: {
        combinator: 'or',
        rules: [{ field: 'source.provider', operator: '=', value: 'jira' }],
      },
    },
  } as unknown as Block;
  const narrow = {
    id: 'jira',
    type: 'list',
    query: {
      source: 'items',
      where: {
        combinator: 'and',
        rules: [{ field: 'source.provider', operator: '=', value: 'jira' }],
      },
    },
  } as unknown as Block;

  it('leaves a block that names no provider on All sources (no connectors field)', () => {
    const bound = bindTemplateConnectors({ blocks: [everything, noStaticFilter] }, integrations);
    assert.deepEqual(
      bound.blocks.map((block) => 'connectors' in block),
      [false, false],
    );
  });

  it('binds a block with provider hints to the matching integrations (it is narrow by intent)', () => {
    const bound = bindTemplateConnectors({ blocks: [narrow] }, integrations);
    assert.deepEqual(bound.blocks[0]?.connectors, ['i-jira']);
  });
});
