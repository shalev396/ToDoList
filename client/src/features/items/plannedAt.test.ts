import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatPlannedAt,
  createCommitPolicy,
  createLatestWins,
  isCommittable,
  isPlannedTime,
  isRealDate,
  parsePlannedAt,
  type FieldEvent,
} from './plannedAt.ts';

describe('plannedAt', () => {
  it('splits a day and a day with a time', () => {
    assert.deepEqual(parsePlannedAt('2026-03-05'), { date: '2026-03-05', time: '' });
    assert.deepEqual(parsePlannedAt('2026-03-05T09:30'), { date: '2026-03-05', time: '09:30' });
  });
  it('reads nothing as empty parts', () => {
    assert.deepEqual(parsePlannedAt(null), { date: '', time: '' });
    assert.deepEqual(parsePlannedAt(undefined), { date: '', time: '' });
    assert.deepEqual(parsePlannedAt('soon'), { date: '', time: '' });
    assert.deepEqual(parsePlannedAt('2026-02-30'), { date: '', time: '' });
  });
  it('formats a day, or a day with a time', () => {
    assert.equal(formatPlannedAt({ date: '2026-03-05', time: '' }), '2026-03-05');
    assert.equal(formatPlannedAt({ date: '2026-03-05', time: '09:30' }), '2026-03-05T09:30');
  });
  it('never makes a time without a day, and a bad time is left out', () => {
    assert.equal(formatPlannedAt({ date: '', time: '09:30' }), null);
    assert.equal(formatPlannedAt({ date: '', time: '' }), null);
    assert.equal(formatPlannedAt({ date: '2026-03-05', time: '25:00' }), '2026-03-05');
  });
  it('keeps to the years 1970 to 2999', () => {
    assert.equal(formatPlannedAt({ date: '1970-01-01', time: '' }), '1970-01-01');
    assert.equal(formatPlannedAt({ date: '2999-12-31', time: '' }), '2999-12-31');
    assert.equal(formatPlannedAt({ date: '1969-12-31', time: '' }), null);
    assert.equal(formatPlannedAt({ date: '0002-05-01', time: '' }), null);
    assert.equal(formatPlannedAt({ date: '3000-01-01', time: '' }), null);
    assert.deepEqual(parsePlannedAt('0202-05-01'), { date: '', time: '' });
  });
  it('knows what a picker may save at once', () => {
    assert.equal(isRealDate('2026-03-05'), true);
    assert.equal(isRealDate('2026-03-5'), false);
    assert.equal(isRealDate('0202-05-01'), false);
    assert.equal(isPlannedTime('09:30'), true);
    assert.equal(isPlannedTime('9:3'), false);
    assert.equal(isCommittable({ date: '2026-03-05', time: '' }), true);
    assert.equal(isCommittable({ date: '2026-03-05', time: '09:30' }), true);
    assert.equal(isCommittable({ date: '2026-03-05', time: '09:' }), false);
    assert.equal(isCommittable({ date: '2026-02-30', time: '' }), false);
    assert.equal(isCommittable({ date: '3000-01-01', time: '' }), false);
    assert.equal(isCommittable({ date: '', time: '' }), false);
  });
  it('round-trips', () => {
    for (const value of ['2026-12-31', '2026-12-31T23:59', '2024-02-29T00:00']) {
      assert.equal(formatPlannedAt(parsePlannedAt(value)), value);
    }
  });
});

describe('createCommitPolicy (Chromium’s events)', () => {
  // Chromium 157: each typed segment of <input type="date"> fires `input` as a plain Event, no
  // `inputType`, while the input has the focus; a pick from its picker fires the same Event. The
  // policy reads only what the page sees: pointer presses, keys, changes (focused or not), blur.
  const replay = (events: FieldEvent[]) => {
    const policy = createCommitPolicy();
    return events.map((event) => policy.handle(event));
  };
  const change = (focused = true): FieldEvent => ({ type: 'change', focused });
  const key = (name: string): FieldEvent => ({ type: 'keydown', key: name });

  it('typing over a whole date saves nothing per segment, then once on blur', () => {
    // Click into the day, type 1, 1 (2026-12-01, then 2026-12-11), Tab to the month, type 0 2.
    const actions = replay([
      { type: 'pointerdown' },
      key('1'),
      change(),
      key('1'),
      change(),
      key('Tab'),
      key('0'),
      change(),
      key('2'),
      change(),
      { type: 'blur' },
    ]);
    assert.deepEqual(
      actions.filter((action) => action !== null),
      ['commit'],
    );
    assert.equal(actions.at(-1), 'commit');
  });

  it('typing a time ("0930AM") saves once, on Enter', () => {
    const actions = replay([
      key('0'),
      change(),
      key('9'),
      change(),
      key('3'),
      change(),
      key('0'),
      change(),
      key('A'),
      key('Enter'),
    ]);
    assert.deepEqual(
      actions.filter((action) => action !== null),
      ['commit'],
    );
  });

  it('a pick from the picker saves at once, with the focus still on the input', () => {
    assert.deepEqual(replay([{ type: 'pointerdown' }, change()]), [null, 'commit']);
    // A second pick in a row saves again.
    assert.deepEqual(replay([{ type: 'pointerdown' }, change(), change()]), [
      null,
      'commit',
      'commit',
    ]);
  });

  it('a key after the press makes the next changes typing again', () => {
    assert.deepEqual(replay([{ type: 'pointerdown' }, key('ArrowUp'), change()]), [
      null,
      null,
      null,
    ]);
  });

  it('a change while the input has lost the focus is saved', () => {
    assert.deepEqual(replay([change(false)]), ['commit']);
  });

  it('Escape puts the saved value back; blur forgets the press', () => {
    assert.deepEqual(replay([key('Escape')]), ['reset']);
    assert.deepEqual(replay([{ type: 'pointerdown' }, { type: 'blur' }, change()]), [
      null,
      'commit',
      null,
    ]);
  });
});

describe('createLatestWins', () => {
  const gate = () => {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  };
  it('sends at once when idle', () => {
    const sent: string[] = [];
    const queue = createLatestWins((value: string) => {
      sent.push(value);
      return Promise.resolve();
    });
    queue.push('a');
    assert.deepEqual(sent, ['a']);
  });
  it('holds newer values while one is in flight; only the latest is sent after it', async () => {
    const sent: string[] = [];
    const first = gate();
    const queue = createLatestWins((value: string) => {
      sent.push(value);
      return value === 'a' ? first.promise : Promise.resolve();
    });
    queue.push('a');
    queue.push('b');
    queue.push('c');
    assert.deepEqual(sent, ['a']);
    assert.equal(queue.isBusy(), true);
    first.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ['a', 'c']);
    assert.equal(queue.isBusy(), false);
  });
  it('goes on after a failed send', async () => {
    const sent: string[] = [];
    const first = gate();
    const queue = createLatestWins((value: string) => {
      sent.push(value);
      return value === 'a'
        ? first.promise.then(() => Promise.reject(new Error('no')))
        : Promise.resolve();
    });
    queue.push('a');
    queue.push('b');
    first.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(sent, ['a', 'b']);
  });
});
