import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlannedAt } from './PlannedAt.js';

describe('PlannedAt', () => {
  it('takes a local date, or a local date and time', () => {
    const day = PlannedAt.parse('2026-11-21');
    assert.equal(day.date, '2026-11-21');
    assert.equal(day.hasTime, false);
    assert.equal(day.toString(), '2026-11-21');
    const timed = PlannedAt.parse('2026-11-21T09:30');
    assert.equal(timed.date, '2026-11-21');
    assert.equal(timed.hasTime, true);
    assert.equal(JSON.stringify({ plannedAt: timed }), '{"plannedAt":"2026-11-21T09:30"}');
  });

  it('starts at its wall time in the workspace zone', () => {
    assert.equal(
      PlannedAt.parse('2026-11-21T09:30').startIn('Asia/Jerusalem').toISOString(),
      '2026-11-21T07:30:00.000Z',
    );
    assert.equal(
      PlannedAt.parse('2026-07-01').startIn('Asia/Jerusalem').toISOString(),
      '2026-06-30T21:00:00.000Z',
    );
  });

  it('refuses anything that is not a real date (400, never quoting the value)', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-11-21T24:00',
      '2026-11-21T09:60',
      '2026-11-21T9:30',
      '2026-11-21 09:30',
      '2026-11-21T09:30:00',
      '1969-12-31',
      'Saturday',
      '',
      42,
      null,
    ]) {
      assert.throws(
        () => PlannedAt.parse(bad),
        (error: unknown) =>
          (error as { statusCode?: unknown }).statusCode === 400 &&
          !(error as Error).message.includes(String(bad === '' ? 'x-none' : bad)),
        String(bad),
      );
      assert.equal(PlannedAt.from(bad), null);
    }
    assert.ok(PlannedAt.from('2028-02-29'));
  });

  it('reads where a calendar event now starts', () => {
    assert.equal(PlannedAt.fromEventStart({ date: '2026-11-21' }, 'UTC')?.toString(), '2026-11-21');
    assert.equal(
      PlannedAt.fromEventStart({ dateTime: '2026-11-21T07:30:00Z' }, 'Asia/Jerusalem')?.toString(),
      '2026-11-21T09:30',
    );
    assert.equal(PlannedAt.fromEventStart({ dateTime: 'soon' }, 'UTC'), null);
    assert.equal(PlannedAt.fromEventStart(undefined, 'UTC'), null);
  });

  it('compares by value', () => {
    assert.ok(PlannedAt.parse('2026-11-21').equals(PlannedAt.from('2026-11-21')));
    assert.equal(PlannedAt.parse('2026-11-21').equals(PlannedAt.from('2026-11-21T08:00')), false);
    assert.equal(PlannedAt.parse('2026-11-21').equals(null), false);
  });
});
