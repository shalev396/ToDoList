/**
 * Time blocks, areas and travel legs through the Logic Bridge and the item list, against a real
 * database (docs/superpowers/specs/2026-11-17-time-blocks-design.md, Decision 7; plan rulings 4
 * and 5):
 * - task-shaped results (a list block, the REST list) leave them out unless a kind is named;
 * - time-shaped results (a calendar block) always hold them;
 * - a series whose first occurrence is weeks before the visible range is read for that range, so
 *   the expansion can place this week's occurrence (Review Focus 1, the semester case).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../models/index.js';
import type { SourceRef } from '../models/definitions/common.js';
import type { WorkspaceContext } from '../classes/base/Caller.js';
import type { ItemQueryRow } from '../types/builder.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as WorkspaceQuery from './workspaceQuery.js';

const NOW = new Date('2026-11-11T08:00:00Z'); // Wednesday, 10:00 in Jerusalem
const ZONE = 'Asia/Jerusalem';
/** This week in Jerusalem, from Sunday: [Nov 8 00:00, Nov 15 00:00) local. */
const WEEK = { from: '2026-11-07T22:00:00.000Z', to: '2026-11-14T22:00:00.000Z' };
const USER = 'u-scheduled';
const OTHER = 'u-scheduled-other';
const GCAL = 'int-scheduled-gcal';

let db: TestDatabase;
let models: typeof Models;
let runWorkspaceQuery: typeof WorkspaceQuery.runWorkspaceQuery;
const workspace: WorkspaceContext = {
  id: 'w-scheduled',
  role: 'owner',
  settings: { timezone: ZONE, weekStart: 'sun', topicRules: [] },
};

function gcalSource(externalId: string): SourceRef {
  return {
    provider: 'google_calendar',
    accountId: 'g-scheduled',
    externalId,
    key: null,
    url: `https://example.invalid/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: `h-${externalId}`,
  };
}

before(async () => {
  db = await startTestDatabase('todolist_query_scheduled');
  models = await import('../models/index.js');
  ({ runWorkspaceQuery } = await import('./workspaceQuery.js'));
  const items = await models.getItemRepository();
  const local = (title: string, fields: Record<string, unknown>): Promise<unknown> =>
    items.createLocal(workspace.id, { ownerUserId: USER, title, topicId: 'college', ...fields });

  // Sundays 13:00–15:00 in Jerusalem since 13 September (summer time, UTC+3): eight weeks before
  // this week, and across the 25 October change back to UTC+2.
  await local('Study: Math', {
    kind: 'block',
    startAt: new Date('2026-09-13T10:00:00Z'),
    endAt: new Date('2026-09-13T12:00:00Z'),
    props: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'] },
  });
  // Series that end, with the end TodoList stores when a block is saved (recurrenceEndOf).
  const { recurrenceEndOf } = await import('../types/recurrence/occurrences.js');
  const series = (title: string, start: string, end: string, rule: string): Promise<unknown> => {
    const row = { startAt: start, endAt: end, props: { recurrence: [rule] } };
    return local(title, {
      kind: 'block',
      startAt: new Date(start),
      endAt: new Date(end),
      props: { ...row.props, recurrenceEnd: recurrenceEndOf(row, ZONE) },
    });
  };
  // Ended in June (UNTIL), six Mondays to 19 October (COUNT): neither is read for this week.
  await series(
    'Last semester tutorial',
    '2026-03-01T08:00:00Z',
    '2026-03-01T09:00:00Z',
    'RRULE:FREQ=WEEKLY;UNTIL=20260601T000000Z',
  );
  await series(
    'Six-week course',
    '2026-09-14T14:00:00Z',
    '2026-09-14T15:00:00Z',
    'RRULE:FREQ=WEEKLY;COUNT=6',
  );
  // Twenty Wednesdays from 16 September, to late January: still running this week.
  await series(
    'Semester seminar',
    '2026-09-16T11:00:00Z',
    '2026-09-16T12:00:00Z',
    'RRULE:FREQ=WEEKLY;COUNT=20',
  );
  // A one-off block eight weeks ago: not a series, so it stays out of this week. Its stored
  // status is one nothing else has, to show the status facet never offers it.
  await local('Old one-off block', {
    kind: 'block',
    status: 'in_progress',
    startAt: new Date('2026-09-13T06:00:00Z'),
    endAt: new Date('2026-09-13T07:00:00Z'),
  });
  await local('Studying', {
    kind: 'block',
    startAt: new Date('2026-11-10T07:00:00Z'),
    endAt: new Date('2026-11-10T15:00:00Z'),
    props: { layer: 'area' },
  });
  await local('Bus to Braude', {
    kind: 'travel',
    visibility: 'private',
    startAt: new Date('2026-11-10T06:20:00Z'),
    endAt: new Date('2026-11-10T07:00:00Z'),
  });
  // Another member's leg: never this member's, in any shape.
  await items.createLocal(workspace.id, {
    ownerUserId: OTHER,
    title: 'Their bus',
    topicId: 'college',
    kind: 'travel',
    visibility: 'workspace',
    startAt: new Date('2026-11-10T06:20:00Z'),
    endAt: new Date('2026-11-10T07:00:00Z'),
  });
  await local('Hand in the essay', { dueAt: new Date('2026-11-12T20:00:00Z') });

  // A Google weekly lecture whose master started eight weeks ago: Tuesdays 10:00–12:00.
  const { seedIntegration } = await import('../testing/integrationFixtures.js');
  await seedIntegration(workspace.id, {
    id: GCAL,
    ownerUserId: USER,
    provider: 'google_calendar',
    accountId: 'g-scheduled',
  });
  await items.bulkUpsert(workspace.id, [
    {
      integrationId: GCAL,
      kind: 'event',
      topicId: 'college',
      title: 'Algorithms lecture',
      status: 'open',
      startAt: new Date('2026-09-15T07:00:00Z'),
      endAt: new Date('2026-09-15T09:00:00Z'),
      props: {
        calendarId: 'cal-1',
        eventId: 'lecture',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      },
      source: gcalSource('lecture'),
    },
  ]);
});

after(async () => {
  await db.stop();
});

async function rowsOf(body: Record<string, unknown>): Promise<ItemQueryRow[]> {
  const result = await runWorkspaceQuery(workspace, USER, body, NOW);
  return (result.rows ?? []).filter((row): row is ItemQueryRow => 'kind' in row);
}

const titlesOf = (rows: readonly { title: string }[]): string[] =>
  rows.map((row) => row.title).sort();

describe('series in date ranges', () => {
  it('series started eight weeks ago is read for this week', async () => {
    const { BLOCK_CATALOG } = await import('../builder/catalog.js');
    const { expandOccurrences } = await import('../types/recurrence/occurrences.js');
    const rows = await rowsOf({
      draft: BLOCK_CATALOG.calendar.defaults.query,
      blockType: 'calendar',
      vars: { '$page.range': WEEK },
    });
    const titles = titlesOf(rows);
    // Unbounded (no end stored, or a Google master synced before ends were) and still running.
    for (const title of ['Study: Math', 'Algorithms lecture', 'Semester seminar']) {
      assert.ok(titles.includes(title), `${title}: ${titles.join(', ')}`);
    }
    // Ended before this week (UNTIL, COUNT), or never a series.
    for (const title of ['Last semester tutorial', 'Six-week course', 'Old one-off block']) {
      assert.ok(!titles.includes(title), `${title}: ${titles.join(', ')}`);
    }

    const occurrences = expandOccurrences(
      rows,
      { from: new Date(WEEK.from), to: new Date(WEEK.to) },
      ZONE,
    ).filter((occurrence) => occurrence.seriesRowId !== null);
    assert.deepEqual(
      occurrences.map((occurrence) => [occurrence.row.title, occurrence.start.toISOString()]),
      [
        // Sunday 13:00 in winter time (UTC+2): still 13:00 on the wall clock.
        ['Study: Math', '2026-11-08T11:00:00.000Z'],
        ['Algorithms lecture', '2026-11-10T08:00:00.000Z'],
        ['Semester seminar', '2026-11-11T12:00:00.000Z'],
      ],
    );
  });

  it('a task-shaped block reads a series by its own start only', async () => {
    const draft = { source: 'items', dateRange: WEEK, dateField: 'startAt' };
    assert.deepEqual(titlesOf(await rowsOf({ draft, blockType: 'list' })), []);
    assert.deepEqual(titlesOf(await rowsOf({ draft, blockType: 'calendar' })), [
      'Algorithms lecture',
      'Bus to Braude',
      'Semester seminar',
      'Study: Math',
      'Studying',
    ]);
  });
});

describe('task-shaped and time-shaped results', () => {
  it('blocks hidden from a list draft, shown in a calendar draft', async () => {
    const { BLOCK_CATALOG } = await import('../builder/catalog.js');
    const list = titlesOf(
      await rowsOf({ draft: BLOCK_CATALOG.list.defaults.query, blockType: 'list' }),
    );
    assert.deepEqual(list, ['Algorithms lecture', 'Hand in the essay']);
    // No block type is task-shaped too.
    assert.deepEqual(titlesOf(await rowsOf({ draft: { source: 'items' } })), list);

    const calendar = titlesOf(
      await rowsOf({
        draft: BLOCK_CATALOG.calendar.defaults.query,
        blockType: 'calendar',
        vars: { '$page.range': WEEK },
      }),
    );
    assert.deepEqual(calendar, [
      'Algorithms lecture',
      'Bus to Braude',
      'Hand in the essay',
      'Semester seminar',
      'Study: Math',
      'Studying',
    ]);
    // Naming the kinds is asking for them, in a task-shaped block too.
    const named = titlesOf(
      await rowsOf({
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'kind', operator: 'in', value: ['block', 'travel'] }],
          },
        },
        blockType: 'list',
      }),
    );
    assert.deepEqual(named, [
      'Bus to Braude',
      'Last semester tutorial',
      'Old one-off block',
      'Semester seminar',
      'Six-week course',
      'Study: Math',
      'Studying',
    ]);
    // `kind != event` (how a list says "tasks") names no reserved time: it stays out.
    const tasks = titlesOf(
      await rowsOf({
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'kind', operator: '!=', value: 'event' }],
          },
        },
        blockType: 'list',
      }),
    );
    assert.deepEqual(tasks, ['Hand in the essay']);
  });

  it('GET-style ItemQuery.list hides blocks unless kind=block', async () => {
    const { Actor } = await import('../classes/base/Actor.js');
    const { Caller } = await import('../classes/base/Caller.js');
    const { ItemQuery } = await import('../classes/item/index.js');
    const reads = await ItemQuery.for(Caller.fromContext(workspace, Actor.user(USER)));
    assert.deepEqual(titlesOf((await reads.list({})).items), [
      'Algorithms lecture',
      'Hand in the essay',
    ]);
    assert.deepEqual(titlesOf((await reads.list({ kind: 'block' })).items), [
      'Last semester tutorial',
      'Old one-off block',
      'Semester seminar',
      'Six-week course',
      'Study: Math',
      'Studying',
    ]);
    assert.deepEqual(titlesOf((await reads.list({ kind: ['travel', 'todo'] })).items), [
      'Bus to Braude',
      'Hand in the essay',
    ]);
    // Text search is task-shaped as well.
    assert.deepEqual(titlesOf((await reads.list({ q: 'Math' })).items), []);
    assert.deepEqual(titlesOf((await reads.list({ q: 'Math', kind: 'block' })).items), [
      'Study: Math',
    ]);
  });

  it('facets offer the kinds, but no status that only reserved time stores', async () => {
    const { Actor } = await import('../classes/base/Actor.js');
    const { Caller } = await import('../classes/base/Caller.js');
    const { ItemQuery } = await import('../classes/item/index.js');
    const reads = await ItemQuery.for(Caller.fromContext(workspace, Actor.user(USER)));
    const facets = await reads.facets();
    assert.deepEqual(facets.kinds, ['block', 'event', 'todo', 'travel']);
    assert.deepEqual(facets.statuses, ['open']);
  });
});
