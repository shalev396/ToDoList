import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TFunction } from 'i18next';
import { ERROR_CODES } from '@api-types/errorCodes.ts';
import { en } from '../i18n/translations/en/index.ts';
import { he } from '../i18n/translations/he/index.ts';
import { limits } from '../data/limits.ts';
import {
  ERROR_CODE_KEYS,
  apiErrorCode,
  apiErrorStatus,
  apiOpenIn,
  errorKey,
  errorMessage,
} from './errors.ts';

/** An axios-shaped error with a response. */
function failed(status: number, data: unknown = {}): unknown {
  return Object.assign(new Error(`Request failed with status code ${String(status)}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

const FALLBACK = 'members.invite.failed';

describe('apiErrorStatus and apiErrorCode', () => {
  it('read the status and a known code', () => {
    const error = failed(409, { message: 'That slug is already taken', code: 'slug_taken' });
    assert.equal(apiErrorStatus(error), 409);
    assert.equal(apiErrorCode(error), 'slug_taken');
  });

  it('ignore unknown codes and errors without a response', () => {
    assert.equal(apiErrorCode(failed(409, { code: 'made_up_code' })), undefined);
    assert.equal(apiErrorCode(new Error('Network Error')), undefined);
    assert.equal(apiErrorStatus(new Error('Network Error')), undefined);
    assert.equal(apiErrorStatus('boom'), undefined);
  });
});

describe('errorKey (code, then status, then the fallback)', () => {
  it('a known code wins', () => {
    assert.equal(
      errorKey(failed(409, { code: 'workspace_full' }), FALLBACK),
      ERROR_CODE_KEYS.workspace_full,
    );
    assert.equal(
      errorKey(failed(401, { code: 'invalid_credentials' }), FALLBACK),
      ERROR_CODE_KEYS.invalid_credentials,
    );
  });

  it('without a code, a status with a generic text', () => {
    assert.equal(
      errorKey(failed(409, { message: 'Conflict' }), FALLBACK),
      'errors.status.conflict',
    );
    assert.equal(errorKey(failed(429), FALLBACK), 'errors.status.tooMany');
    assert.equal(errorKey(failed(403), FALLBACK), 'errors.status.forbidden');
  });

  it('otherwise the caller’s fallback: server errors, 401, network failures', () => {
    assert.equal(errorKey(failed(500), FALLBACK), FALLBACK);
    assert.equal(errorKey(failed(401, { message: 'Login failed' }), FALLBACK), FALLBACK);
    assert.equal(errorKey(new Error('Network Error'), FALLBACK), FALLBACK);
    assert.equal(errorKey(undefined, FALLBACK), FALLBACK);
  });

  it('never returns the server’s English message', () => {
    const key = errorKey(
      failed(400, { message: 'Email, password, and name are required' }),
      FALLBACK,
    );
    assert.equal(key, 'errors.status.badRequest');
  });
});

describe('errorMessage', () => {
  it('translates the key, with the free-tier limits for interpolation', () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const t = (key: string, options?: Record<string, unknown>) => {
      calls.push([key, options]);
      return `<${key}>`;
    };
    assert.equal(
      errorMessage(t as unknown as TFunction, failed(409, { code: 'workspace_limit' }), FALLBACK),
      `<${ERROR_CODE_KEYS.workspace_limit}>`,
    );
    assert.equal(calls[0]?.[1]?.['workspacesCreatedPerUser'], limits.workspacesCreatedPerUser);
  });
});

describe('every code has text in both languages', () => {
  function lookup(tree: unknown, key: string): unknown {
    return key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          typeof node === 'object' && node !== null
            ? (node as Record<string, unknown>)[part]
            : undefined,
        tree,
      );
  }

  it('en and he', () => {
    for (const code of ERROR_CODES) {
      const key = ERROR_CODE_KEYS[code];
      assert.equal(typeof lookup(en, key), 'string', `en ${key}`);
      assert.equal(typeof lookup(he, key), 'string', `he ${key}`);
    }
    for (const key of [
      'errors.status.badRequest',
      'errors.status.forbidden',
      'errors.status.notFound',
      'errors.status.conflict',
      'errors.status.gone',
      'errors.status.tooLarge',
      'errors.status.tooMany',
    ]) {
      assert.equal(typeof lookup(en, key), 'string', `en ${key}`);
      assert.equal(typeof lookup(he, key), 'string', `he ${key}`);
    }
  });
});

describe('apiOpenIn', () => {
  const failure = (status: number, data: unknown) => ({ response: { status, data } });

  it('reads the provider link of a mirrored-item 409', () => {
    assert.deepEqual(
      apiOpenIn(failure(409, { message: 'x', openIn: { provider: 'jira', url: 'https://j/1' } })),
      { provider: 'jira', url: 'https://j/1' },
    );
  });

  it('is null for other failures', () => {
    assert.equal(apiOpenIn(failure(409, { message: 'x', currentVersion: 3 })), null);
    assert.equal(apiOpenIn(failure(400, { openIn: { provider: 'jira', url: 'u' } })), null);
    assert.equal(apiOpenIn(new Error('x')), null);
  });
});
