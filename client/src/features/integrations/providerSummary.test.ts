import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldOfferReconnect, summarizeProvider, type AccountState } from './providerSummary.ts';

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    id: 'i-1',
    accountLabel: 'acme.atlassian.net',
    status: 'connected',
    needsReconnect: false,
    ...over,
  };
}

const never = (): boolean => false;

describe('summarizeProvider', () => {
  it('has no health without an account', () => {
    assert.deepEqual(summarizeProvider([], never), { count: 0, health: undefined, label: null });
  });

  it('names the account when there is only one', () => {
    const summary = summarizeProvider([account()], never);
    assert.deepEqual(
      [summary.count, summary.label, summary.health],
      [1, 'acme.atlassian.net', 'ok'],
    );
  });

  it('gives no label for several accounts', () => {
    const summary = summarizeProvider([account(), account({ id: 'i-2' })], never);
    assert.deepEqual([summary.count, summary.label], [2, null]);
  });

  it('ranks error above needs reconnect above syncing above ok', () => {
    const base = account({ id: 'a' });
    const reconnect = account({ id: 'b', needsReconnect: true });
    const broken = account({ id: 'c', status: 'expired' });
    const syncing = (id: string): boolean => id === 'a';
    assert.equal(summarizeProvider([base], syncing).health, 'syncing');
    assert.equal(summarizeProvider([base, reconnect], syncing).health, 'needs_reconnect');
    assert.equal(summarizeProvider([base, reconnect, broken], syncing).health, 'error');
    assert.equal(summarizeProvider([base], never).health, 'ok');
  });
});

describe('shouldOfferReconnect', () => {
  it('follows the saved connection when it says whether it must reconnect', () => {
    assert.equal(
      shouldOfferReconnect(
        { authMethod: 'oauth', needsReconnect: true },
        { needsWriteScope: false },
      ),
      true,
    );
    // The grant already has the scope: no dialog, whatever the provider asks for.
    assert.equal(
      shouldOfferReconnect(
        { authMethod: 'oauth', needsReconnect: false },
        { needsWriteScope: true },
      ),
      false,
    );
  });

  it('falls back to the provider needing a write scope when the answer is missing', () => {
    const saved = { authMethod: 'oauth' };
    assert.equal(shouldOfferReconnect(saved, { needsWriteScope: true }), true);
    assert.equal(shouldOfferReconnect(saved, { needsWriteScope: false }), false);
    assert.equal(shouldOfferReconnect(saved, undefined), false);
  });

  it('never offers it for a key or token, or when nothing saved', () => {
    assert.equal(
      shouldOfferReconnect({ authMethod: 'api_token_basic', needsReconnect: true }, undefined),
      false,
    );
    assert.equal(shouldOfferReconnect(undefined, { needsWriteScope: true }), false);
  });
});
