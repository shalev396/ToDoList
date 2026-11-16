import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';

import { isLocalClientOrigin, localCors, LOCAL_CLIENT_ORIGIN } from './localCors.js';

interface Recorded {
  headers: Record<string, string>;
  status: number | null;
  nextCalled: boolean;
}

function run(origin: string | undefined, method = 'GET'): Recorded {
  const recorded: Recorded = { headers: {}, status: null, nextCalled: false };
  const req = { method, headers: origin === undefined ? {} : { origin } } as unknown as Request;
  const res = {
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
    },
    sendStatus(code: number) {
      recorded.status = code;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    recorded.nextCalled = true;
  };
  localCors(req, res, next);
  return recorded;
}

describe('localCors', () => {
  it('admits the Vite dev server and other loopback ports (E2E runs elsewhere)', () => {
    for (const origin of [
      LOCAL_CLIENT_ORIGIN,
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'http://127.0.0.1:5177',
    ]) {
      assert.equal(isLocalClientOrigin(origin), true, origin);
      const recorded = run(origin);
      assert.equal(recorded.headers['Access-Control-Allow-Origin'], origin, origin);
      assert.equal(recorded.headers['Vary'], 'Origin');
      assert.equal(recorded.nextCalled, true);
    }
  });

  it('refuses anything that is not a loopback http origin', () => {
    for (const origin of [
      'https://localhost:5173',
      'http://localhost',
      'http://localhost.evil.example:5173',
      'http://127.0.0.1.evil.example:80',
      'http://192.168.1.10:5173',
      'http://example.com',
      'null',
    ]) {
      assert.equal(isLocalClientOrigin(origin), false, origin);
      const recorded = run(origin);
      assert.equal(recorded.headers['Access-Control-Allow-Origin'], undefined, origin);
    }
    assert.equal(isLocalClientOrigin(undefined), false);
  });

  it('answers preflight with 204 and stops', () => {
    const recorded = run('http://localhost:5174', 'OPTIONS');
    assert.equal(recorded.status, 204);
    assert.equal(recorded.nextCalled, false);
  });
});
