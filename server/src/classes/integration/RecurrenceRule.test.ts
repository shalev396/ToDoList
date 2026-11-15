/** The strict RRULE parser (plan Addendum A3): exactly the parts the Repeat control makes. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError } from '../../errors/ValidationError.js';
import { RecurrenceRule } from './RecurrenceRule.js';

const refused = (line: unknown): void => {
  assert.throws(
    () => RecurrenceRule.parse(line),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.statusCode === 400 &&
      error.message.startsWith('recurrence: ') &&
      (typeof line !== 'string' || line.length < 12 || !error.message.includes(line)),
    String(line),
  );
};

describe('RecurrenceRule (a strict RRULE parser)', () => {
  it('takes what the Repeat control makes, and writes it back in a fixed order', () => {
    const cases: [string, string][] = [
      ['RRULE:FREQ=DAILY', 'RRULE:FREQ=DAILY'],
      ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'],
      ['RRULE:INTERVAL=2;FREQ=WEEKLY;COUNT=10', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10'],
      ['RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1'],
      ['RRULE:FREQ=MONTHLY;BYDAY=2TU', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'],
      ['RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR'],
      ['RRULE:FREQ=YEARLY;INTERVAL=2', 'RRULE:FREQ=YEARLY;INTERVAL=2'],
      ['RRULE:FREQ=DAILY;UNTIL=20261231', 'RRULE:FREQ=DAILY;UNTIL=20261231'],
      ['RRULE:FREQ=WEEKLY;UNTIL=20261231T215959Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261231T215959Z'],
    ];
    for (const [line, written] of cases) {
      const rule = RecurrenceRule.parse(line);
      assert.equal(rule.toString(), written, line);
      assert.ok(Object.isFrozen(rule));
      assert.ok(rule.equals(RecurrenceRule.parse(written)));
    }
    const rule = RecurrenceRule.parse('RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=SA;UNTIL=20270101');
    assert.equal(rule.freq, 'WEEKLY');
    assert.equal(rule.interval, 3);
    assert.deepEqual(rule.byDay, ['SA']);
    assert.equal(rule.untilIsDate, true);
    assert.equal(
      JSON.stringify({ rule }),
      '{"rule":"RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=SA;UNTIL=20270101"}',
    );
  });

  it('refuses anything else, never quoting it', () => {
    for (const line of [
      // Not one RRULE line.
      'FREQ=DAILY',
      'rrule:FREQ=DAILY',
      'EXDATE:20261120T100000Z',
      'RDATE:20261120',
      'RRULE:',
      `RRULE:FREQ=DAILY;${'X'.repeat(400)}`,
      42,
      null,
      // Parts it does not take, or given twice.
      'RRULE:FREQ=DAILY;BYSETPOS=1',
      'RRULE:FREQ=DAILY;WKST=MO',
      'RRULE:FREQ=MONTHLY;BYMONTH=1',
      'RRULE:FREQ=DAILY;BYHOUR=9',
      'RRULE:FREQ=DAILY;FREQ=WEEKLY',
      // Malformed or out of range.
      'RRULE:FREQ=HOURLY',
      'RRULE:FREQ=SECONDLY',
      'RRULE:INTERVAL=2',
      'RRULE:FREQ=daily',
      'RRULE:FREQ=DAILY;INTERVAL=0',
      'RRULE:FREQ=DAILY;INTERVAL=1000',
      'RRULE:FREQ=DAILY;COUNT=-1',
      'RRULE:FREQ=DAILY;COUNT=01',
      'RRULE:FREQ=WEEKLY;BYDAY=XX',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,MO',
      'RRULE:FREQ=WEEKLY;BYDAY=',
      'RRULE:FREQ=WEEKLY;BYDAY=2MO',
      'RRULE:FREQ=MONTHLY;BYDAY=6MO',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=32',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=0',
      'RRULE:FREQ=WEEKLY;BYMONTHDAY=1',
      // Yearly repeats on its start date: BYMONTHDAY or BYDAY would mean every month, or weekdays.
      'RRULE:FREQ=YEARLY;BYMONTHDAY=15',
      'RRULE:FREQ=YEARLY;BYDAY=-1FR',
      'RRULE:FREQ=YEARLY;BYDAY=MO',
      'RRULE:FREQ=DAILY;BYDAY=1MO',
      'RRULE:FREQ=DAILY;COUNT=3;UNTIL=20261231',
      'RRULE:FREQ=DAILY;UNTIL=20261331',
      'RRULE:FREQ=DAILY;UNTIL=20260230',
      'RRULE:FREQ=DAILY;UNTIL=20261231T250000Z',
      'RRULE:FREQ=DAILY;UNTIL=20261231T235959',
      'RRULE:FREQ=DAILY;UNTIL=2026-12-31',
      'RRULE:FREQ=DAILY;;COUNT=2',
      'RRULE:FREQ=DAILY;COUNT=2;',
      'RRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY',
      'RRULE:FREQ=DAILY;X-NAME=1',
    ]) {
      refused(line);
    }
  });

  it('an event takes exactly one line, whose UNTIL matches it (a date when all day)', () => {
    assert.equal(RecurrenceRule.fromLines(['RRULE:FREQ=DAILY']).toString(), 'RRULE:FREQ=DAILY');
    for (const lines of [[], ['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'], 'RRULE:FREQ=DAILY', null]) {
      assert.throws(() => RecurrenceRule.fromLines(lines), ValidationError);
    }
    const dated = RecurrenceRule.parse('RRULE:FREQ=DAILY;UNTIL=20261231');
    const timed = RecurrenceRule.parse('RRULE:FREQ=DAILY;UNTIL=20261231T215959Z');
    const open = RecurrenceRule.parse('RRULE:FREQ=DAILY;COUNT=5');
    assert.deepEqual(
      [dated.fits(true), dated.fits(false), timed.fits(true), timed.fits(false)],
      [true, false, false, true],
    );
    assert.ok(open.fits(true) && open.fits(false));
  });
});
