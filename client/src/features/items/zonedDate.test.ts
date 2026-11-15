import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dateInZone, noonInZone, timeInZone } from './zonedDate.ts';

describe('dateInZone', () => {
  it('is the calendar date in the zone, not in UTC', () => {
    // 22:30 UTC on 11 Nov is already 12 Nov at 00:30 in Jerusalem (UTC+2 in winter).
    assert.equal(dateInZone('2026-11-11T22:30:00Z', 'Asia/Jerusalem'), '2026-11-12');
    assert.equal(dateInZone('2026-11-11T22:30:00Z', 'America/New_York'), '2026-11-11');
  });
});

describe('noonInZone', () => {
  it('is noon wall-clock in the zone (winter and summer offsets)', () => {
    assert.equal(noonInZone('2026-11-12', 'Asia/Jerusalem'), '2026-11-12T10:00:00.000Z');
    assert.equal(noonInZone('2026-07-12', 'Asia/Jerusalem'), '2026-07-12T09:00:00.000Z');
  });

  it('survives the DST change day', () => {
    // Spring forward in New York on 8 Mar 2026: noon is EDT (UTC-4).
    assert.equal(noonInZone('2026-03-08', 'America/New_York'), '2026-03-08T16:00:00.000Z');
  });

  it('round-trips through dateInZone', () => {
    for (const zone of ['Asia/Jerusalem', 'America/Los_Angeles', 'Pacific/Auckland']) {
      assert.equal(dateInZone(noonInZone('2026-10-25', zone), zone), '2026-10-25');
    }
  });
});

describe('timeInZone', () => {
  it('is the 24-hour wall clock in the zone', () => {
    assert.equal(timeInZone('2026-11-11T22:30:00Z', 'Asia/Jerusalem'), '00:30');
    assert.equal(timeInZone('2026-07-01T13:05:00Z', 'Asia/Jerusalem'), '16:05');
    assert.equal(timeInZone('2026-07-01T00:00:00Z', 'UTC'), '00:00');
  });
});
