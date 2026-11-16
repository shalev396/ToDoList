import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from './AppError.js';
import type { ErrorCode } from '../types/errorCodes.js';

describe('AppError codes', () => {
  it('carries a machine code for the client', () => {
    const error = new AppError(409, 'That slug is already taken', { code: 'slug_taken' });
    assert.equal(error.code, 'slug_taken');
    assert.equal(error.statusCode, 409);
  });

  it('has no code unless given one', () => {
    assert.equal(new AppError(400, 'No changes provided').code, undefined);
  });

  it('refuses a code that is not lowercase snake case of 3 to 41 characters', () => {
    for (const bad of ['Slug_taken', 'ab', 'slug taken', '1slug', `a${'b'.repeat(41)}`]) {
      assert.throws(() => new AppError(409, 'x', { code: bad as ErrorCode }), /error code/i, bad);
    }
  });
});
