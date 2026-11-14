import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarDaysFrom, dueChipText, dueText, initials, isOverdue } from './format.ts';

const JERUSALEM = 'Asia/Jerusalem';
// Wednesday 11 November 2026, 12:00 in Jerusalem.
const now = new Date('2026-11-11T10:00:00Z');

describe('isOverdue', () => {
  it('is overdue once the due time has passed', () => {
    assert.equal(isOverdue(new Date('2026-11-11T09:59:00Z'), now), true);
  });

  it('is not overdue before the due time', () => {
    assert.equal(isOverdue(new Date('2026-11-11T10:01:00Z'), now), false);
  });

  it('is never overdue once done', () => {
    assert.equal(isOverdue(new Date('2026-11-09T09:00:00Z'), now, true), false);
  });
});

describe('due text', () => {
  // Friday 13 November, 23:59 in Jerusalem.
  const friday = new Date('2026-11-13T21:59:00Z');

  it('counts calendar days in the zone, not 24-hour periods', () => {
    assert.equal(calendarDaysFrom(now, friday, JERUSALEM), 2);
    // 00:30 on 12 Nov in Jerusalem is still 11 Nov in UTC.
    assert.equal(calendarDaysFrom(now, new Date('2026-11-11T22:30:00Z'), JERUSALEM), 1);
  });

  it('reads relative plus absolute: "in 2 days · Fri 13 Nov"', () => {
    assert.equal(dueText(friday, now, 'en-GB', JERUSALEM), 'in 2 days · Fri 13 Nov');
  });

  it('gives the time instead of the date within a day', () => {
    const tomorrow = new Date('2026-11-12T21:59:00Z');
    assert.equal(dueText(tomorrow, now, 'en-GB', JERUSALEM), 'tomorrow · 23:59');
    assert.equal(dueChipText(tomorrow, now, 'en-GB', JERUSALEM), 'Tomorrow');
  });

  it('reads naturally in Hebrew', () => {
    assert.equal(dueText(friday, now, 'he-IL', JERUSALEM), 'מחרתיים · יום ו׳, 13 בנוב׳');
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words, in any script', () => {
    assert.equal(initials('Noa Levi'), 'NL');
    assert.equal(initials('נועה לוי'), 'נל');
    assert.equal(initials('  Yuval  Ben Ami '), 'YB');
    assert.equal(initials('Dana'), 'D');
  });
});
