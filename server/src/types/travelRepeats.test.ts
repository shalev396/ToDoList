/**
 * "Every repeat" of an imported event: the weekday and local time, the title as compared, and the
 * rule an event follows when choices were made from different weeks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  latestRepeats,
  matchesRepeats,
  repeatSlotOf,
  repeatTitleOf,
  type RepeatsScope,
} from './travelRepeats.js';

const ZONE = 'Asia/Jerusalem';
const scope = (from: string, title = 'Calculus'): RepeatsScope => ({
  kind: 'repeats',
  containerId: 'cal',
  title,
  weekday: 5,
  startTime: '10:30',
  from,
});
const event = (
  startAt: string,
  title = 'Calculus',
): { containerId: string; title: string; startAt: Date } => ({
  containerId: 'cal',
  title,
  startAt: new Date(startAt),
});

describe('repeats', () => {
  it('reads weekday and local time in the zone, across the spring DST change (2027-03-26)', () => {
    // Fridays at 10:30 local: UTC+2 before the change, UTC+3 after it.
    assert.deepEqual(repeatSlotOf(new Date('2027-03-19T08:30:00.000Z'), ZONE), {
      weekday: 5,
      startTime: '10:30',
    });
    assert.deepEqual(repeatSlotOf(new Date('2027-03-26T07:30:00.000Z'), ZONE), {
      weekday: 5,
      startTime: '10:30',
    });
    const rule = scope('2027-03-19T08:30:00.000Z');
    assert.equal(matchesRepeats(rule, event('2027-03-26T07:30:00.000Z'), ZONE), true);
    assert.equal(matchesRepeats(rule, event('2027-04-02T07:30:00.000Z'), ZONE), true);
    // The same UTC time after the change is an hour later locally.
    assert.equal(matchesRepeats(rule, event('2027-03-26T08:30:00.000Z'), ZONE), false);
  });

  it('compares titles trimmed and NFC-normalised, case counted', () => {
    assert.equal(repeatTitleOf('  Café '), 'Café');
    const rule = scope('2027-03-19T08:30:00.000Z', repeatTitleOf('Café'));
    assert.equal(matchesRepeats(rule, event('2027-03-26T07:30:00.000Z', ' Café'), ZONE), true);
    assert.equal(matchesRepeats(rule, event('2027-03-26T07:30:00.000Z', 'café'), ZONE), false);
  });

  it('an event follows the choice made from the latest start at or before it', () => {
    const week3 = { id: 'w3', scope: scope('2027-01-15T08:30:00.000Z') };
    const week5 = { id: 'w5', scope: scope('2027-01-29T08:30:00.000Z') };
    const rules = [week3, week5];
    const pick = (start: string): string | null =>
      latestRepeats(rules, event(start), ZONE)?.id ?? null;
    assert.equal(pick('2027-01-08T08:30:00.000Z'), null);
    assert.equal(pick('2027-01-15T08:30:00.000Z'), 'w3');
    assert.equal(pick('2027-01-22T08:30:00.000Z'), 'w3');
    assert.equal(pick('2027-01-29T08:30:00.000Z'), 'w5');
    assert.equal(pick('2027-02-05T08:30:00.000Z'), 'w5');
  });
});
