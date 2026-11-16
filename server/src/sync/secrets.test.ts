import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setVaultLoaderForTests, withProviderSecret, type SyncVault } from './secrets.js';

const integration = { id: 'i-secret-test' };

/** Installs a vault stub; the returned record shows how it was used. */
function stubVault(secret: Record<string, string>): { loads: number; decrypts: string[] } {
  const usage = { loads: 0, decrypts: [] as string[] };
  const vault: SyncVault = {
    decryptForSync: async (integrationId, fn) => {
      usage.decrypts.push(integrationId);
      return fn(secret);
    },
  };
  setVaultLoaderForTests(() => {
    usage.loads += 1;
    return Promise.resolve(vault);
  });
  return usage;
}

afterEach(() => {
  setVaultLoaderForTests(null);
});

describe('withProviderSecret', () => {
  it('fixtures mode hands over an empty secret and never loads the vault', async () => {
    const stub = stubVault({ token: 'FAKE-token-never-used' });
    const seen = await withProviderSecret(integration, 'fixtures', (secret) =>
      Promise.resolve(Object.keys(secret)),
    );
    assert.deepEqual(seen, []);
    assert.equal(stub.loads, 0);
    assert.deepEqual(stub.decrypts, []);
  });

  it('the fixtures secret is frozen', async () => {
    await withProviderSecret(integration, 'fixtures', (secret) => {
      assert.ok(Object.isFrozen(secret));
      return Promise.resolve();
    });
  });

  it('live mode decrypts through the vault, for this integration only, inside the callback', async () => {
    const stub = stubVault({ token: 'FAKE-token-0000000000' });
    const result = await withProviderSecret(integration, 'live', (secret) =>
      Promise.resolve(`got ${String(secret['token']?.length)} chars`),
    );
    assert.equal(result, 'got 21 chars');
    assert.equal(stub.loads, 1);
    assert.deepEqual(stub.decrypts, ['i-secret-test']);
  });

  it('the test seam refuses to run outside node:test, and a refused call changes nothing', async () => {
    const stub = stubVault({ token: 'FAKE-token-installed-first' });
    const context = process.env['NODE_TEST_CONTEXT'];
    assert.ok(context !== undefined && context !== '', 'node --test sets NODE_TEST_CONTEXT');
    delete process.env['NODE_TEST_CONTEXT'];
    try {
      assert.throws(() => {
        setVaultLoaderForTests(null);
      }, /only under node:test/);
      assert.throws(() => {
        stubVault({ token: 'FAKE-token-never-installed' });
      }, /only under node:test/);
    } finally {
      process.env['NODE_TEST_CONTEXT'] = context;
    }
    const token = await withProviderSecret(integration, 'live', (secret) =>
      Promise.resolve(secret['token']),
    );
    assert.equal(token, 'FAKE-token-installed-first');
    assert.equal(stub.loads, 1);
  });

  it('live mode passes vault failures through', async () => {
    setVaultLoaderForTests(() =>
      Promise.resolve({
        decryptForSync: () => Promise.reject(new Error('no credential')),
      }),
    );
    await assert.rejects(
      withProviderSecret(integration, 'live', () => Promise.resolve('unreachable')),
      /no credential/,
    );
  });
});
