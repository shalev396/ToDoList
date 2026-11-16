import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  reservedTexts,
  SAVED_VISIBLE_MS,
  saveStatusView,
  scheduleFade,
  type SaveState,
} from './save-status-state.ts';

const TEXTS = { saving: 'Saving…', saved: 'Saved', error: 'Couldn’t save' };
const STATES: SaveState[] = ['idle', 'saving', 'saved', 'error'];

describe('SaveStatus', () => {
  it('says what is happening: nothing when idle, saving, saved, or the error', () => {
    assert.deepEqual(saveStatusView('idle', false), { text: null, hidden: true });
    assert.deepEqual(saveStatusView('saving', false), { text: 'saving', hidden: false });
    assert.deepEqual(saveStatusView('saved', false), { text: 'saved', hidden: false });
    assert.deepEqual(saveStatusView('error', false), { text: 'error', hidden: false });
  });

  it('reserves the room of its longest text in every state: nothing shifts', () => {
    // The sizer is made of these, whatever the state (save-status.tsx): the width never changes.
    assert.deepEqual(reservedTexts(TEXTS), ['Saving…', 'Saved', 'Couldn’t save']);
    for (const state of STATES) {
      const { text } = saveStatusView(state, false);
      assert.ok(text === null || reservedTexts(TEXTS).includes(TEXTS[text]), state);
    }
  });

  it('"Saved" fades out after about 2 s, keeping its text while it does', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const faded: string[] = [];
      const cancel = scheduleFade('saved', () => faded.push('faded'));
      assert.equal(typeof cancel, 'function');
      mock.timers.tick(SAVED_VISIBLE_MS - 1);
      assert.deepEqual(faded, []);
      mock.timers.tick(1);
      assert.deepEqual(faded, ['faded']);
      assert.deepEqual(saveStatusView('saved', true), { text: 'saved', hidden: true });
    } finally {
      mock.timers.reset();
    }
  });

  it('an error clears a stale "Saved" at once, and only "Saved" ever fades', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const faded: string[] = [];
      const cancel = scheduleFade('saved', () => faded.push('faded'));
      // The state moved on to an error before the fade: it is cancelled, and the error shows.
      cancel?.();
      mock.timers.tick(SAVED_VISIBLE_MS);
      assert.equal(faded.length, 0);
      assert.deepEqual(saveStatusView('error', true), { text: 'error', hidden: false });
      for (const state of ['idle', 'saving', 'error'] as const) {
        assert.equal(
          scheduleFade(state, () => faded.push(state)),
          undefined,
        );
      }
      mock.timers.tick(SAVED_VISIBLE_MS * 2);
      assert.equal(faded.length, 0);
    } finally {
      mock.timers.reset();
    }
  });
});
