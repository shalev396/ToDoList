import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DATE_PRESETS } from '@api-types/builder.ts';
import { resolveDatePreset as serverResolveDatePreset } from '../../../../../server/src/builder/dates.ts';
import { resolveDatePreset, startOfToday } from './datePresets.ts';

const INSTANTS = [
  '2026-11-12T21:59:00Z', // 23:59 in Jerusalem
  '2026-11-12T22:01:00Z', // 00:01 the next day in Jerusalem
  '2026-03-27T00:30:00Z', // the DST start week (Jerusalem: Friday 2026-03-27)
  '2026-10-25T00:30:00Z', // the DST end day (Jerusalem: Sunday 2026-10-25)
  '2026-02-15T12:00:00Z', // a semester's last day
  '2026-07-20T12:00:00Z', // between semesters
  '2026-12-31T23:30:00Z', // a year's end in UTC
];
const ZONES = ['Asia/Jerusalem', 'UTC', 'America/New_York', 'Pacific/Kiritimati'];

describe('resolveDatePreset', () => {
  it('matches the server’s for every preset, instant, zone and week start', () => {
    for (const instant of INSTANTS) {
      for (const timeZone of ZONES) {
        for (const weekStart of ['sun', 'mon'] as const) {
          for (const preset of DATE_PRESETS) {
            const now = new Date(instant);
            assert.deepEqual(
              resolveDatePreset(preset, now, timeZone, weekStart),
              serverResolveDatePreset(preset, now, timeZone, weekStart),
              `${preset} at ${instant} in ${timeZone} (${weekStart})`,
            );
          }
        }
      }
    }
  });
});

describe('startOfToday', () => {
  it('is local midnight, on either side of it', () => {
    assert.equal(
      startOfToday(new Date('2026-11-12T21:59:00Z'), 'Asia/Jerusalem').toISOString(),
      '2026-11-11T22:00:00.000Z',
    );
    assert.equal(
      startOfToday(new Date('2026-11-12T22:01:00Z'), 'Asia/Jerusalem').toISOString(),
      '2026-11-12T22:00:00.000Z',
    );
  });

  it('starts the DST end day at the summer offset (a 25-hour day)', () => {
    assert.equal(
      startOfToday(new Date('2026-10-25T12:00:00Z'), 'Asia/Jerusalem').toISOString(),
      '2026-10-24T21:00:00.000Z',
    );
  });
});
