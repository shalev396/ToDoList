import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldOfferReconnect,
  summarizeProvider,
  type AccountState,
  type RunFacts,
} from './providerSummary.ts';

const NOW = new Date('2026-11-17T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    id: 'i-1',
    accountLabel: 'acme.atlassian.net',
    status: 'connected',
    needsReconnect: false,
    expiresAt: null,
    ...over,
  };
}

function runs(over: Partial<{ syncing: string[]; failed: string[] }> = {}): RunFacts {
  return {
    syncing: (id) => over.syncing?.includes(id) === true,
    failed: (id) => over.failed?.includes(id) === true,
  };
}

const quiet = runs();

describe('summarizeProvider', () => {
  it('has no health without an account', () => {
    assert.deepEqual(summarizeProvider([], quiet, NOW), {
      count: 0,
      health: undefined,
      label: null,
    });
  });

  it('names the account when there is only one', () => {
    const summary = summarizeProvider([account()], quiet, NOW);
    assert.deepEqual(
      [summary.count, summary.label, summary.health],
      [1, 'acme.atlassian.net', 'ok'],
    );
  });

  it('gives no label for several accounts', () => {
    const summary = summarizeProvider([account(), account({ id: 'i-2' })], quiet, NOW);
    assert.deepEqual([summary.count, summary.label], [2, null]);
  });

  it('ranks error above attention above needs reconnect above syncing above ok', () => {
    const base = account({ id: 'a' });
    const reconnect = account({ id: 'b', needsReconnect: true });
    const failing = account({ id: 'd' });
    const broken = account({ id: 'c', status: 'expired' });
    const facts = runs({ syncing: ['a'], failed: ['d'] });
    assert.equal(summarizeProvider([base], quiet, NOW).health, 'ok');
    assert.equal(summarizeProvider([base], facts, NOW).health, 'syncing');
    assert.equal(summarizeProvider([base, reconnect], facts, NOW).health, 'needs_reconnect');
    assert.equal(summarizeProvider([base, reconnect, failing], facts, NOW).health, 'attention');
    assert.equal(summarizeProvider([base, reconnect, failing, broken], facts, NOW).health, 'error');
  });

  it('says attention for a credential that expires within 14 days, error once it has passed', () => {
    const soon = account({ expiresAt: new Date(NOW.getTime() + 5 * DAY) });
    const passed = account({ expiresAt: new Date(NOW.getTime() - DAY) });
    const far = account({ expiresAt: new Date(NOW.getTime() + 60 * DAY) });
    assert.equal(summarizeProvider([soon], quiet, NOW).health, 'attention');
    assert.equal(summarizeProvider([passed], quiet, NOW).health, 'error');
    assert.equal(summarizeProvider([far], quiet, NOW).health, 'ok');
  });

  it('puts a failed latest sync above ok', () => {
    assert.equal(
      summarizeProvider([account()], runs({ failed: ['i-1'] }), NOW).health,
      'attention',
    );
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
