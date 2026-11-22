import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DisabledState } from './Disabled.js';

const SLOT = new Date('2026-11-22T11:00:00.000Z');
const OTHER = new Date('2026-11-29T11:00:00.000Z');

describe('DisabledState', () => {
  it('nothing stored: nothing is disabled', () => {
    const state = DisabledState.of({ disabled: null, disabledOccurrences: [] });
    assert.deepEqual([state.whole, state.covers(SLOT), state.listed(SLOT)], [false, false, false]);
  });

  it('the whole item covers every occurrence, listed or not', () => {
    const state = DisabledState.of({ disabled: true, disabledOccurrences: [] });
    assert.deepEqual([state.whole, state.covers(SLOT), state.listed(SLOT)], [true, true, false]);
  });

  it('one occurrence by its original start, whatever form the instant was written in', () => {
    const state = DisabledState.of({
      disabled: null,
      disabledOccurrences: ['2026-11-22T13:00:00+02:00'],
    });
    assert.deepEqual(
      [state.covers(SLOT), state.listed(SLOT), state.covers(OTHER)],
      [true, true, false],
    );
    assert.equal(DisabledState.key(SLOT), '2026-11-22T11:00:00.000Z');
  });
});
