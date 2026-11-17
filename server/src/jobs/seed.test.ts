import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../errors/AppError.js';
import { seedStage } from './seed.js';

describe('seedStage (the `seed` direct-invoke action)', () => {
  it('is refused on every stage but dev', async () => {
    for (const env of ['qa', 'prod'] as const) {
      await assert.rejects(
        seedStage(env),
        (error: unknown) =>
          error instanceof AppError &&
          error.statusCode === 403 &&
          error.message === `seed is only allowed on the dev stage (this is ${env})`,
      );
    }
  });

  it('is not available on dev yet', async () => {
    await assert.rejects(
      seedStage('dev'),
      (error: unknown) => error instanceof AppError && error.statusCode === 501,
    );
  });
});
