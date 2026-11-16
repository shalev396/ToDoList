/**
 * How the in-app rate limits count (middlewares/rateLimit.ts): /api/private per presented bearer
 * token, so people behind one address keep their own budgets; the public surfaces per address.
 * app.ts mounts the per-token limit first, before verification, so an over-budget caller is
 * refused without a token check or a database read.
 *
 * Tokens are verified by a stand-in (setTokenVerifierForTests): the token text is its `sub`, and
 * "bad" fails verification. Every request comes from 127.0.0.1.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';

import { sha256Hex } from '../services/crypto/hashing.js';
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

let verifications = 0;
setTokenVerifierForTests((token) => {
  verifications += 1;
  return token === 'bad'
    ? Promise.reject(new Error('invalid token'))
    : Promise.resolve({ sub: token });
});

const express = (await import('express')).default;
const { responseFormatter } = await import('./responseFormatter.js');
const { verifyCognitoToken } = await import('./expressAuth.js');
const { limiter, ipKey, tokenKey } = await import('./rateLimit.js');
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
  app.get('/per-token', limiter(CAP, tokenKey), verifyCognitoToken, ok);
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

  const withHeader = (authorization: string | undefined): Request =>
    ({ ip: '203.0.113.7', headers: { authorization } }) as Request;

  it('a request counts against the SHA-256 of its bearer token', () => {
    const key = tokenKey(withHeader('Bearer abc'));
    assert.equal(key, `token:${sha256Hex('abc')}`);
    assert.doesNotMatch(key, /abc/);
    assert.notEqual(tokenKey(withHeader('Bearer abd')), key);
  });

  it('a request without a bearer token counts against its address', () => {
    assert.equal(tokenKey(withHeader(undefined)), 'ip:203.0.113.7');
    assert.equal(tokenKey(withHeader('Bearer ')), 'ip:203.0.113.7');
    assert.equal(tokenKey(withHeader('Basic abc')), 'ip:203.0.113.7');
    assert.equal(ipKey(request(undefined)), 'ip:unknown');
  });

  it('an IPv6 address counts by its /56, like the MCP limiters', () => {
    const key = ipKey(request('2001:db8:abcd:12ff:1:2:3:4'));
    assert.equal(key, 'ip:2001:db8:abcd:1200::/56');
    assert.equal(ipKey(request('2001:db8:abcd:1234::9')), key);
    assert.equal(ipKey(request('::ffff:203.0.113.7')), 'ip:203.0.113.7');
  });
});

describe('a per-token limit', () => {
  it('gives each token from one address a budget of its own', async () => {
    for (let i = 0; i < CAP; i += 1) assert.equal(await get('/per-token', 'user-a'), 200);
    assert.equal(await get('/per-token', 'user-a'), 429);
    assert.equal(await get('/per-token', 'user-b'), 200);
    assert.equal(await get('/per-token', 'user-a'), 429);
  });

  it('counts requests without a token by address, and refuses them past the budget', async () => {
    for (let i = 0; i < CAP; i += 1) assert.equal(await get('/per-token'), 401);
    assert.equal(await get('/per-token'), 429);
  });

  it('counts a token that fails verification, and refuses it past the budget unverified', async () => {
    const logged = mock.method(console, 'error', () => undefined);
    try {
      for (let i = 0; i < CAP; i += 1) assert.equal(await get('/per-token', 'bad'), 401);
      assert.equal(await get('/per-token', 'bad'), 429);
      assert.equal(logged.mock.callCount(), CAP);
    } finally {
      logged.mock.restore();
    }
    assert.equal(await get('/per-token', 'user-d'), 200);
  });
});

describe('a per-address limit (the public surfaces)', () => {
  it('shares one budget between everyone at an address, signed in or not', async () => {
    assert.equal(await get('/per-address', 'user-e'), 200);
    assert.equal(await get('/per-address', 'user-f'), 200);
    assert.equal(await get('/per-address', 'user-g'), 429);
  });
});

describe('MCP sign-in discovery in the app', () => {
  it('counts each request once, per address, across every discovery document', async () => {
    const paths = [
      '/api/mcp/oauth/.well-known/oauth-authorization-server',
      '/api/mcp/oauth/.well-known/openid-configuration',
      '/api/mcp/oauth/resource-metadata',
      '/api/mcp/oauth/resource-metadata/readonly',
      '/api/mcp/oauth/jwks',
      '/.well-known/oauth-authorization-server/api/mcp/oauth',
      '/.well-known/openid-configuration/api/mcp/oauth',
      '/.well-known/oauth-protected-resource/api/mcp',
      '/.well-known/oauth-protected-resource/api/mcp/readonly',
    ];
    let remaining: number | null = null;
    for (const path of paths) {
      const response = await fetch(`${base}${path}`);
      await response.arrayBuffer();
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('ratelimit-limit'), '1000', path);
      const now = Number(response.headers.get('ratelimit-remaining'));
      if (remaining !== null) assert.equal(now, remaining - 1, path);
      remaining = now;
    }
  });
});

describe('/api/private in the app', () => {
  it('refuses an over-budget token before it is verified or the user looked up', async () => {
    const lookups = mock.method(User, 'findByCognitoSub', () => Promise.resolve(null));
    const verifiedBefore = verifications;
    try {
      // privateLimiter's budget is 200 per token per window; each request looks its user up.
      for (let i = 0; i < 200; i += 1) {
        assert.equal(await get('/api/private/me', 'busy-user'), 404, `request ${String(i)}`);
      }
      assert.equal(lookups.mock.callCount(), 200);
      assert.equal(await get('/api/private/me', 'busy-user'), 429);
      assert.equal(lookups.mock.callCount(), 200);
      assert.equal(verifications - verifiedBefore, 200, 'the 429 was not verified');
      assert.equal(await get('/api/private/me', 'quiet-user'), 404);
      assert.equal(lookups.mock.callCount(), 201);
    } finally {
      lookups.mock.restore();
    }
  });
});
