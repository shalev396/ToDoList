import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  carriesSecret,
  IDENTITY_FIELDS,
  MIN_SECRET_LENGTH,
  REDACTED,
  redactSecrets,
  secretValuesOf,
} from './secretHygiene.js';

const TOKEN = 'ATATT3xFAKEhygieneTokenFAKE0123456789';
const SHARED = 'FAKE-shared-secret-0123';
/** An identity field: a label beside the secret, never looked for or redacted. */
const EMAIL = 'dev@example.test';
const VALUES = secretValuesOf({ email: EMAIL, token: TOKEN, sharedSecret: SHARED, kid: 'k1' });

/** Everything an error shows: what a logger or a JSON serializer could print. */
function shown(error: Error): string {
  const fields = Object.fromEntries(Object.entries(error));
  return [error.name, error.message, String(error.stack), JSON.stringify(fields)].join('\n');
}

describe('secretValuesOf', () => {
  it('keeps the distinct values of at least MIN_SECRET_LENGTH characters, longest first', () => {
    assert.equal(MIN_SECRET_LENGTH, 8);
    assert.deepEqual(VALUES, [TOKEN, SHARED]);
    assert.deepEqual(secretValuesOf({ a: 'same-value', b: 'same-value', c: 'short' }), [
      'same-value',
    ]);
  });

  it('skips every identity field (a label, not a secret) and keeps the token', () => {
    assert.deepEqual([...IDENTITY_FIELDS].sort(), ['clientEmail', 'email', 'kid', 'kidNext']);
    assert.deepEqual(
      secretValuesOf({
        email: EMAIL,
        clientEmail: 'sync-bot@FAKE-project.iam.gserviceaccount.com',
        // Long enough that only the field name, not MIN_SECRET_LENGTH, leaves them out.
        kid: 'kid-2026-11-current',
        kidNext: 'kid-2026-12-next',
        token: TOKEN,
      }),
      [TOKEN],
    );
  });
});

describe('carriesSecret', () => {
  it('finds a secret value anywhere in a value', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    cyclic['deep'] = { list: [1, { header: `Bearer ${TOKEN}` }] };
    const cases: [string, unknown][] = [
      ['the value itself', TOKEN],
      ['inside a longer string', `signed with ${SHARED} today`],
      ['an array item', ['a', TOKEN]],
      ['a nested field', { outer: { inner: TOKEN } }],
      ['an object key', { [TOKEN]: true }],
      ['a Map value', new Map([['header', TOKEN]])],
      ['a Map key', new Map([[TOKEN, 1]])],
      ['a Set item', new Set([TOKEN])],
      ['a Buffer', Buffer.from(TOKEN)],
      ['a typed array', new TextEncoder().encode(`x${TOKEN}x`)],
      ['an ArrayBuffer', new TextEncoder().encode(TOKEN).buffer],
      ['an error message', new Error(`failed for ${SHARED}`)],
      ['an error cause', { error: new Error('outer', { cause: new Error(TOKEN) }) }],
      ['a hidden field', Object.defineProperty({}, 'hidden', { value: TOKEN, enumerable: false })],
      ['an own getter', Object.defineProperty({}, 'lazy', { get: () => TOKEN, enumerable: true })],
      ['a cycle', cyclic],
    ];
    for (const [where, value] of cases) assert.equal(carriesSecret(value, VALUES), true, where);
  });

  it('passes values without a secret value, identity labels and short values included', () => {
    const cases: unknown[] = [
      undefined,
      null,
      true,
      42,
      'k1',
      { accountLabel: EMAIL },
      `signed in as ${EMAIL}`,
      { ok: true, count: 3, kid: 'k1', at: new Date(0) },
      [1, 'two', ['three']],
      new Map([['a', 'b']]),
      Buffer.from('nothing to see'),
      new Error('fetch failed'),
    ];
    for (const value of cases) assert.equal(carriesSecret(value, VALUES), false);
  });

  it('counts a value it cannot read as carrying one (it fails closed)', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error('no keys for you');
        },
      },
    );
    assert.equal(carriesSecret(hostile, VALUES), true);
  });
});

describe('redactSecrets', () => {
  class ProviderFailure extends Error {
    readonly code = 'auth_failed';
    readonly status = 401;
    readonly url = `https://example.invalid/api?token=${TOKEN}`;

    constructor(message: string, options?: { cause?: unknown }) {
      super(message, options);
      this.name = 'ProviderFailure';
    }
  }

  it('redacts the message, stack, text fields and cause chain in place: same object, class, name and code', () => {
    const inner = new Error(`inner ${TOKEN}`, { cause: `root ${SHARED}` });
    const thrown = new ProviderFailure(`401 for ${TOKEN}`, { cause: inner });
    const out = redactSecrets(thrown, VALUES);
    assert.equal(out, thrown);
    assert.ok(out instanceof ProviderFailure);
    assert.deepEqual(
      [out.name, out.code, out.status, out.message],
      ['ProviderFailure', 'auth_failed', 401, `401 for ${REDACTED}`],
    );
    assert.equal(out.url, `https://example.invalid/api?token=${REDACTED}`);
    assert.equal(inner.message, `inner ${REDACTED}`);
    assert.equal(inner.cause, `root ${REDACTED}`);
    for (const error of [out, inner]) assert.ok(!shown(error).includes(TOKEN));
    assert.ok(!shown(inner).includes(SHARED));
    assert.equal(carriesSecret(out, VALUES), false);
  });

  it('leaves identity labels in an error alone, redacting only the secret beside them', () => {
    const thrown = new Error(`401 for ${EMAIL} with ${TOKEN}`, { cause: `account ${EMAIL}` });
    assert.equal(redactSecrets(thrown, VALUES), thrown);
    assert.equal(thrown.message, `401 for ${EMAIL} with ${REDACTED}`);
    assert.equal(thrown.cause, `account ${EMAIL}`);
  });

  it('redacts an AggregateError’s errors and a DOMException’s inherited message', () => {
    const aggregate = new AggregateError(
      [new Error(`one ${TOKEN}`), `two ${SHARED}`],
      `both failed for ${SHARED}`,
    );
    assert.equal(redactSecrets(aggregate, VALUES), aggregate);
    assert.equal(aggregate.message, `both failed for ${REDACTED}`);
    assert.equal((aggregate.errors[0] as Error).message, `one ${REDACTED}`);
    assert.equal(aggregate.errors[1], `two ${REDACTED}`);

    const aborted = new DOMException(`aborted for ${TOKEN}`, 'AbortError');
    const out = redactSecrets(aborted, VALUES);
    assert.equal(out, aborted);
    assert.ok(out instanceof DOMException);
    assert.deepEqual(
      [out.name, aborted.code, out.message],
      ['AbortError', 20, `aborted for ${REDACTED}`],
    );
    assert.ok(!String(out.stack).includes(TOKEN));
  });

  it('leaves an error without a secret value untouched', () => {
    const clean = new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
    const stack = clean.stack;
    assert.equal(redactSecrets(clean, VALUES), clean);
    assert.equal(clean.stack, stack);
    assert.equal(clean.message, 'fetch failed');
  });

  it('replaces an error it cannot change (frozen) with a plain Error of the same name and code', () => {
    const frozen = Object.freeze(
      Object.assign(new Error(`frozen ${TOKEN}`, { cause: new Error(`cause ${SHARED}`) }), {
        name: 'FrozenError',
        code: 'E_FROZEN',
      }),
    );
    const out = redactSecrets(frozen, VALUES);
    assert.notEqual(out, frozen);
    assert.deepEqual(
      [out.name, (out as { code?: unknown }).code, out.message, (out.cause as Error).message],
      ['FrozenError', 'E_FROZEN', `frozen ${REDACTED}`, `cause ${REDACTED}`],
    );
    assert.equal(carriesSecret(out, VALUES), false);
  });

  it('replaces an error whose other fields still hold a secret value', () => {
    const thrown = Object.assign(new Error('request failed'), {
      code: 'E_HTTP',
      response: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const out = redactSecrets(thrown, VALUES);
    assert.notEqual(out, thrown);
    assert.deepEqual(
      [out.name, out.message, (out as { code?: unknown }).code],
      ['Error', 'request failed', 'E_HTTP'],
    );
    assert.equal(carriesSecret(out, VALUES), false);
  });

  it('turns a thrown non-error into an Error', () => {
    assert.equal(redactSecrets(`raw ${TOKEN}`, VALUES).message, `raw ${REDACTED}`);
    assert.equal(
      redactSecrets({ token: TOKEN }, VALUES).message,
      'The vault callback threw a non-error value',
    );
  });
});
