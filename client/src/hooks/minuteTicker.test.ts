import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { startMinuteTicker, type VisibilitySource } from './minuteTicker.ts';

const MINUTE = 60_000;

/** Stands in for `document`: an event target with a visibility state the test can flip. */
class FakeDocument extends EventTarget implements VisibilitySource {
  visibilityState = 'visible';

  setVisibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

describe('startMinuteTicker', () => {
  beforeEach(() => {
    // 30 seconds past a minute boundary.
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 30_000 });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('ticks at the next minute boundary, then at every boundary after it', () => {
    let ticks = 0;
    const stop = startMinuteTicker(() => {
      ticks += 1;
    });
    mock.timers.tick(29_999);
    assert.equal(ticks, 0);
    mock.timers.tick(1);
    assert.equal(ticks, 1);
    mock.timers.tick(MINUTE);
    assert.equal(ticks, 2);
    // A timer armed inside a tick only runs on a later tick() call, so step a minute at a time.
    for (let minute = 0; minute < 3; minute += 1) {
      mock.timers.tick(MINUTE);
    }
    assert.equal(ticks, 5);
    stop();
  });

  it('re-arms from the clock, so a late tick does not push the next one off the boundary', () => {
    let ticks = 0;
    const stop = startMinuteTicker(() => {
      ticks += 1;
    });
    // The first tick is due at 60 000 but only runs at 60 500 (a busy or throttled tab).
    mock.timers.setTime(60_499);
    mock.timers.tick(1);
    assert.equal(ticks, 1);
    // The next one still lands on the boundary at 120 000, not at 120 500.
    mock.timers.tick(59_499);
    assert.equal(ticks, 1);
    mock.timers.tick(1);
    assert.equal(ticks, 2);
    stop();
  });

  it('refreshes at once when the page becomes visible again, and keeps to the boundary', () => {
    const page = new FakeDocument();
    let ticks = 0;
    const stop = startMinuteTicker(() => {
      ticks += 1;
    }, page);
    page.setVisibility('hidden');
    assert.equal(ticks, 0);
    page.setVisibility('visible');
    assert.equal(ticks, 1);
    // One tick at the next boundary (30 s away), not a second timer running alongside.
    mock.timers.tick(30_000);
    assert.equal(ticks, 2);
    mock.timers.tick(MINUTE);
    assert.equal(ticks, 3);
    stop();
  });

  it('stops ticking and listening once stopped', () => {
    const page = new FakeDocument();
    let ticks = 0;
    const stop = startMinuteTicker(() => {
      ticks += 1;
    }, page);
    stop();
    mock.timers.tick(5 * MINUTE);
    page.setVisibility('hidden');
    page.setVisibility('visible');
    assert.equal(ticks, 0);
  });
});
