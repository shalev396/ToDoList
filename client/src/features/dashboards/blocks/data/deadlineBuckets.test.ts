import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deadlineBucket, groupDeadlines } from './deadlineBuckets.ts';

const TZ = 'Asia/Jerusalem'; // UTC+2 in November

describe('deadlineBucket', () => {
  // Wed 11 Nov 2026, 12:00 local.
  const now = new Date('2026-11-11T10:00:00Z');

  it('splits at local midnight, not UTC midnight', () => {
    assert.equal(deadlineBucket(new Date('2026-11-10T21:59:00Z'), now, TZ), 'overdue'); // 23:59 on the 10th
    assert.equal(deadlineBucket(new Date('2026-11-10T22:00:00Z'), now, TZ), 'today'); // 00:00 on the 11th
    assert.equal(deadlineBucket(new Date('2026-11-11T21:59:00Z'), now, TZ), 'today'); // 23:59 on the 11th
    assert.equal(deadlineBucket(new Date('2026-11-11T22:00:00Z'), now, TZ), 'week'); // 00:00 on the 12th
  });

  it('a deadline earlier today is today, not overdue', () => {
    assert.equal(deadlineBucket(new Date('2026-11-11T06:00:00Z'), now, TZ), 'today');
  });

  it('the week ends on Saturday (Sunday start) or Sunday (Monday start)', () => {
    assert.equal(deadlineBucket(new Date('2026-11-14T10:00:00Z'), now, TZ), 'week'); // Sat
    assert.equal(deadlineBucket(new Date('2026-11-15T10:00:00Z'), now, TZ), 'later'); // Sun
    assert.equal(deadlineBucket(new Date('2026-11-15T10:00:00Z'), now, TZ, 'mon'), 'week');
    assert.equal(deadlineBucket(new Date('2026-11-16T10:00:00Z'), now, TZ, 'mon'), 'later');
  });

  it('survives the spring-forward day (23 hours)', () => {
    const zone = 'America/New_York';
    const base = new Date('2026-03-08T12:00:00Z'); // Sun 8 Mar, the clocks went forward at 02:00
    assert.equal(deadlineBucket(new Date('2026-03-09T03:59:00Z'), base, zone), 'today'); // 23:59 EDT
    assert.equal(deadlineBucket(new Date('2026-03-09T04:00:00Z'), base, zone), 'week'); // 00:00 Mon
  });

  it('survives the fall-back day (25 hours)', () => {
    const zone = 'America/New_York';
    const base = new Date('2026-11-01T05:30:00Z'); // 01:30 EDT, first pass
    assert.equal(deadlineBucket(new Date('2026-11-02T04:59:00Z'), base, zone), 'today'); // 23:59 EST
    assert.equal(deadlineBucket(new Date('2026-11-02T05:00:00Z'), base, zone), 'week'); // 00:00 EST
  });
});

describe('groupDeadlines', () => {
  it('orders groups overdue, today, week, later and rows soonest first; skips empty groups', () => {
    const now = new Date('2026-11-11T10:00:00Z');
    const rows = [
      { id: 'later', at: new Date('2026-12-01T10:00:00Z') },
      { id: 'od2', at: new Date('2026-11-09T10:00:00Z') },
      { id: 'od1', at: new Date('2026-11-01T10:00:00Z') },
      { id: 'today', at: new Date('2026-11-11T15:00:00Z') },
    ];
    const groups = groupDeadlines(rows, (row) => row.at, now, TZ);
    assert.deepEqual(
      groups.map((group) => [group.bucket, group.rows.map((row) => row.id)]),
      [
        ['overdue', ['od1', 'od2']],
        ['today', ['today']],
        ['later', ['later']],
      ],
    );
  });
});
