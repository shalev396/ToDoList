/**
 * The consent-return marker (phase 4b re-review N-g): it answers only the OAuth return of the
 * start that set it. A failed start forgets it, any other return drops it, and it expires with
 * the server's OAuth state, so a later `?connected=` never jumps to a stale item.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSENT_RETURN_TTL_MS,
  forgetConsentReturn,
  rememberConsentReturn,
  startConsent,
  takeConsentReturn,
  type ConsentReturn,
  type ReturnStore,
} from './consentReturn.ts';

const OURS = '0b8f2f6e-6b8e-4c38-9a53-6f0d6c0a1d11';
const OTHER = '6c1c4f0e-2d1f-4a8e-8f7a-2b7c9d3e4f55';
const MARKER: ConsentReturn = { todoId: 'todo-1', integrationId: OURS, path: '/en/t/work' };
const AT = 1_700_000_000_000;

/** A sessionStorage stand-in. */
function memoryStore(): ReturnStore & { size: () => number } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    size: () => values.size,
  };
}

const params = (query: string) => new URLSearchParams(query);

describe('the consent-return marker', () => {
  it('comes back to its item on the return that connected its integration, once', () => {
    const store = memoryStore();
    rememberConsentReturn(MARKER, store, AT);
    assert.deepEqual(takeConsentReturn(params(`?connected=${OURS}`), store, AT + 1000), {
      ...MARKER,
      preselect: true,
    });
    assert.equal(takeConsentReturn(params(`?connected=${OURS}`), store, AT + 2000), null);
    assert.equal(store.size(), 0);
  });

  it('keeps an item’s own sign-in from preselecting a create target', () => {
    const store = memoryStore();
    rememberConsentReturn({ ...MARKER, preselect: false }, store, AT);
    assert.equal(takeConsentReturn(params(`?connected=${OURS}`), store, AT)?.preselect, false);
  });

  it('is forgotten when the start fails: a later connect from a card goes nowhere', () => {
    const store = memoryStore();
    rememberConsentReturn(MARKER, store, AT);
    forgetConsentReturn(store);
    assert.equal(takeConsentReturn(params(`?connected=${OURS}`), store, AT + 1000), null);
  });

  it('is dropped by any other OAuth return: another integration, or an oauth_error', () => {
    for (const query of [`?connected=${OTHER}`, '?oauth_error=oauth_denied']) {
      const store = memoryStore();
      rememberConsentReturn(MARKER, store, AT);
      assert.equal(takeConsentReturn(params(query), store, AT + 1000), null, query);
      assert.equal(store.size(), 0, `${query} drops it`);
      // So the right integration, later, does not jump to the abandoned item either.
      assert.equal(takeConsentReturn(params(`?connected=${OURS}`), store, AT + 2000), null);
    }
  });

  it('waits through a page that is no OAuth return', () => {
    const store = memoryStore();
    rememberConsentReturn(MARKER, store, AT);
    assert.equal(takeConsentReturn(params('?item=abc'), store, AT + 1000), null);
    assert.equal(store.size(), 1);
    assert.equal(
      takeConsentReturn(params(`?connected=${OURS}`), store, AT + 2000)?.todoId,
      'todo-1',
    );
  });

  it('expires with the OAuth state: an abandoned consent is never answered later', () => {
    const store = memoryStore();
    rememberConsentReturn(MARKER, store, AT);
    assert.equal(
      takeConsentReturn(params(`?connected=${OURS}`), store, AT + CONSENT_RETURN_TTL_MS + 1),
      null,
    );
    assert.equal(store.size(), 0);
    // A marker from before this version (no time) is no answer either.
    store.setItem('todolist-create-return', JSON.stringify(MARKER));
    assert.equal(takeConsentReturn(params(`?connected=${OURS}`), store, AT), null);
  });

  it('does nothing without a store (no sessionStorage)', () => {
    rememberConsentReturn(MARKER, null, AT);
    forgetConsentReturn(null);
    assert.equal(takeConsentReturn(params(`?connected=${OURS}`), null, AT), null);
  });
});

describe('startConsent: how the create’s "Allow" and the item’s "Allow edits" start', () => {
  it('forgets the marker and rethrows when the start fails: a later connect goes nowhere', async () => {
    const store = memoryStore();
    const failure = new Error('start failed');
    await assert.rejects(
      startConsent(MARKER, () => Promise.reject(failure), store, AT),
      (error: unknown) => error === failure,
    );
    assert.equal(store.size(), 0);
    assert.equal(takeConsentReturn(params(`?connected=${OURS}`), store, AT + 1000), null);
  });

  it('forgets it when the start throws before it returns a promise too', async () => {
    const store = memoryStore();
    await assert.rejects(
      startConsent(
        MARKER,
        () => {
          throw new Error('sync failure');
        },
        store,
        AT,
      ),
    );
    assert.equal(store.size(), 0);
  });

  it('keeps the marker for the round trip when the start succeeds, and answers its return', async () => {
    const store = memoryStore();
    const authorizeUrl = await startConsent(
      MARKER,
      () => Promise.resolve('https://idp'),
      store,
      AT,
    );
    assert.equal(authorizeUrl, 'https://idp');
    assert.equal(store.size(), 1);
    assert.equal(
      takeConsentReturn(params(`?connected=${OURS}`), store, AT + 1000)?.todoId,
      'todo-1',
    );
  });

  it('sets nothing for a create with no to-do yet, and still passes the start through', async () => {
    const store = memoryStore();
    assert.equal(await startConsent(null, () => Promise.resolve(7), store, AT), 7);
    assert.equal(store.size(), 0);
    await assert.rejects(startConsent(null, () => Promise.reject(new Error('x')), store, AT));
    assert.equal(store.size(), 0);
  });

  it('a failed start leaves no marker even over an earlier one', async () => {
    const store = memoryStore();
    rememberConsentReturn({ ...MARKER, todoId: 'earlier' }, store, AT);
    await assert.rejects(startConsent(MARKER, () => Promise.reject(new Error('x')), store, AT + 5));
    assert.equal(store.size(), 0);
  });
});
