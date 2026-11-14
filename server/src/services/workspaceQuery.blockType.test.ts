/**
 * `POST /workspaces/:wid/query` with `{draft, blockType}`: a draft without a dateField compiles
 * with its block type's defaults, as the saved block would (a calendar: start time, else due date).
 * Also checks `dateField: 'any'` against a real database: a missing startAt counts as no start.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { WorkspaceContext } from './accessFilter.js';
import type * as WorkspaceQuery from './workspaceQuery.js';

const NOW = new Date('2026-11-11T08:00:00Z'); // Wednesday, 10:00 in Jerusalem
const HOUR = 60 * 60 * 1000;

let db: TestDatabase;
let workspace: WorkspaceContext;
let runWorkspaceQuery: typeof WorkspaceQuery.runWorkspaceQuery;

before(async () => {
  db = await startTestDatabase('todolist_query_block_type');
  ({ runWorkspaceQuery } = await import('./workspaceQuery.js'));
  const { getItemRepository } = await import('../models/index.js');
  const items = await getItemRepository();
  workspace = {
    id: 'w-block-type',
    role: 'viewer',
    settings: { timezone: 'Asia/Jerusalem', weekStart: 'sun', topicRules: [] },
  };
  const local = (title: string, dates: { startAt?: Date; dueAt?: Date }): Promise<unknown> =>
    items.createLocal(workspace.id, { ownerUserId: 'u-1', title, topicId: 'college', ...dates });
  await local('Event today', { startAt: new Date(NOW.getTime() + 2 * HOUR) });
  await local('Due today', { dueAt: new Date(NOW.getTime() + 3 * HOUR) });
  // Starts next week: its due date today must not pull it onto today's calendar.
  await local('Starts later, due today', {
    startAt: new Date(NOW.getTime() + 7 * 24 * HOUR),
    dueAt: new Date(NOW.getTime() + 4 * HOUR),
  });
  await local('Undated', {});
});

after(async () => {
  await db.stop();
});

async function titles(body: Record<string, unknown>): Promise<string[]> {
  const result = await runWorkspaceQuery(workspace, 'u-1', body, NOW);
  return (result.rows ?? []).map((row) => ('title' in row ? row.title : row.name)).sort();
}

describe('draft queries with a block type', () => {
  const today = { source: 'items', dateRange: 'today' };

  it('without a block type, a date range applies to dueAt', async () => {
    assert.deepEqual(await titles({ draft: today }), ['Due today', 'Starts later, due today']);
  });

  it('a calendar draft defaults to dateField any, like a saved calendar block', async () => {
    assert.deepEqual(await titles({ draft: today, blockType: 'calendar' }), [
      'Due today',
      'Event today',
    ]);
    assert.deepEqual(
      await titles({ draft: today, blockType: 'calendar' }),
      await titles({ draft: { ...today, dateField: 'any' } }),
    );
  });

  it('a clock draft defaults to startAt; an explicit dateField always wins', async () => {
    assert.deepEqual(await titles({ draft: today, blockType: 'clock' }), ['Event today']);
    assert.deepEqual(
      await titles({ draft: { ...today, dateField: 'dueAt' }, blockType: 'clock' }),
      ['Due today', 'Starts later, due today'],
    );
  });

  it('refuses a block type without a draft (400)', async () => {
    await assert.rejects(
      runWorkspaceQuery(workspace, 'u-1', { savedQueryId: 'v-1', blockType: 'calendar' }, NOW),
      (error: unknown) => (error as { statusCode?: unknown }).statusCode === 400,
    );
  });
});
