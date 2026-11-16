import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PrimaryCalendar, PrimaryCalendarStatus } from './PrimaryCalendar.js';
import { WorkspaceSettings } from './WorkspaceSettings.js';

const settings = (primaryCalendar?: unknown): WorkspaceSettings =>
  WorkspaceSettings.from({
    timezone: 'UTC',
    weekStart: 'sun',
    topicRules: [],
    ...(primaryCalendar === undefined
      ? {}
      : { primaryCalendar: primaryCalendar as { integrationId: string; calendarId: string } }),
  });

describe('PrimaryCalendar', () => {
  it('is an integration and one of its calendars, checked', () => {
    const primary = PrimaryCalendar.of('i-1', 'me@example.test');
    assert.deepEqual(primary.toJSON(), { integrationId: 'i-1', calendarId: 'me@example.test' });
    assert.ok(primary.isOn('i-1'));
    assert.equal(primary.isOn('i-2'), false);
    assert.ok(primary.equals(PrimaryCalendar.of('i-1', 'me@example.test')));
    assert.equal(primary.equals(PrimaryCalendar.of('i-1', 'other')), false);
    assert.equal(primary.equals(null), false);
    for (const [integrationId, calendarId, field] of [
      ['', 'cal', 'integrationId'],
      ['i-1', 'two words', 'calendarId'],
      ['i-1', '', 'calendarId'],
    ] as const) {
      assert.throws(
        () => PrimaryCalendar.of(integrationId, calendarId),
        (error: unknown) =>
          (error as { statusCode?: unknown }).statusCode === 400 &&
          (error as Error).message.startsWith(field),
      );
    }
  });

  it('as stored: none, or anything malformed, reads as none', () => {
    assert.equal(settings().primaryCalendar, null);
    assert.equal(settings(null).primaryCalendar, null);
    assert.equal(settings({ integrationId: 'i-1' }).primaryCalendar, null);
    assert.equal(
      settings({ integrationId: 'i-1', calendarId: 'c', extra: true }).primaryCalendar,
      null,
    );
    assert.equal(
      settings({ integrationId: 'i-1', calendarId: 'c' }).primaryCalendar?.isOn('i-1'),
      true,
    );
  });
});

describe('PrimaryCalendarStatus', () => {
  const primary = PrimaryCalendar.of('i-1', 'me@example.test');

  it('unset, active, or suspended (read-only, disconnected)', () => {
    const unset = PrimaryCalendarStatus.of(null, { ownerUserId: 'u-1', writable: true });
    assert.deepEqual([unset.state, unset.reason, unset.isActive], ['unset', null, false]);
    const active = PrimaryCalendarStatus.of(primary, { ownerUserId: 'u-1', writable: true });
    assert.deepEqual([active.state, active.reason, active.isActive], ['active', null, true]);
    const readOnly = PrimaryCalendarStatus.of(primary, { ownerUserId: 'u-1', writable: false });
    assert.deepEqual([readOnly.state, readOnly.reason], ['suspended', 'read_only']);
    const gone = PrimaryCalendarStatus.of(primary, null);
    assert.deepEqual(
      [gone.state, gone.reason, gone.isActive],
      ['suspended', 'disconnected', false],
    );
  });

  it('shows its ids to its integration’s owner only', () => {
    const status = PrimaryCalendarStatus.of(primary, { ownerUserId: 'u-1', writable: true });
    assert.deepEqual(status.viewFor('u-1'), {
      state: 'active',
      reason: null,
      mine: true,
      integrationId: 'i-1',
      calendarId: 'me@example.test',
    });
    assert.deepEqual(status.viewFor('u-2'), {
      state: 'active',
      reason: null,
      mine: false,
      integrationId: null,
      calendarId: null,
    });
    assert.deepEqual(PrimaryCalendarStatus.of(primary, null).viewFor('u-1').mine, false);
  });
});
