import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatPlannedAt, parsePlannedAt } from './plannedAt.ts';

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
  it('round-trips', () => {
    for (const value of ['2026-12-31', '2026-12-31T23:59', '2024-02-29T00:00']) {
      assert.equal(formatPlannedAt(parsePlannedAt(value)), value);
    }
  });
});
