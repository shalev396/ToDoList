import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Harness from '../testing/guardHarness.js';

let harness: Awaited<ReturnType<typeof Harness.startGuardHarness>>;
let h: typeof Harness;

before(async () => {
  process.env.ENV = 'prod';
  h = await import('../testing/guardHarness.js');
  harness = await h.startGuardHarness();
});

after(() => {
  harness.stop();
});

describe('response guard (ENV=prod)', () => {
  it('answers a blocked response with a plain 500 instead of throwing', async () => {
    const logs = await h.captureStderr(async () => {
      const res = await fetch(`${harness.base}/leak`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { message: 'Internal server error' });
      assert.equal(text.includes(h.FAKE_GITHUB_TOKEN), false);
    });
    assert.match(logs, /secret-guard/);
    assert.equal(logs.includes(h.FAKE_GITHUB_TOKEN), false);
  });
});
