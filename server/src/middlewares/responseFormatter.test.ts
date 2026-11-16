import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Harness from '../testing/guardHarness.js';

let harness: Awaited<ReturnType<typeof Harness.startGuardHarness>>;
let h: typeof Harness;

before(async () => {
  process.env.ENV = 'dev';
  h = await import('../testing/guardHarness.js');
  harness = await h.startGuardHarness();
});

after(() => {
  harness.stop();
});

describe('error handler (ENV=dev)', () => {
  it('answers malformed JSON with a JSON 400 and never echoes the body', async () => {
    const res = await fetch(`${harness.base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken": ghp_not_json',
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { message: 'Malformed JSON body' });
    assert.equal(text.includes('broken'), false);
  });

  it('turns unexpected errors into a generic 500 and redacts the log line', async () => {
    let body = '';
    const logs = await h.captureStderr(async () => {
      const res = await fetch(`${harness.base}/boom`);
      assert.equal(res.status, 500);
      body = await res.text();
    });
    assert.deepEqual(JSON.parse(body), { message: 'Internal server error' });
    assert.equal(logs.includes('FAKE-pw'), false);
    assert.match(logs, /GET \/boom failed/);
  });

  it('answers a 5xx AppError with a generic message and logs the real one', async () => {
    let status = 0;
    let body = '';
    const logs = await h.captureStderr(async () => {
      const res = await fetch(`${harness.base}/unavailable`);
      status = res.status;
      body = await res.text();
    });
    assert.equal(status, 503);
    assert.deepEqual(JSON.parse(body), { message: 'Internal server error' });
    assert.equal(body.includes('secret-ish'), false);
    assert.match(logs, /GET \/unavailable failed/);
  });

  it('passes AppError messages through with their status', async () => {
    const res = await fetch(`${harness.base}/conflict`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { message: 'Version conflict' });
  });
});

describe('response guard (ENV=dev)', () => {
  it('blocks a response carrying a token and never sends or logs it', async () => {
    let body = '';
    const logs = await h.captureStderr(async () => {
      const res = await fetch(`${harness.base}/leak`);
      assert.equal(res.status, 500);
      body = await res.text();
    });
    assert.equal(body.includes(h.FAKE_GITHUB_TOKEN), false);
    assert.equal(logs.includes(h.FAKE_GITHUB_TOKEN), false);
    assert.match(logs, /secret-guard/);
  });

  it('lets a handler return the session tokens it opted into', async () => {
    const res = await fetch(`${harness.base}/session`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { idToken: h.FAKE_JWT } });
  });
});

describe('error codes (ENV=dev)', () => {
  it('adds the AppError code to the JSON body', async () => {
    const res = await fetch(`${harness.base}/coded`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      message: 'That slug is already taken',
      code: 'slug_taken',
    });
  });

  it('res.error takes a code too', async () => {
    const res = await fetch(`${harness.base}/coded-reply`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      message: 'Incorrect email or password.',
      code: 'invalid_credentials',
    });
  });

  it('a server error stays generic, without its code', async () => {
    const res = await fetch(`${harness.base}/coded-unavailable`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { message: 'Internal server error' });
  });

  it('a provider that did not answer keeps its code, and nothing else of the error', async () => {
    const res = await fetch(`${harness.base}/no-answer`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      message: 'Internal server error',
      code: 'provider_no_answer',
    });
  });

  it('a provider that was never reached keeps its code, and nothing else of the error', async () => {
    const res = await fetch(`${harness.base}/unreachable`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      message: 'Internal server error',
      code: 'provider_unreachable',
    });
  });

  it('an error without a code has no code field', async () => {
    const res = await fetch(`${harness.base}/conflict`);
    assert.deepEqual(await res.json(), { message: 'Version conflict' });
  });
});
