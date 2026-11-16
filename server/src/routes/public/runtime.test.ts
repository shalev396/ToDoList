/**
 * GET /api/public/runtime: what the client adapts to on a stage (the demo data option), and
 * nothing else. The whole app is served as the dev stage; no database is needed because the route
 * never touches one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setRateLimitsOffForTests } from '../../config/testSwitches.js';

setRateLimitsOffForTests(true);

// config/environment.ts reads process.env once, at import: set it before importing the app.
Object.assign(process.env, {
  ENV: 'dev',
  DATABASE_URL: 'mongodb://127.0.0.1:1/runtime_test_unused',
  DOMAIN_NAME: 'dev.example.test',
  AWS_REGION: 'us-east-1',
  S3_ASSETS_BUCKET_NAME: 'todolist-dev-assets-test',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
  COGNITO_CLIENT_ID: 'test-client',
});

const { createApp } = await import('../../app.js');
const { runtimeInfo } = await import('../../controllers/runtime.js');

let server: Server;
let base = '';

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = createApp().listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
});

describe('runtimeInfo', () => {
  it('offers demo data on dev and qa only, never on prod', () => {
    assert.deepEqual(runtimeInfo({ env: 'dev' }), { env: 'dev', demoDataAvailable: true });
    assert.equal(runtimeInfo({ env: 'qa' }).demoDataAvailable, true);
    assert.equal(runtimeInfo({ env: 'prod' }).demoDataAvailable, false);
  });
});

describe('GET /api/public/runtime', () => {
  it('answers without a token, with exactly the stage and the demo flag', async () => {
    const response = await fetch(`${base}/api/public/runtime`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    assert.deepEqual(body, { data: { env: 'dev', demoDataAvailable: true } });
  });

  it('never carries configuration values', async () => {
    const text = await (await fetch(`${base}/api/public/runtime`)).text();
    for (const value of [
      process.env.DATABASE_URL,
      process.env.DOMAIN_NAME,
      process.env.COGNITO_USER_POOL_ID,
      process.env.COGNITO_CLIENT_ID,
      'mongodb',
      'secret',
    ]) {
      assert.ok(!text.includes(value), `response mentions ${value}`);
    }
  });

  it('is read-only', async () => {
    const response = await fetch(`${base}/api/public/runtime`, { method: 'POST' });
    assert.equal(response.status, 404);
  });
});
