/** The hourly tick: the dispatch, then the after-dispatch passes, a failing pass isolated. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runScheduledTick, type AfterDispatchPass } from './scheduledTick.js';

const NOW = new Date('2026-11-18T10:00:00.000Z');

describe('runScheduledTick', () => {
  it('runs the dispatch, then every pass in order, with the same now', async () => {
    const calls: string[] = [];
    const seen: Date[] = [];
    const pass = (name: string, counts: Record<string, number>): AfterDispatchPass => ({
      name,
      run: (now): Promise<Record<string, number>> => {
        calls.push(name);
        seen.push(now);
        return Promise.resolve(counts);
      },
    });
    const result = await runScheduledTick({
      now: NOW,
      dispatch: () => {
        calls.push('dispatch');
        return Promise.resolve({ dispatched: 2, failed: 0 });
      },
      passes: [pass('first', { a: 1 }), pass('second', { b: 2 })],
    });
    assert.deepEqual(calls, ['dispatch', 'first', 'second']);
    assert.deepEqual(seen, [NOW, NOW]);
    assert.deepEqual(result, {
      dispatch: { dispatched: 2, failed: 0 },
      passes: { first: { a: 1 }, second: { b: 2 } },
    });
  });

  it('records a failing pass and still runs the next', async () => {
    const result = await runScheduledTick({
      now: NOW,
      dispatch: () => Promise.resolve({ dispatched: 0, failed: 0 }),
      passes: [
        {
          name: 'first',
          run: (): Promise<Record<string, number>> => Promise.reject(new Error('boom')),
        },
        {
          name: 'second',
          run: (): Promise<Record<string, number>> => Promise.resolve({ done: 3 }),
        },
      ],
    });
    assert.deepEqual(result.passes['first'], { failed: true });
    assert.deepEqual(result.passes['second'], { done: 3 });
  });

  it('answers the dispatch and no passes when none are given', async () => {
    const result = await runScheduledTick({
      dispatch: () => Promise.resolve({ dispatched: 1, failed: 1 }),
      passes: [],
    });
    assert.deepEqual(result, { dispatch: { dispatched: 1, failed: 1 }, passes: {} });
  });
});
