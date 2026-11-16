/** Retry never creates twice (H5 C1): the same request id after a failed request, a new one only on purpose. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nextAttempt, type Phase } from './retry.ts';

const copy = {
  integrationId: 'i',
  provider: 'jira' as const,
  key: null,
  url: '',
  liveStatus: null,
  requestId: 'r1',
};
let n = 0;
const makeId = (): string => `new-${String((n += 1))}`;

describe('nextAttempt', () => {
  it('a network error, then Retry, sends the same request id', () => {
    const phase: Phase = { kind: 'error', message: 'timeout' };
    assert.deepEqual(nextAttempt(phase, 'r1', makeId), {
      requestId: 'r1',
      retryAnyway: false,
      warn: false,
    });
  });

  it('after an explicit failure a new id is made', () => {
    const phase: Phase = {
      kind: 'outcome',
      outcome: { status: 'failed', reason: 'rejected', copy: { ...copy, status: 'failed' } },
    };
    const next = nextAttempt(phase, 'r1', makeId);
    assert.notEqual(next.requestId, 'r1');
    assert.equal(next.retryAnyway, false);
    assert.equal(next.warn, false);
  });

  it('"may exist" asks first, makes a new id and says retryAnyway', () => {
    const phase: Phase = {
      kind: 'outcome',
      outcome: { status: 'unknown', copy: { ...copy, status: 'unknown' } },
    };
    const next = nextAttempt(phase, 'r1', makeId);
    assert.notEqual(next.requestId, 'r1');
    assert.equal(next.retryAnyway, true);
    assert.equal(next.warn, true);
  });
});

describe('retry anyway from the item sheet', () => {
  it('is sent only for the confirmed integration, never for the whole selection', async () => {
    const { retryAnywayIds, needsRetryWarning } = await import('./retry.ts');
    const focus = { integrationId: 'jira-1', anyway: true };
    assert.equal(needsRetryWarning(focus, ['jira-1', 'linear-1'], false), true);
    assert.deepEqual([...retryAnywayIds(focus, false)], []);
    assert.deepEqual([...retryAnywayIds(focus, true)], ['jira-1']);
    assert.equal(retryAnywayIds(focus, true).has('linear-1'), false);
    assert.equal(needsRetryWarning(focus, ['jira-1'], true), false);
    assert.equal(
      needsRetryWarning({ integrationId: 'jira-1', anyway: false }, ['jira-1'], false),
      false,
    );
    assert.equal(needsRetryWarning(null, ['jira-1'], false), false);
    assert.deepEqual([...retryAnywayIds(null, true)], []);
  });
});
