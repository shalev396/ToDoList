/**
 * A running app accepts Cognito's tokens only: there is no fake-login route, no local upload
 * route, and a token signed any other way is refused (utils/cognitoUtil.ts) without fetching a
 * signing key. Nothing here installs a test seam.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mintTestToken, testSubForEmail } from './testing/testAuth.js';
import { installOutboundGuard, type OutboundGuard } from './testing/outboundGuard.js';

Object.assign(process.env, {
  ENV: 'prod',
  AWS_REGION: 'us-east-1',
  COGNITO_CLIENT_ID: 'test-client',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
  DOMAIN_NAME: 'example.test',
  DATABASE_URL: 'mongodb://127.0.0.1:1/unused',
});

const { createApp } = await import('./app.js');

let server: Server;
let base = '';
let guard: OutboundGuard;

before(async () => {
  guard = installOutboundGuard();
  server = await new Promise<Server>((resolve) => {
    const listening = createApp().listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
  guard.restore();
});

describe('createApp on a stage', () => {
  it('refuses a token that is not Cognito-signed', async () => {
    const email = 'someone@example.test';
    const token = mintTestToken({ sub: testSubForEmail(email), email, name: 'someone' });
    const response = await fetch(`${base}/api/private/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 401);
  });

  it('has no local upload route', async () => {
    const response = await fetch(`${base}/api/public/local-storage/upload`, { method: 'POST' });
    assert.equal(response.status, 404);
  });

  it('fetched no signing key and called nothing outside this machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
