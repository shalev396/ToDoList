/**
 * How the in-app rate limits count (middlewares/rateLimit.ts): /api/private per verified Cognito
 * user, so people behind one address keep their own budgets; the public surfaces per address.
 * app.ts mounts the per-user limit between the token check and the user lookup, so an
 * over-budget user is refused without a database read.
 *
 * Tokens are verified by a stand-in (setTokenVerifierForTests): the token text is its `sub`, and
 * "bad" fails verification. Every request comes from 127.0.0.1.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';

import { setTokenVerifierForTests } from '../utils/cognitoUtil.js';

// config/environment.ts reads process.env when asked: set it before the app is imported.
Object.assign(process.env, {
  ENV: 'dev',
  DATABASE_URL: 'mongodb://127.0.0.1:1/rate_limit_test_unused',
  DOMAIN_NAME: 'dev.example.test',
  AWS_REGION: 'us-east-1',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
  COGNITO_CLIENT_ID: 'test-client',
});

setTokenVerifierForTests((token) =>
  token === 'bad' ? Promise.reject(new Error('invalid token')) : Promise.resolve({ sub: token }),
);

const express = (await import('express')).default;
const { responseFormatter } = await import('./responseFormatter.js');
const { verifyCognitoToken } = await import('./expressAuth.js');
const { limiter, ipKey, userKey } = await import('./rateLimit.js');
const { createApp } = await import('../app.js');
const { User } = await import('../classes/User.js');

const CAP = 2;

let server: Server;
let base = '';

before(async () => {
  const app = express();
  app.use(responseFormatter);
  const ok = (_req: Request, res: Response): void => {
    res.success({ ok: true });
  };
  app.get('/per-user', verifyCognitoToken, limiter(CAP, userKey), ok);
  app.get('/per-user-unverified', limiter(CAP, userKey), ok);
  app.get('/per-address', verifyCognitoToken, limiter(CAP), ok);
  // The real app, for the order its /api/private chain runs in.
  app.use(createApp());
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
});

async function get(path: string, token?: string): Promise<number> {
  const headers: Record<string, string> =
    token === undefined ? {} : { authorization: `Bearer ${token}` };
  const response = await fetch(`${base}${path}`, { headers });
  await response.arrayBuffer();
  return response.status;
}

describe('the rate-limit keys', () => {
  const request = (ip: string | undefined): Request => ({ ip }) as Request;
  const response = (locals: Record<string, unknown>): Response =>
    ({ locals }) as unknown as Response;

  it('an authenticated request counts against its verified user', () => {
    assert.equal(userKey(request('203.0.113.7'), response({ cognitoSub: 'sub-a' })), 'user:sub-a');
  });

  it('a request without a verified user counts against its address', () => {
    assert.equal(userKey(request('203.0.113.7'), response({})), 'ip:203.0.113.7');
    assert.equal(userKey(request('203.0.113.7'), response({ cognitoSub: '' })), 'ip:203.0.113.7');
    assert.equal(ipKey(request(undefined)), 'ip:unknown');
  });
});

describe('a per-user limit', () => {
  it('gives each user from one address a budget of their own', async () => {
    for (let i = 0; i < CAP; i += 1) assert.equal(await get('/per-user', 'user-a'), 200);
    assert.equal(await get('/per-user', 'user-a'), 429);
    assert.equal(await get('/per-user', 'user-b'), 200);
    assert.equal(await get('/per-user', 'user-a'), 429);
  });

  it('falls back to the address when no token was verified', async () => {
    for (let i = 0; i < CAP; i += 1) assert.equal(await get('/per-user-unverified'), 200);
    assert.equal(await get('/per-user-unverified', 'user-c'), 429);
  });

  it('never reaches a token that fails verification: 401, and nothing is counted', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    try {
      for (let i = 0; i < CAP + 2; i += 1) assert.equal(await get('/per-user', 'bad'), 401);
    } finally {
      logged.mock.restore();
    }
    assert.equal(await get('/per-user', 'user-d'), 200);
  });
});

describe('a per-address limit (the public surfaces)', () => {
  it('shares one budget between everyone at an address, signed in or not', async () => {
    assert.equal(await get('/per-address', 'user-e'), 200);
    assert.equal(await get('/per-address', 'user-f'), 200);
    assert.equal(await get('/per-address', 'user-g'), 429);
  });
});

describe('/api/private in the app', () => {
  it('refuses an over-budget user before the user is looked up, and only that user', async () => {
    const lookups = mock.method(User, 'findByCognitoSub', () => Promise.resolve(null));
    try {
      // privateLimiter's budget is 200 per user per window; each request looks its user up.
      for (let i = 0; i < 200; i += 1) {
        assert.equal(await get('/api/private/me', 'busy-user'), 404, `request ${String(i)}`);
      }
      assert.equal(lookups.mock.callCount(), 200);
      assert.equal(await get('/api/private/me', 'busy-user'), 429);
      assert.equal(lookups.mock.callCount(), 200);
      assert.equal(await get('/api/private/me', 'quiet-user'), 404);
      assert.equal(lookups.mock.callCount(), 201);
    } finally {
      lookups.mock.restore();
    }
  });
});
