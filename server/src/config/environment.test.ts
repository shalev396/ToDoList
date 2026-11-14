import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setRateLimitsOffForTests } from './testSwitches.js';

const { Environment } = await import('./environment.js');

const KEYS = ['ENV', 'DATABASE_URL'] as const;
const saved = new Map(
  KEYS.map((key) => [key, Reflect.get(process.env, key) as string | undefined]),
);

function build(
  values: Partial<Record<(typeof KEYS)[number], string>>,
): InstanceType<typeof Environment> {
  for (const key of KEYS) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, values);
  return new Environment();
}

afterEach(() => {
  setRateLimitsOffForTests(false);
  for (const [key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
});

describe('Environment', () => {
  it('allows the stage reset on every stage but prod', () => {
    assert.equal(build({ ENV: 'dev' }).allowsStageReset, true);
    assert.equal(build({ ENV: 'qa' }).allowsStageReset, true);
    assert.equal(build({ ENV: 'prod' }).allowsStageReset, false);
  });

  it('derives the database provider from the connection string', () => {
    assert.equal(build({ DATABASE_URL: 'mongodb://127.0.0.1/x' }).databaseProvider, 'mongoose');
    assert.equal(build({ DATABASE_URL: 'mongodb+srv://h/x' }).databaseProvider, 'mongoose');
    assert.equal(build({ DATABASE_URL: 'postgres://h/x' }).databaseProvider, 'sequelize');
    assert.throws(
      () => build({ DATABASE_URL: 'mysql://h/x' }).databaseProvider,
      /Unsupported DATABASE_URL scheme "mysql"/,
    );
  });

  it('keeps the rate limits on unless a test turns them off', () => {
    assert.equal(build({ ENV: 'prod' }).rateLimitEnabled, true);
    setRateLimitsOffForTests(true);
    assert.equal(build({ ENV: 'prod' }).rateLimitEnabled, false);
  });
});
