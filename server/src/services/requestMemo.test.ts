import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { forgetForRequest, memoForRequest, runWithRequestMemo } from './requestMemo.js';

/** A compute function that counts its calls. */
function counter(): { calls: () => number; compute: () => Promise<number> } {
  let calls = 0;
  return {
    calls: (): number => calls,
    compute: (): Promise<number> => {
      calls += 1;
      return Promise.resolve(calls);
    },
  };
}

describe('the request memo', () => {
  it('computes once per request and key', async () => {
    const count = counter();
    await runWithRequestMemo(async () => {
      assert.equal(await memoForRequest('a', count.compute), 1);
      assert.equal(await memoForRequest('a', count.compute), 1);
      assert.equal(await memoForRequest('b', count.compute), 2);
    });
    assert.equal(count.calls(), 2);
  });

  it('never carries a value into another request, nor outside one', async () => {
    const count = counter();
    await runWithRequestMemo(() => memoForRequest('a', count.compute));
    await runWithRequestMemo(() => memoForRequest('a', count.compute));
    await memoForRequest('a', count.compute);
    await memoForRequest('a', count.compute);
    assert.equal(count.calls(), 4);
  });

  it('forgets the keys a write changed, by prefix', async () => {
    const count = counter();
    await runWithRequestMemo(async () => {
      await memoForRequest('access:w1:shared', count.compute);
      await memoForRequest('access:w2:shared', count.compute);
      forgetForRequest('access:w1:');
      await memoForRequest('access:w1:shared', count.compute);
      await memoForRequest('access:w2:shared', count.compute);
    });
    assert.equal(count.calls(), 3);
  });

  it('keeps no failure: the next call in the request computes again', async () => {
    let calls = 0;
    const flaky = (): Promise<string> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve('up');
    };
    await runWithRequestMemo(async () => {
      await assert.rejects(memoForRequest('k', flaky), /down/);
      assert.equal(await memoForRequest('k', flaky), 'up');
    });
  });
});
