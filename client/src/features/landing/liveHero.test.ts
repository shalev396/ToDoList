import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { demoUpcomingDeadlines } from './demoData.ts';
import {
  applyLiveStep,
  initialLiveState,
  LIVE_SCRIPT,
  visibleDeadlines,
  type LiveState,
} from './liveHero.ts';

const now = new Date(2026, 10, 11, 9, 0);
const base = demoUpcomingDeadlines(now, 'en', 10);

function play(steps: number): LiveState {
  let state = initialLiveState(base);
  for (let i = 0; i < steps; i += 1) {
    state = applyLiveStep(state, base, now, 'en');
  }
  return state;
}

describe('the hero live script', () => {
  it('has 40 steps', () => {
    assert.equal(LIVE_SCRIPT.length, 40);
  });

  it('adds a deadline, marks it done, and drops it on the step after', () => {
    const added = play(1);
    assert.equal(added.last?.kind, 'deadline');
    assert.ok(added.deadlines.some((item) => item.id === 'quiz-2'));
    assert.equal(play(6).deadlines.find((item) => item.id === 'quiz-2')?.done, true);
    assert.equal(
      play(7).deadlines.some((item) => item.id === 'quiz-2'),
      false,
    );
  });

  it('lands an event on the clock and moves it, keeping its length', () => {
    assert.equal(
      play(2)
        .events.find((item) => item.id === 'lunch')
        ?.start.getHours(),
      12,
    );
    const shifted = play(7).events.find((item) => item.id === 'lunch');
    assert.ok(shifted);
    assert.equal(shifted.start.getMinutes(), 30);
    assert.equal(shifted.end.getTime() - shifted.start.getTime(), 45 * 60_000);
  });

  it('returns to the sample when the script loops', () => {
    const looped = play(LIVE_SCRIPT.length + 1);
    assert.equal(looped.events.length, 0);
    assert.equal(looped.deadlines.length, base.length + 1);
  });

  it('lists at most four deadlines, soonest first', () => {
    for (let steps = 0; steps <= LIVE_SCRIPT.length; steps += 1) {
      const shown = visibleDeadlines(play(steps), now);
      assert.ok(shown.length <= 4);
      for (let i = 1; i < shown.length; i += 1) {
        assert.ok((shown[i - 1]?.due.getTime() ?? 0) <= (shown[i]?.due.getTime() ?? 0));
      }
    }
  });
});
