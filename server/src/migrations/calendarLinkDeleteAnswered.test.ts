/**
 * calendar-link-delete-answered, against a throwaway MongoDB: a `dashboard` tombstone stored
 * without `deleteAnsweredAt` gets it, equal to its `tombstonedAt`; a claim of the new code (an
 * explicit null, or a value), a live link and another kind of tombstone are left alone; a second
 * run changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: Migration;

const NOW = new Date('2026-11-15T09:00:00Z');
const OLD = new Date('2026-11-01T08:00:00Z');
const ANSWERED = new Date('2026-11-14T10:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_calendar_link_delete_answered');
  ({ calendarLinkDeleteAnswered: migration } = await import('./calendarLinkDeleteAnswered.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

const row = (id: string, fields: Doc): Doc => ({
  _id: id,
  workspaceId: 'w-1',
  integrationId: 'i-1',
  calendarId: 'cal-1',
  googleEventId: `ev${id}`,
  itemId: `item-${id}`,
  direction: 'to_google',
  ...fields,
});

describe('calendar-link-delete-answered', () => {
  it('answers the old claims at their tombstone, and nothing else, once', async () => {
    const links = raw.collection<Doc>('CalendarLinks');
    await links.insertMany([
      row('old', { tombstonedAt: OLD, deletedBy: 'dashboard' }),
      row('claim', { tombstonedAt: NOW, deletedBy: 'dashboard', deleteAnsweredAt: null }),
      row('settled', { tombstonedAt: OLD, deletedBy: 'dashboard', deleteAnsweredAt: ANSWERED }),
      row('google', { tombstonedAt: OLD, deletedBy: 'google' }),
      row('live', { tombstonedAt: null, deletedBy: null }),
    ]);
    assert.deepEqual(await migration.run(raw, NOW), { settled: 1 });
    const answered = async (id: string): Promise<unknown> =>
      (await links.findOne({ _id: id as never }))?.['deleteAnsweredAt'];
    assert.deepEqual(await answered('old'), OLD);
    assert.equal(await answered('claim'), null, 'a claim of the new code stays unanswered');
    assert.deepEqual(await answered('settled'), ANSWERED);
    assert.equal(await answered('google'), undefined);
    assert.equal(await answered('live'), undefined);
    assert.deepEqual(await migration.run(raw, NOW), { settled: 0 });
  });
});
