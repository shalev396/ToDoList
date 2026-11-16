/**
 * The sync toolset (MCP.md §7.3) over HTTP, in fixtures mode on the real engine (the fake adapter
 * stands in for Linear, as in the REST sync test):
 * - sync_now queues runs and says why each integration it left out was skipped (waiting for its
 *   owner, synced manually moments ago, not found);
 * - get_sync_status polls one run by id, or lists the newest runs: counts and a fixed error
 *   message, never what the provider said;
 * - sync_to_google_calendar is a dry run unless told otherwise, and answers isError while no
 *   Google Calendar integration is connected.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type { CreateIntegrationInput } from '../../models/definitions/Integration.js';
import type * as Models from '../../models/index.js';
import { getAdapter, registerAdapter, unregisterAdapter } from '../../sync/registry.js';
import type { ProviderAdapter } from '../../sync/types.js';
import { createFakeAdapter } from '../../testing/fakeAdapter.js';
import { insertAgentKey, type TestKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const PROVIDER_TEXT = 'upstream said: token ghp_FAKEabcdefghijklmnopqrstuvwxyz0123 is invalid';

let h: McpHarness;
let models: typeof Models;
let team: Team;
let editorKey: TestKey;
let viewerKey: TestKey;
let studentKey: TestKey;
let linearId = '';
let pausedId = '';
let otherWorkspaceIntegrationId = '';
let otherWorkspaceRunId = '';
let original: ProviderAdapter | null = null;

interface RunView {
  id: string;
  integrationId: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
  error: { code: string; message: string } | null;
}

interface SyncNow {
  runIds: string[];
  skipped: { integrationId: string; reason: string; retryAfterMs: number | null }[];
}

async function integration(
  workspaceId: string,
  connectedBy: string,
  fields: Partial<CreateIntegrationInput>,
): Promise<string> {
  const created = await (
    await models.getIntegrationRepository()
  ).create(workspaceId, {
    connectedBy,
    provider: 'linear',
    accountId: `acct-${String(Math.random()).slice(2)}`,
    label: 'Linear',
    authMethod: 'api_token_basic',
    topicId: 'personal',
    ...fields,
  });
  return created.id;
}

before(async () => {
  h = await startMcpHarness('todolist_mcp_sync_test');
  models = await import('../../models/index.js');
  original = getAdapter('linear');
  unregisterAdapter('linear');
  registerAdapter({ ...createFakeAdapter().adapter, provider: 'linear' });

  team = await newTeam('sync');
  const other = await newTeam('sync-other');
  // The editor's own integrations: only an integration's owner syncs it or sees its runs.
  linearId = await integration(team.workspace.id, team.editor.id, {});
  pausedId = await integration(team.workspace.id, team.editor.id, {
    provider: 'jira',
    label: 'Jira',
    topicId: 'work',
    status: 'paused',
  });
  otherWorkspaceIntegrationId = await integration(other.workspace.id, other.owner.id, {});
  otherWorkspaceRunId = (
    await (
      await models.getSyncRunRepository()
    ).create(other.workspace.id, {
      integrationId: otherWorkspaceIntegrationId,
      trigger: 'manual',
      status: 'succeeded',
    })
  ).id;

  editorKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.editor.id,
    scopes: ['read', 'sync', 'gcal:write'],
  });
  viewerKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.viewer.id,
    scopes: ['read'],
  });
  const { newUser } = await import('../../testing/workspaceFixtures.js');
  const student = await newUser('sync-student');
  await (
    await models.getMembershipRepository()
  ).create(team.workspace.id, { userId: student.id, role: 'editor' });
  studentKey = await insertAgentKey({
    workspaceId: team.workspace.id,
    userId: student.id,
    scopes: ['read', 'sync'],
  });
});

after(async () => {
  await settled();
  unregisterAdapter('linear');
  if (original !== null) registerAdapter(original);
  await h.stop();
});

/** Waits until no run is queued or running, so nothing writes after a test (or teardown). */
async function settled(): Promise<void> {
  const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const busy = await SyncRunMongoModel.countDocuments({ status: { $in: ['queued', 'running'] } });
    if (busy === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('sync runs did not finish');
}

async function call(
  key: TestKey,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const client = await h.connect(key.raw);
  return client.callTool({ name, arguments: args });
}

describe('sync_now and get_sync_status', () => {
  let runId = '';

  it('queues a run for each integration it may sync, and says why it skipped the others', async () => {
    const result = await call(editorKey, 'sync_now', {
      integrationIds: [linearId, pausedId, otherWorkspaceIntegrationId],
    });
    assert.notEqual(result.isError, true, errorText(result));
    const out = structured(result) as SyncNow;
    assert.equal(out.runIds.length, 1);
    runId = out.runIds[0] ?? '';
    assert.deepEqual(
      out.skipped.map(({ integrationId, reason }) => [integrationId, reason]),
      [
        [pausedId, 'This integration is paused: save its credential again to resume'],
        [otherWorkspaceIntegrationId, 'Not found'],
      ],
    );
  });

  it('polls the run by id until it is done', async () => {
    const first = structured(await call(editorKey, 'get_sync_status', { runId })) as {
      runs: RunView[];
    };
    assert.deepEqual(
      first.runs.map((run) => [run.id, run.integrationId, run.trigger]),
      [[runId, linearId, 'manual']],
    );
    await settled();
    const done = structured(await call(editorKey, 'get_sync_status', { runId })) as {
      runs: RunView[];
    };
    // The fake adapter's fixtures hold one record it can't map: a partial run.
    assert.ok(['succeeded', 'partial'].includes(done.runs[0]?.status ?? ''), done.runs[0]?.status);
    assert.notEqual(done.runs[0]?.finishedAt, null);
    assert.equal(typeof done.runs[0]?.counts['fetched'], 'number');
  });

  it('skips an integration synced manually moments ago, with the wait', async () => {
    const again = structured(
      await call(editorKey, 'sync_now', { integrationIds: [linearId] }),
    ) as SyncNow;
    assert.deepEqual(again.runIds, []);
    assert.deepEqual(
      again.skipped.map((skip) => [skip.integrationId, (skip.retryAfterMs ?? 0) > 0]),
      [[linearId, true]],
    );
  });

  it('without ids, tries every integration the member may see', async () => {
    const all = structured(await call(editorKey, 'sync_now')) as SyncNow;
    assert.deepEqual(all.runIds, []);
    assert.deepEqual(
      all.skipped.map((skip) => skip.integrationId).sort(),
      [linearId, pausedId].sort(),
    );
  });

  it('lists the newest runs, all or one integration’s', async () => {
    const all = structured(await call(editorKey, 'get_sync_status')) as { runs: RunView[] };
    assert.ok(all.runs.some((run) => run.id === runId));
    const linear = structured(
      await call(editorKey, 'get_sync_status', { integrationId: linearId, limit: 5 }),
    ) as { runs: RunView[] };
    assert.ok(linear.runs.every((run) => run.integrationId === linearId));
  });

  it('does not find another workspace’s run, nor another member’s (PERMISSIONS-V2)', async () => {
    const result = await call(editorKey, 'get_sync_status', { runId: otherWorkspaceRunId });
    assert.equal(result.isError, true);
    assert.equal(errorText(result), 'Not found');
    const mine = structured(await call(editorKey, 'get_sync_status', { runId })) as {
      runs: RunView[];
    };
    assert.deepEqual(
      mine.runs.map((run) => run.id),
      [runId],
    );
    for (const key of [studentKey, viewerKey]) {
      const theirs = await call(key, 'get_sync_status', { runId });
      assert.equal(errorText(theirs), 'Not found');
      const listed = structured(await call(key, 'get_sync_status')) as { runs: RunView[] };
      assert.deepEqual(listed.runs, []);
    }
    const synced = structured(
      await call(studentKey, 'sync_now', { integrationIds: [linearId] }),
    ) as SyncNow;
    assert.deepEqual(synced.runIds, []);
    assert.equal(synced.skipped[0]?.reason, 'Not found');
  });

  it('shows a failed run’s fixed error message, never what the provider said', async () => {
    const runs = await models.getSyncRunRepository();
    const failed = await runs.create(team.workspace.id, {
      integrationId: linearId,
      trigger: 'schedule',
      status: 'queued',
    });
    await runs.update(team.workspace.id, failed.id, {
      status: 'failed',
      finishedAt: new Date(),
      error: { code: 'auth_failed', message: PROVIDER_TEXT },
    });
    const view = structured(await call(editorKey, 'get_sync_status', { runId: failed.id })) as {
      runs: RunView[];
    };
    assert.deepEqual(view.runs[0]?.error, { code: 'auth_failed', message: 'Reconnect required' });
    assert.equal(h.received().join('').includes('ghp_FAKE'), false);
  });
});

describe('sync_to_google_calendar', () => {
  it('is a dry run unless told otherwise', async () => {
    const client = await h.connect(editorKey.raw);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'sync_to_google_calendar');
    const dryRun = (
      tool?.inputSchema.properties as Record<string, { default?: unknown }> | undefined
    )?.['dryRun'];
    assert.equal(dryRun?.default, true);
  });
});
