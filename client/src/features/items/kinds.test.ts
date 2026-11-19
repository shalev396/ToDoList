/** Which rows get a to-do's controls: local to-dos only, never reserved time or mirrored items. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isMarkable, isScheduledKind } from './kinds.ts';

const row = (kind: string, provider = 'local') => ({ kind, source: { provider } });

describe('isMarkable', () => {
  it('a local to-do is ticked off', () => {
    assert.equal(isMarkable(row('todo')), true);
  });

  it('a time block, an area and a travel leg are reserved time, never ticked', () => {
    assert.equal(isMarkable(row('block')), false);
    assert.equal(isMarkable(row('travel')), false);
  });

  it('a mirrored item belongs to its provider', () => {
    assert.equal(isMarkable(row('issue', 'jira')), false);
    assert.equal(isMarkable(row('event', 'google_calendar')), false);
  });
});

describe('isScheduledKind', () => {
  it('names the two reserved-time kinds only', () => {
    assert.deepEqual(['todo', 'block', 'travel', 'event', 'task'].filter(isScheduledKind), [
      'block',
      'travel',
    ]);
  });
});
