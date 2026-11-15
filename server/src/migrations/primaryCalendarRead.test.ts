/**
 * primary-calendar-read, against a throwaway MongoDB: the workspace's primary calendar is added to
 * its integration's read calendars when missing (any mode counts as read); a missing or foreign
 * integration is skipped; a second run changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let primaryCalendarRead: Migration;

const NOW = new Date('2026-11-15T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_primary_calendar_read');
  ({ primaryCalendarRead } = await import('./primaryCalendarRead.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

const gcal = (id: string, workspaceId: string, calendars: Doc[]): Doc => ({
  _id: id,
  workspaceId,
  provider: 'google_calendar',
  deletedAt: null,
  config: { calendars },
});

const calendarsOf = async (id: string): Promise<unknown> =>
  ((await raw.collection<Doc>('Integrations').findOne({ _id: id as never }))?.['config'] as Doc)[
    'calendars'
  ];

describe('primary-calendar-read', () => {
  it('adds the primary calendar as read when missing, once', async () => {
    const ws = (id: string, integrationId: string, calendarId: string): Doc => ({
      _id: id,
      deletedAt: null,
      settings: { timezone: 'UTC', primaryCalendar: { integrationId, calendarId } },
    });
    await raw
      .collection<Doc>('Workspaces')
      .insertMany([
        ws('w-missing', 'i-missing', 'cal-p'),
        ws('w-two', 'i-two', 'cal-p'),
        ws('w-gone', 'i-nowhere', 'cal-p'),
        ws('w-foreign', 'i-foreign', 'cal-p'),
        { _id: 'w-none', deletedAt: null, settings: { timezone: 'UTC' } },
      ]);
    await raw
      .collection<Doc>('Integrations')
      .insertMany([
        gcal('i-missing', 'w-missing', [{ id: 'cal-a', mode: 'two_way' }]),
        gcal('i-two', 'w-two', [{ id: 'cal-p', mode: 'two_way' }]),
        gcal('i-foreign', 'w-other', []),
      ]);

    assert.deepEqual(await primaryCalendarRead.run(raw, NOW), { added: 1, skipped: 3 });
    assert.deepEqual(await calendarsOf('i-missing'), [
      { id: 'cal-a', mode: 'two_way' },
      { id: 'cal-p', mode: 'read' },
    ]);
    assert.deepEqual(await calendarsOf('i-two'), [{ id: 'cal-p', mode: 'two_way' }]);
    assert.deepEqual(await calendarsOf('i-foreign'), []);

    assert.deepEqual(await primaryCalendarRead.run(raw, NOW), { added: 0, skipped: 4 });
  });

  it('leaves a deleted workspace or integration, a legacy plain-id entry and a full list alone', async () => {
    const ws = (id: string, integrationId: string, deletedAt: Date | null = null): Doc => ({
      _id: id,
      deletedAt,
      settings: { timezone: 'UTC', primaryCalendar: { integrationId, calendarId: 'cal-p' } },
    });
    const full = Array.from({ length: 50 }, (_, index) => ({
      id: `c-${String(index)}`,
      mode: 'read',
    }));
    await raw
      .collection<Doc>('Workspaces')
      .insertMany([
        ws('w2-deleted', 'i2-deleted', new Date('2026-11-01T00:00:00Z')),
        ws('w2-intdeleted', 'i2-intdeleted'),
        ws('w2-legacy', 'i2-legacy'),
        ws('w2-full', 'i2-full'),
      ]);
    await raw.collection<Doc>('Integrations').insertMany([
      gcal('i2-deleted', 'w2-deleted', []),
      {
        ...gcal('i2-intdeleted', 'w2-intdeleted', []),
        deletedAt: new Date('2026-11-01T00:00:00Z'),
      },
      gcal('i2-legacy', 'w2-legacy', ['cal-p' as unknown as Doc]),
      gcal('i2-full', 'w2-full', full),
    ]);
    const result = await primaryCalendarRead.run(raw, NOW);
    assert.equal((result as { added: number }).added, 0);
    assert.deepEqual(await calendarsOf('i2-deleted'), []);
    assert.deepEqual(await calendarsOf('i2-intdeleted'), []);
    assert.deepEqual(await calendarsOf('i2-legacy'), ['cal-p']);
    assert.equal(((await calendarsOf('i2-full')) as unknown[]).length, 50);
  });
});
