import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { runWorkspaceQuery as RunWorkspaceQuery } from './workspaceQuery.js';
import type { WorkspaceContext } from './accessFilter.js';

let db: TestDatabase;
let runWorkspaceQuery: typeof RunWorkspaceQuery;
let CAPS: { previewTimeoutMs: number };

const workspace: WorkspaceContext = {
  id: 'w-t',
  role: 'owner',
  settings: { timezone: 'UTC', weekStart: 'mon' },
} as WorkspaceContext;

before(async () => {
  db = await startTestDatabase('todolist_workspace_query');
  const models = await import('../models/index.js');
  ({ runWorkspaceQuery } = await import('./workspaceQuery.js'));
  ({ CAPS } = (await import('../types/builder.js')) as unknown as { CAPS: typeof CAPS });
  const items = await models.getItemRepository();
  for (let index = 0; index < 200; index += 1) {
    await items.createLocal('w-t', {
      ownerUserId: 'u-1',
      title: `Todo ${String(index)}`,
      topicId: 'work',
    });
  }
});

after(async () => {
  await db.stop();
});

describe('runWorkspaceQuery', () => {
  it('answers 503 with a hint when the query hits its time limit', async () => {
    const original = CAPS.previewTimeoutMs;
    CAPS.previewTimeoutMs = 1;
    try {
      // maxTimeMS of 1 ms: retry a few times in case a run squeaks in under the limit.
      let failure: unknown;
      for (let attempt = 0; attempt < 20 && failure === undefined; attempt += 1) {
        try {
          await runWorkspaceQuery(workspace, 'u-1', {
            draft: { source: 'items', groupBy: ['title'], aggregate: { op: 'count' } },
            preview: true,
          });
        } catch (error) {
          failure = error;
        }
      }
      assert.ok(failure instanceof Error);
      assert.equal((failure as { statusCode?: number }).statusCode, 503);
      assert.equal(failure.message, 'Query took too long; narrow the filters or date range');
    } finally {
      CAPS.previewTimeoutMs = original;
    }
  });
});
