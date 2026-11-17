/**
 * primary-calendar, against a throwaway MongoDB: a stored push target becomes the workspace's
 * primary calendar only when the owner rules allow it (live, OAuth, read & write, owned by an
 * active owner; the oldest wins; never over a primary already set); every Google Calendar config
 * loses `targetCalendarId` and `pushFilter`; a second run changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let primaryCalendar: Migration;

const NOW = new Date('2026-11-15T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_primary_calendar');
  ({ primaryCalendar } = await import('./primaryCalendar.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

function gcal(id: string, workspaceId: string, over: Doc = {}): Doc {
  return {
    _id: id,
    workspaceId,
    provider: 'google_calendar',
    authMethod: 'oauth',
    mode: 'read_write',
    ownerUserId: 'u-owner',
    deletedAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    config: {
      calendars: [{ id: 'cal-a', mode: 'two_way' }],
      targetCalendarId: `target-${id}`,
      pushFilter: { source: 'items' },
    },
    ...over,
  };
}

const settingsOf = async (id: string): Promise<Doc> =>
  ((await raw.collection<Doc>('Workspaces').findOne({ _id: id as never }))?.['settings'] ??
    {}) as Doc;

describe('primary-calendar', () => {
  it('moves an allowed push target to the workspace, drops every other, once', async () => {
    const ws = (id: string, settings: Doc = {}): Doc => ({
      _id: id,
      deletedAt: null,
      settings: { timezone: 'UTC', ...settings },
    });
    await raw
      .collection<Doc>('Workspaces')
      .insertMany([
        ws('w-ok'),
        ws('w-read'),
        ws('w-editor'),
        ws('w-set', { primaryCalendar: { integrationId: 'i-keep', calendarId: 'cal-keep' } }),
      ]);
    await raw.collection<Doc>('Memberships').insertMany([
      { workspaceId: 'w-ok', userId: 'u-owner', role: 'owner', status: 'active' },
      { workspaceId: 'w-read', userId: 'u-owner', role: 'owner', status: 'active' },
      { workspaceId: 'w-editor', userId: 'u-owner', role: 'editor', status: 'active' },
      { workspaceId: 'w-set', userId: 'u-owner', role: 'owner', status: 'active' },
    ]);
    await raw.collection<Doc>('Integrations').insertMany([
      // Newer than i-old: the oldest allowed one wins.
      gcal('i-new', 'w-ok', { createdAt: new Date('2026-11-10T00:00:00Z') }),
      gcal('i-old', 'w-ok'),
      gcal('i-deleted', 'w-ok', {
        deletedAt: NOW,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      }),
      gcal('i-readonly', 'w-read', { mode: 'read' }),
      gcal('i-editor', 'w-editor'),
      gcal('i-other', 'w-set'),
      { _id: 'i-jira', workspaceId: 'w-ok', provider: 'jira', config: { jql: 'x' } },
    ]);

    const counts = await primaryCalendar.run(raw, NOW);
    assert.deepEqual(counts, { primarySet: 1, targetsDropped: 5, configsCleaned: 6 });

    assert.deepEqual((await settingsOf('w-ok'))['primaryCalendar'], {
      integrationId: 'i-old',
      calendarId: 'target-i-old',
    });
    // Read-only, or owned by a member who is not an owner: dropped, no primary.
    assert.equal((await settingsOf('w-read'))['primaryCalendar'], undefined);
    assert.equal((await settingsOf('w-editor'))['primaryCalendar'], undefined);
    // A primary already set stays as it is.
    assert.deepEqual((await settingsOf('w-set'))['primaryCalendar'], {
      integrationId: 'i-keep',
      calendarId: 'cal-keep',
    });

    for (const integration of await raw
      .collection<Doc>('Integrations')
      .find({ provider: 'google_calendar' })
      .toArray()) {
      const config = integration['config'] as Doc;
      assert.equal(config['targetCalendarId'], undefined, String(integration._id));
      assert.equal(config['pushFilter'], undefined, String(integration._id));
      assert.deepEqual(config['calendars'], [{ id: 'cal-a', mode: 'two_way' }]);
    }
    const jira = await raw.collection<Doc>('Integrations').findOne({ _id: 'i-jira' as never });
    assert.deepEqual(jira?.['config'], { jql: 'x' });

    assert.deepEqual(await primaryCalendar.run(raw, NOW), {
      primarySet: 0,
      targetsDropped: 0,
      configsCleaned: 0,
    });
  });
});
