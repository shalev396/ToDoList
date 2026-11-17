import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFixtureDates, resolveOffset } from './fixtureDates.js';

const TZ = 'Asia/Jerusalem';
// 2026-11-12 10:15 in Jerusalem (UTC+2 in November).
const NOW = new Date('2026-11-12T08:15:00.000Z');

describe('fixture dates', () => {
  it('sets a local wall-clock time on a shifted day', () => {
    assert.equal(resolveOffset('+0d@14:00', NOW, TZ).toISOString(), '2026-11-12T12:00:00.000Z');
    assert.equal(resolveOffset('+2d@09:30', NOW, TZ).toISOString(), '2026-11-14T07:30:00.000Z');
    assert.equal(resolveOffset('-1w@00:00', NOW, TZ).toISOString(), '2026-11-04T22:00:00.000Z');
  });

  it('keeps the time of now without @, and supports hours and minutes', () => {
    assert.equal(resolveOffset('-3d', NOW, TZ).toISOString(), '2026-11-09T08:15:00.000Z');
    assert.equal(resolveOffset('+2h+30m', NOW, TZ).toISOString(), '2026-11-12T10:45:00.000Z');
  });

  it('is DST-safe: 14:00 local is the right instant on both sides of the October switch', () => {
    const beforeSwitch = new Date('2026-10-24T09:00:00.000Z'); // IDT, UTC+3
    assert.equal(
      resolveOffset('+0d@14:00', beforeSwitch, TZ).toISOString(),
      '2026-10-24T11:00:00.000Z',
    );
    assert.equal(
      resolveOffset('+2d@14:00', beforeSwitch, TZ).toISOString(),
      '2026-10-26T12:00:00.000Z',
    );
  });

  it('replaces tokens in JSON text with strings or bare numbers', () => {
    const text = JSON.stringify({
      due: '{{date:+1d}}',
      start: '{{datetime:+0d@16:00}}',
      moodle: '{{epoch:+0d@16:00}}',
      clickup: '{{epochms:+0d@16:00}}',
      untouched: 'plain',
    });
    const out = JSON.parse(resolveFixtureDates(text, NOW, TZ)) as Record<string, unknown>;
    assert.deepEqual(out, {
      due: '2026-11-13',
      start: '2026-11-12T14:00:00.000Z',
      moodle: 1794492000,
      clickup: 1794492000000,
      untouched: 'plain',
    });
  });

  it('rejects malformed offsets', () => {
    assert.throws(() => resolveOffset('tomorrow', NOW, TZ), /Bad fixture date/);
    assert.throws(() => resolveOffset('+1d@25', NOW, TZ), /Bad fixture time/);
  });
});
