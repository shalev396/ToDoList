import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrimaryCalendarView } from '@api-types/primaryCalendar.ts';
import {
  NO_REPEAT,
  buildRecurrence,
  repeatBlockOf,
  repeatProblem,
  untilOf,
  weekdayOf,
  weeklyDays,
  type Repeat,
} from './recurrence.ts';

const on = (patch: Partial<Repeat>): Repeat => ({ ...NO_REPEAT, ...patch });
const timed = { dueDate: '2026-11-18', allDay: false, timeZone: 'Asia/Jerusalem' };
const allDay = { ...timed, allDay: true };

/** What the server takes (server/src/classes/integration/RecurrenceRule.ts), as one pattern. */
const SERVER_LINE =
  /^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=[1-9]\d{0,2})?(;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*)?(;COUNT=[1-9]\d{0,2}|;UNTIL=\d{8}(T\d{6}Z)?)?$/;

describe('buildRecurrence', () => {
  it('does not repeat: nothing to send', () => {
    assert.equal(buildRecurrence(NO_REPEAT, timed), null);
  });

  it('daily, monthly and yearly are the frequency alone', () => {
    assert.deepEqual(buildRecurrence(on({ preset: 'daily' }), timed), ['RRULE:FREQ=DAILY']);
    assert.deepEqual(buildRecurrence(on({ preset: 'monthly' }), timed), ['RRULE:FREQ=MONTHLY']);
    assert.deepEqual(buildRecurrence(on({ preset: 'yearly' }), timed), ['RRULE:FREQ=YEARLY']);
  });

  it('weekly names its days, Monday first, or the due date’s own day', () => {
    assert.deepEqual(buildRecurrence(on({ preset: 'weekly', days: ['FR', 'MO', 'WE'] }), timed), [
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
    ]);
    // 2026-11-18 is a Wednesday.
    assert.deepEqual(buildRecurrence(on({ preset: 'weekly' }), timed), [
      'RRULE:FREQ=WEEKLY;BYDAY=WE',
    ]);
  });

  it('custom: an interval above 1, and days only with a weekly frequency', () => {
    assert.deepEqual(
      buildRecurrence(
        on({ preset: 'custom', interval: 2, frequency: 'WEEKLY', days: ['TU'] }),
        timed,
      ),
      ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,WE'],
    );
    assert.deepEqual(
      buildRecurrence(on({ preset: 'custom', interval: 1, frequency: 'DAILY' }), timed),
      ['RRULE:FREQ=DAILY'],
    );
    // Days picked earlier for a weekly rule never reach a yearly one (the server refuses BYDAY).
    assert.deepEqual(
      buildRecurrence(
        on({ preset: 'custom', interval: 3, frequency: 'YEARLY', days: ['MO'] }),
        timed,
      ),
      ['RRULE:FREQ=YEARLY;INTERVAL=3'],
    );
    assert.deepEqual(
      buildRecurrence(
        on({ preset: 'custom', interval: 6, frequency: 'MONTHLY', days: ['MO'] }),
        timed,
      ),
      ['RRULE:FREQ=MONTHLY;INTERVAL=6'],
    );
  });

  it('ends after N times, or on a date in the start’s own form', () => {
    assert.deepEqual(
      buildRecurrence(on({ preset: 'daily', end: { kind: 'after', count: 10 } }), timed),
      ['RRULE:FREQ=DAILY;COUNT=10'],
    );
    assert.deepEqual(
      buildRecurrence(on({ preset: 'daily', end: { kind: 'on', date: '2026-12-31' } }), allDay),
      ['RRULE:FREQ=DAILY;UNTIL=20261231'],
    );
    // Timed: the end of 31 Dec in Jerusalem (UTC+2 in winter) is 21:59:59 UTC.
    assert.deepEqual(
      buildRecurrence(on({ preset: 'daily', end: { kind: 'on', date: '2026-12-31' } }), timed),
      ['RRULE:FREQ=DAILY;UNTIL=20261231T215959Z'],
    );
  });

  it('every line it builds is one the server takes', () => {
    const ends: Repeat['end'][] = [
      { kind: 'never' },
      { kind: 'after', count: 1 },
      { kind: 'after', count: 999 },
      { kind: 'on', date: '2027-01-01' },
    ];
    const shapes: Partial<Repeat>[] = [
      { preset: 'daily' },
      { preset: 'weekly', days: ['SU', 'SA'] },
      { preset: 'monthly' },
      { preset: 'yearly' },
      ...(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((frequency) => ({
        preset: 'custom' as const,
        frequency,
        interval: 999,
        days: ['TH' as const],
      })),
    ];
    for (const shape of shapes) {
      for (const end of ends) {
        for (const context of [timed, allDay]) {
          const lines = buildRecurrence(on({ ...shape, end }), context);
          assert.ok(lines !== null && lines.length === 1);
          const [line = ''] = lines;
          assert.match(line, SERVER_LINE);
          assert.ok(line.length <= 300);
          if (line.includes('FREQ=YEARLY')) {
            assert.doesNotMatch(line, /BYDAY|BYMONTHDAY/);
          }
        }
      }
    }
  });

  it('builds nothing while the choice can’t be sent', () => {
    assert.equal(buildRecurrence(on({ preset: 'daily' }), { ...timed, dueDate: '' }), null);
    assert.equal(
      buildRecurrence(on({ preset: 'daily', end: { kind: 'after', count: 0 } }), timed),
      null,
    );
  });
});

describe('repeatProblem', () => {
  it('is none for no repeat, or a whole choice', () => {
    assert.equal(repeatProblem(NO_REPEAT, ''), null);
    assert.equal(repeatProblem(on({ preset: 'daily' }), '2026-11-18'), null);
  });

  it('needs a due date', () => {
    assert.equal(repeatProblem(on({ preset: 'weekly' }), ''), 'needsDue');
  });

  it('keeps the interval and the count to 1–999 whole numbers', () => {
    assert.equal(repeatProblem(on({ preset: 'custom', interval: 0 }), '2026-11-18'), 'interval');
    assert.equal(repeatProblem(on({ preset: 'custom', interval: 1000 }), '2026-11-18'), 'interval');
    assert.equal(repeatProblem(on({ preset: 'custom', interval: 1.5 }), '2026-11-18'), 'interval');
    assert.equal(
      repeatProblem(on({ preset: 'daily', end: { kind: 'after', count: 1000 } }), '2026-11-18'),
      'count',
    );
    // The interval of a preset is not the member's: it is never checked.
    assert.equal(repeatProblem(on({ preset: 'daily', interval: 0 }), '2026-11-18'), null);
  });

  it('wants a real end date, not before the due date', () => {
    assert.equal(
      repeatProblem(on({ preset: 'daily', end: { kind: 'on', date: '' } }), '2026-11-18'),
      'untilDate',
    );
    assert.equal(
      repeatProblem(on({ preset: 'daily', end: { kind: 'on', date: '2026-02-30' } }), '2026-11-18'),
      'untilDate',
    );
    assert.equal(
      repeatProblem(on({ preset: 'daily', end: { kind: 'on', date: '2026-11-17' } }), '2026-11-18'),
      'untilBeforeDue',
    );
    assert.equal(
      repeatProblem(on({ preset: 'daily', end: { kind: 'on', date: '2026-11-18' } }), '2026-11-18'),
      null,
    );
  });
});

describe('weekdays and UNTIL', () => {
  it('reads the weekday of a date', () => {
    assert.equal(weekdayOf('2026-11-16'), 'MO');
    assert.equal(weekdayOf('2026-11-22'), 'SU');
    assert.equal(weekdayOf('nope'), null);
  });

  it('always holds the due date’s day: Google counts the first event as one', () => {
    assert.deepEqual(weeklyDays(on({ days: [] }), '2026-11-20'), ['FR']);
    assert.deepEqual(weeklyDays(on({ days: ['SU', 'MO'] }), '2026-11-20'), ['MO', 'FR', 'SU']);
    assert.deepEqual(weeklyDays(on({ days: ['FR'] }), '2026-11-20'), ['FR']);
    assert.deepEqual(weeklyDays(on({ days: [] }), ''), []);
  });

  it('a Tuesday due date with only Thursday picked repeats on both (no hidden extra Tuesday)', () => {
    // 1 Dec 2026 is a Tuesday.
    assert.deepEqual(
      buildRecurrence(on({ preset: 'weekly', days: ['TH'] }), { ...timed, dueDate: '2026-12-01' }),
      ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'],
    );
  });

  it('writes UNTIL in summer time too', () => {
    // 1 July in Jerusalem is UTC+3.
    assert.equal(untilOf('2026-07-01', false, 'Asia/Jerusalem'), '20260701T205959Z');
    assert.equal(untilOf('2026-07-01', false, 'UTC'), '20260701T235959Z');
    assert.equal(untilOf('2026-07-01', true, 'Asia/Jerusalem'), '20260701');
  });
});

describe('repeatBlockOf', () => {
  const view = (patch: Partial<PrimaryCalendarView>): PrimaryCalendarView => ({
    state: 'active',
    reason: null,
    mine: true,
    integrationId: 'i1',
    calendarId: 'c1',
    ...patch,
  });

  it('only the workspace calendar’s own connection owner can create one', () => {
    assert.equal(repeatBlockOf(view({})), null);
    assert.equal(
      repeatBlockOf(view({ mine: false, integrationId: null, calendarId: null })),
      'notMine',
    );
  });

  it('says when there is none, when it is paused, and while it loads', () => {
    assert.equal(repeatBlockOf(view({ state: 'unset', mine: false })), 'unset');
    assert.equal(repeatBlockOf(view({ state: 'suspended', reason: 'read_only' })), 'suspended');
    assert.equal(repeatBlockOf(undefined), 'loading');
  });
});
