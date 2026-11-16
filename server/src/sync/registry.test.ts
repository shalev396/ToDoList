import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createReadOnlyClient } from './http.js';
import { getAdapter, registerAdapter, registeredProviders, unregisterAdapter } from './registry.js';
import type { AdapterPage, ProviderAdapter, ResourceResult } from './types.js';

async function* onePage(): AsyncGenerator<AdapterPage, ResourceResult> {
  yield await Promise.resolve({ resource: 'pages', containers: [], items: [] });
  return { nextState: {}, fullSync: true };
}

function stubAdapter(): ProviderAdapter {
  return {
    provider: 'notion',
    createClient: (transport) => createReadOnlyClient({ provider: 'notion', transport }),
    resources: () => ['pages'],
    fetch: () => onePage(),
  };
}

describe('adapter registry', () => {
  it('has no adapter for a provider nobody registered', () => {
    assert.equal(getAdapter('notion'), null);
  });

  it('registers an adapter under its provider, once', () => {
    const adapter = stubAdapter();
    registerAdapter(adapter);
    registerAdapter(adapter); // the same module evaluated twice is harmless
    assert.equal(getAdapter('notion'), adapter);
    assert.ok(registeredProviders().includes('notion'));
  });

  it('refuses a second, different adapter for the same provider', () => {
    assert.throws(() => {
      registerAdapter(stubAdapter());
    }, /already registered/);
  });

  it('unregisterAdapter forgets it (tests only)', () => {
    assert.equal(unregisterAdapter('notion'), true);
    assert.equal(getAdapter('notion'), null);
    assert.equal(unregisterAdapter('notion'), false);
  });
});
