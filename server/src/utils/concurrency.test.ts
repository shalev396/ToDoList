import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runWithConcurrency, settleAll } from './concurrency.js';

describe('runWithConcurrency', () => {
  it('returns results in input order even when later items finish first', async () => {
    const out = await runWithConcurrency([30, 10, 20, 0], 4, async (ms, i) => {
      await delay(ms);
      return `${String(i)}:${String(ms)}`;
    });
    assert.deepEqual(out, ['0:30', '1:10', '2:20', '3:0']);
  });

  it('never runs more than `limit` calls at once', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    await runWithConcurrency(items, 3, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await delay(i % 4);
      active--;
    });
    assert.equal(peak, 3);
  });

  it('calls fn once per item', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      await delay(0);
      seen.push(n);
    });
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
  });

  it('handles an empty list and a limit below 1', async () => {
    assert.deepEqual(await runWithConcurrency([], 5, () => Promise.resolve(1)), []);
    assert.deepEqual(await runWithConcurrency([1, 2], 0, (n) => Promise.resolve(n * 2)), [2, 4]);
  });

  it('rejects with the error thrown by fn', async () => {
    await assert.rejects(
      runWithConcurrency([1, 2, 3], 2, (n) =>
        n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(n),
      ),
      /boom/,
    );
  });
});

describe('settleAll', () => {
  it('answers every result in order', async () => {
    const out = await settleAll([delay(20).then(() => 'slow'), Promise.resolve(2)] as const);
    assert.deepEqual(out, ['slow', 2]);
  });

  it('waits for every task before it throws, and throws the first failure by position', async () => {
    const finished: string[] = [];
    const later = delay(30).then(() => {
      finished.push('later');
      throw new Error('second by position, last to fail');
    });
    const sooner = delay(5).then(() => {
      finished.push('sooner');
      throw new Error('third by position, first to fail');
    });
    const fine = delay(15).then(() => {
      finished.push('fine');
      return 1;
    });
    await assert.rejects(settleAll([fine, later, sooner] as const), /second by position/);
    assert.deepEqual(finished.sort(), ['fine', 'later', 'sooner']);
  });
});
