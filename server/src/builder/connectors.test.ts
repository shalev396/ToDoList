import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { storedConnectorScopes, withoutConnector } from './connectors.js';

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
