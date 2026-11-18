/**
 * series-ends, against a throwaway MongoDB: a stored series without `props.recurrenceEnd` gets
 * its end from its rule (UNTIL, COUNT) on its workspace's wall clock, or null when it never ends;
 * a series that has one and an item that doesn't repeat are left alone; a second run changes
 * nothing; it answers counts only.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: Migration;

const NOW = new Date('2026-11-18T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_series_ends');
  ({ seriesEnds: migration } = await import('./seriesEnds.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

/** A stored item: a Google event unless `props` says otherwise. */
function item(id: string, workspaceId: string, startAt: string, endAt: string, props: Doc): Doc {
  return {
    _id: id,
    workspaceId,
    kind: 'event',
    title: id,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    deletedAt: null,
    source: { provider: 'google_calendar', externalId: id },
    props: { calendarId: 'c', eventId: id, ...props },
  };
}

async function propsOf(id: string): Promise<Doc> {
  const doc = await raw.collection<Doc>('Items').findOne({ _id: id as never });
  assert.ok(doc, id);
  return doc['props'] as Doc;
}

describe('series-ends', () => {
  it('answers zero on a database without series', async () => {
    assert.deepEqual(await migration.run(raw, NOW), { series: 0, ended: 0 });
  });

  it('works out each missing end from the rule, on the workspace clock; leaves the rest', async () => {
    await raw.collection<Doc>('Workspaces').insertMany([
      { _id: 'w-jlm' as never, settings: { timezone: 'Asia/Jerusalem' } },
      { _id: 'w-ny' as never, settings: { timezone: 'America/New_York' } },
    ]);
    await raw.collection<Doc>('Items').insertMany([
      // Last semester's lecture: Tuesdays 10:00–12:00 in Jerusalem until 16 June (summer, UTC+3).
      item('until', 'w-jlm', '2026-03-03T08:00:00.000Z', '2026-03-03T10:00:00.000Z', {
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260616T070000Z'],
      }),
      // Three days at 10:00, an hour each.
      item('count', 'w-jlm', '2026-01-05T08:00:00.000Z', '2026-01-05T09:00:00.000Z', {
        recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      }),
      // Two days at 10:00 in New York, across its spring change (8 March): 10:00 EDT is 14:00Z.
      item('ny', 'w-ny', '2026-03-07T15:00:00.000Z', '2026-03-07T16:00:00.000Z', {
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
      }),
      // A workspace stored without a zone is read in the schema's default (Jerusalem).
      item('nozone', 'w-gone', '2026-01-05T08:00:00.000Z', '2026-01-05T09:00:00.000Z', {
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
      }),
      // Never ends: null, so it is read for every range (and never looked at again).
      item('endless', 'w-jlm', '2026-03-03T08:00:00.000Z', '2026-03-03T10:00:00.000Z', {
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      }),
      // Already has its end (a sync wrote it): kept, whatever the rule says.
      item('known', 'w-jlm', '2026-03-03T08:00:00.000Z', '2026-03-03T10:00:00.000Z', {
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
        recurrenceEnd: '2027-01-01T00:00:00.000Z',
      }),
      // An endless one already marked never-ending: kept.
      item('known-null', 'w-jlm', '2026-03-03T08:00:00.000Z', '2026-03-03T10:00:00.000Z', {
        recurrence: ['RRULE:FREQ=WEEKLY'],
        recurrenceEnd: null,
      }),
      // Not a series.
      item('single', 'w-jlm', '2026-03-03T08:00:00.000Z', '2026-03-03T10:00:00.000Z', {}),
      // A Google exception of a series: no rule of its own.
      item('exception', 'w-jlm', '2026-03-10T09:00:00.000Z', '2026-03-10T11:00:00.000Z', {
        recurringEventId: 'until',
        originalStartAt: '2026-03-10T08:00:00.000Z',
      }),
    ]);

    assert.deepEqual(await migration.run(raw, NOW), { series: 5, ended: 4 });
    assert.equal((await propsOf('until'))['recurrenceEnd'], '2026-06-16T09:00:00.000Z');
    assert.equal((await propsOf('count'))['recurrenceEnd'], '2026-01-07T09:00:00.000Z');
    assert.equal((await propsOf('ny'))['recurrenceEnd'], '2026-03-08T15:00:00.000Z');
    assert.equal((await propsOf('nozone'))['recurrenceEnd'], '2026-01-06T09:00:00.000Z');
    const endless = await propsOf('endless');
    assert.ok('recurrenceEnd' in endless);
    assert.equal(endless['recurrenceEnd'], null);
    assert.equal((await propsOf('known'))['recurrenceEnd'], '2027-01-01T00:00:00.000Z');
    assert.equal((await propsOf('known-null'))['recurrenceEnd'], null);
    assert.equal('recurrenceEnd' in (await propsOf('single')), false);
    assert.equal('recurrenceEnd' in (await propsOf('exception')), false);
  });

  it('changes nothing the second time', async () => {
    const before = await raw.collection<Doc>('Items').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(await migration.run(raw, NOW), { series: 0, ended: 0 });
    assert.deepEqual(
      await raw.collection<Doc>('Items').find({}).sort({ _id: 1 }).toArray(),
      before,
    );
  });
});
