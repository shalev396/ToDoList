import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CleanupProgress } from '@api-types/primaryCalendar.ts';
import {
  addProgress,
  finishProgress,
  madeProgress,
  MAX_CLEANUP_CALLS,
  NO_PROGRESS,
  runCleanup,
} from './cleanupLoop.ts';

const progress = (patch: Partial<CleanupProgress>): CleanupProgress => ({
  ...NO_PROGRESS,
  ...patch,
});

function incomplete(value: CleanupProgress): Error {
  return Object.assign(new Error('incomplete'), {
    isAxiosError: true,
    response: { status: 409, data: { code: 'cleanup_incomplete', progress: value } },
  });
}

const always = { shouldContinue: () => true, onProgress: () => undefined };

describe('madeProgress', () => {
  it('needs something removed or given up on', () => {
    assert.equal(madeProgress(null, progress({ remaining: 5 })), false);
    assert.equal(madeProgress(null, progress({ events: 1, remaining: 5 })), true);
    assert.equal(madeProgress(null, progress({ failed: 1, remaining: 5 })), true);
  });
  it('needs fewer steps left than the call before', () => {
    const before = progress({ events: 3, remaining: 5 });
    assert.equal(madeProgress(before, progress({ events: 3, remaining: 5 })), false);
    assert.equal(madeProgress(before, progress({ events: 3, remaining: 2 })), true);
  });
});

describe('addProgress', () => {
  it('adds the counts and keeps the latest remaining', () => {
    const total = addProgress(
      progress({ events: 2, failed: 1, skipped: 4, remaining: 9 }),
      progress({ events: 3, calendars: 1, skipped: 4, remaining: 4 }),
    );
    assert.deepEqual(
      total,
      progress({ events: 5, calendars: 1, failed: 1, skipped: 4, remaining: 4 }),
    );
  });
});

describe('runCleanup', () => {
  const steps = (...results: (CleanupProgress | 'ok' | Error)[]) => {
    let call = 0;
    return {
      calls: () => call,
      step: () => {
        const result = results[Math.min(call, results.length - 1)] ?? 'ok';
        call += 1;
        if (result === 'ok') {
          return Promise.resolve('finished');
        }
        return Promise.reject(result instanceof Error ? result : incomplete(result));
      },
    };
  };

  it('calls again while each answer made progress, then finishes', async () => {
    const seen: number[] = [];
    const run = steps(
      progress({ events: 2, remaining: 4 }),
      progress({ events: 3, remaining: 1 }),
      'ok',
    );
    const result = await runCleanup(run.step, {
      shouldContinue: () => true,
      onProgress: (total) => seen.push(total.events),
    });
    assert.equal(run.calls(), 3);
    assert.deepEqual(seen, [2, 5]);
    assert.equal(result.kind, 'done');
    assert.equal(result.totals.events, 5);
  });
  it('stops on a call that made no progress', async () => {
    const run = steps(progress({ events: 2, remaining: 4 }), progress({ events: 1, remaining: 4 }));
    const result = await runCleanup(run.step, always);
    assert.equal(run.calls(), 2);
    assert.equal(result.kind, 'incomplete');
  });
  it('stops when cancelled', async () => {
    const run = steps(progress({ events: 2, remaining: 4 }), 'ok');
    const result = await runCleanup(run.step, { ...always, shouldContinue: () => false });
    assert.equal(run.calls(), 1);
    assert.equal(result.kind, 'incomplete');
  });
  it('stops on another error', async () => {
    const run = steps(progress({ events: 2, remaining: 4 }), new Error('offline'));
    const result = await runCleanup(run.step, always);
    assert.equal(run.calls(), 2);
    assert.equal(result.kind, 'error');
  });
  it('never calls more than the cap', async () => {
    let remaining = MAX_CLEANUP_CALLS + 50;
    let calls = 0;
    const result = await runCleanup(() => {
      calls += 1;
      remaining -= 1;
      return Promise.reject(incomplete(progress({ events: 1, remaining })));
    }, always);
    assert.equal(calls, MAX_CLEANUP_CALLS);
    assert.equal(result.kind, 'incomplete');
  });
});

describe('finishProgress', () => {
  it('adds the last answer to the earlier totals and leaves nothing remaining', () => {
    const all = finishProgress(
      progress({ events: 5, calendars: 1, failed: 1, skipped: 2, remaining: 4 }),
      progress({ events: 3, calendars: 1, failed: 2, skipped: 1 }),
    );
    assert.deepEqual(
      all,
      progress({ events: 8, calendars: 2, failed: 3, skipped: 2, remaining: 0 }),
    );
  });
  it('keeps the totals when the server sent no counts (204)', () => {
    const totals = progress({ events: 5 });
    assert.deepEqual(finishProgress(totals, null), totals);
  });
  it('reports a one-call disconnect on its own', () => {
    assert.deepEqual(
      finishProgress(NO_PROGRESS, progress({ events: 2, failed: 1 })),
      progress({ events: 2, failed: 1 }),
    );
  });
});
