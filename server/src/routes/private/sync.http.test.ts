/**
 * Manual syncs and the sync-run history over HTTP (BACKEND.md §4, DATA.md §3.9), in fixtures mode
 * on the real engine: the fake adapter (testing/fixtures/fake) stands in for Linear. "Sync now"
 * answers 202 with run ids, at most once per 5 minutes per integration (429), never for an
 * integration waiting for its owner (409). Runs are shown sanitized: counts and a fixed error.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import { getAdapter, registerAdapter, unregisterAdapter } from '../../sync/registry.js';
import type { ProviderAdapter } from '../../sync/types.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { createFakeAdapter } from '../../testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

type Who = 'owner' | 'editor' | 'viewer' | 'editor2';

const RUN_KEYS = [
  'counts',
  'error',
  'finishedAt',
  'id',
  'integrationId',
  'startedAt',
  'status',
  'trigger',
];
const PROVIDER_TEXT = 'upstream said: token ghp_FAKEabcdefghijklmnopqrstuvwxyz0123 is invalid';

let api: ApiHarness;
let guard: OutboundGuard;
let models: typeof Models;
const tokens = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;
let workspaces = 0;
let original: ProviderAdapter | null = null;

before(async () => {
  api = await startApiHarness('todolist_sync_http');
  guard = installOutboundGuard();
  models = await import('../../models/index.js');
  for (const who of ['owner', 'editor', 'viewer', 'editor2'] as const) {
    tokens[who] = (await api.login(`sync-${who}@example.test`)).token;
    const me = await api.call('GET', '/api/private/me', { token: tokens[who] });
    ids[who] = (me.body?.['data'] as { id: string }).id;
  }
  original = getAdapter('linear');
  unregisterAdapter('linear');
  registerAdapter({ ...createFakeAdapter().adapter, provider: 'linear' });
});

after(async () => {
  await settled();
  unregisterAdapter('linear');
  if (original !== null) registerAdapter(original);
  guard.restore();
  await api.stop();
});

/** Waits until no run is queued or running, so nothing writes after a test (or teardown). */
async function settled(): Promise<void> {
  const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const busy = await SyncRunMongoModel.countDocuments({ status: { $in: ['queued', 'running'] } });
    if (busy === 0) {
      // The audit entry is the run's last write: give the in-process run a moment to reach it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('sync runs did not finish');
}

/** A fresh workspace: owner, two editors and a viewer. */
async function newWorkspace(): Promise<string> {
  workspaces += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Sync', slug: `sync-${String(workspaces)}`, ownerId: ids.owner });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: ids.owner, role: 'owner' });
  await memberships.create(workspace.id, { userId: ids.editor, role: 'editor' });
  await memberships.create(workspace.id, { userId: ids.viewer, role: 'viewer' });
  await memberships.create(workspace.id, {
    userId: ids.editor2,
    role: 'editor',
  });
  return workspace.id;
}

async function call(method: string, url: string, who: Who = 'editor'): Promise<ApiResponse> {
  return api.call(method, url, { token: tokens[who] });
}

const ws = (wid: string): string => `/api/private/workspaces/${wid}`;

/** An integration of `who` (default: the editor, who makes the calls): only its owner syncs it. */
async function newIntegration(
  wid: string,
  body: Record<string, unknown> = { provider: 'linear', config: {} },
  who: Who = 'editor',
): Promise<string> {
  const res = await api.call('POST', `${ws(wid)}/integrations`, { token: tokens[who], body });
  assert.equal(res.status, 201, res.text);
  return (res.body?.['data'] as { id: string }).id;
}

async function runsOf(wid: string, integrationId: string): Promise<Models.SyncRunData[]> {
  return (await models.getSyncRunRepository()).listForIntegration(wid, integrationId, 50);
}

/** Moves every run of the integration back in time, as if triggered `ms` ago. */
async function age(integrationId: string, ms: number): Promise<void> {
  const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
  const at = new Date(Date.now() - ms);
  await SyncRunMongoModel.collection.updateMany(
    { integrationId },
    { $set: { createdAt: at, startedAt: at } },
  );
}

interface RunView {
  id: string;
  integrationId: string;
  trigger: string;
  status: string;
  counts: Record<string, number>;
  error: { code: string; message: string } | null;
}

function runViews(res: ApiResponse): RunView[] {
  return res.body?.['data'] as RunView[];
}

describe('POST /workspaces/:wid/integrations/:iid/sync', () => {
  it('202 {runId}: the run is queued, then the engine runs it to its end', async () => {
    const wid = await newWorkspace();
    const iid = await newIntegration(wid);
    const res = await call('POST', `${ws(wid)}/integrations/${iid}/sync`);
    assert.equal(res.status, 202, res.text);
    const { runId } = res.body?.['data'] as { runId: string };
    await settled();
    const [run] = await runsOf(wid, iid);
    assert.deepEqual(
      [run?.id, run?.trigger, run?.status, run?.counts['inserted']],
      [runId, 'manual', 'partial', 4],
    );
  });

  it('a second manual sync within 5 minutes → 429 with Retry-After; after 5 minutes, allowed', async () => {
    const wid = await newWorkspace();
    const iid = await newIntegration(wid);
    assert.equal((await call('POST', `${ws(wid)}/integrations/${iid}/sync`)).status, 202);
    await settled();
    const again = await call('POST', `${ws(wid)}/integrations/${iid}/sync`);
    assert.equal(again.status, 429, again.text);
    assert.match(String(again.body?.['message']), /5 minutes/);
    assert.equal((await runsOf(wid, iid)).length, 1, 'no run queued');

    await age(iid, 4 * 60 * 1000);
    const later = await api.call('POST', `${ws(wid)}/integrations/${iid}/sync`, {
      token: tokens.editor,
    });
    assert.equal(later.status, 429);
    await age(iid, 5 * 60 * 1000 + 1000);
    assert.equal((await call('POST', `${ws(wid)}/integrations/${iid}/sync`)).status, 202);
    await settled();
    assert.equal((await runsOf(wid, iid)).length, 2);
  });

  it('the 429 says when to come back (Retry-After, in seconds)', async () => {
    const wid = await newWorkspace();
    const iid = await newIntegration(wid);
    assert.equal((await call('POST', `${ws(wid)}/integrations/${iid}/sync`)).status, 202);
    await settled();
    await age(iid, 60 * 1000);
    const res = await call('POST', `${ws(wid)}/integrations/${iid}/sync`);
    assert.equal(res.status, 429);
    const seconds = Number(res.headers['retry-after']);
    assert.ok(seconds > 230 && seconds <= 240, `Retry-After ${String(res.headers['retry-after'])}`);
  });

  const held: [string, Partial<Models.IntegrationData>][] = [
    ['paused', { status: 'paused' }],
    ['expired', { status: 'expired' }],
    [
      'failed auth (a reconnect)',
      { status: 'error', lastError: { code: 'auth_failed', message: 'Reconnect required' } },
    ],
  ];
  for (const [what, patch] of held) {
    it(`an integration that waits for its owner (${what}) → 409; nothing is queued`, async () => {
      const wid = await newWorkspace();
      const iid = await newIntegration(wid);
      await (await models.getIntegrationRepository()).update(wid, iid, patch);
      const res = await call('POST', `${ws(wid)}/integrations/${iid}/sync`);
      assert.equal(res.status, 409, res.text);
      assert.deepEqual(await runsOf(wid, iid), []);
    });
  }

  it('an integration deleted or from another workspace → 404', async () => {
    const wid = await newWorkspace();
    const iid = await newIntegration(wid);
    const other = await newWorkspace();
    assert.equal(
      (await call('POST', `${ws(other)}/integrations/${iid}/sync`, 'owner')).status,
      404,
    );
    // PERMISSIONS-V2: the workspace owner can't sync or disconnect the editor's integration.
    assert.equal((await call('POST', `${ws(wid)}/integrations/${iid}/sync`, 'owner')).status, 404);
    assert.equal(
      (await api.call('DELETE', `${ws(wid)}/integrations/${iid}`, { token: tokens.editor })).status,
      204,
    );
    assert.equal((await call('POST', `${ws(wid)}/integrations/${iid}/sync`)).status, 404);
    assert.deepEqual(await runsOf(wid, iid), []);
  });
});

describe('POST /workspaces/:wid/sync', () => {
  it('queues every integration the member owns and may sync: 202 {runIds}; held and cooling down ones are skipped', async () => {
    const wid = await newWorkspace();
    const ready = await newIntegration(wid);
    const college = await newIntegration(wid, { provider: 'linear', config: {} });
    const paused = await newIntegration(wid);
    const reconnect = await newIntegration(wid);
    const cooling = await newIntegration(wid);
    const integrations = await models.getIntegrationRepository();
    await integrations.update(wid, paused, { status: 'paused' });
    await integrations.update(wid, reconnect, {
      lastError: { code: 'auth_failed', message: 'Reconnect required' },
    });
    assert.equal((await call('POST', `${ws(wid)}/integrations/${cooling}/sync`)).status, 202);
    await settled();

    // Only an integration's owner syncs it (ruling 20): another editor queues none of these.
    const others = await call('POST', `${ws(wid)}/sync`, 'editor2');
    assert.deepEqual([others.status, others.body?.['data']], [202, { runIds: [] }]);
    const res = await call('POST', `${ws(wid)}/sync`);
    assert.equal(res.status, 202, res.text);
    const { runIds } = res.body?.['data'] as { runIds: string[] };
    await settled();
    const queuedFor = new Map<string, string>();
    for (const iid of [ready, college, paused, reconnect, cooling]) {
      for (const run of await runsOf(wid, iid)) queuedFor.set(run.id, iid);
    }
    assert.deepEqual(runIds.map((id) => queuedFor.get(id)).sort(), [ready, college].sort());
  });

  it('nothing to sync → 202 with no run ids', async () => {
    const wid = await newWorkspace();
    const res = await call('POST', `${ws(wid)}/sync`);
    assert.deepEqual([res.status, res.body?.['data']], [202, { runIds: [] }]);
  });
});

describe('GET /workspaces/:wid/sync-runs', () => {
  it('newest first, sanitized: counts and a fixed {code, message}; never failures or provider text', async () => {
    const wid = await newWorkspace();
    const iid = await newIntegration(wid);
    const runs = await models.getSyncRunRepository();
    const old = await runs.create(wid, {
      integrationId: iid,
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 60_000),
    });
    const failed = await runs.create(wid, {
      integrationId: iid,
      trigger: 'manual',
      status: 'failed',
    });
    await runs.update(wid, failed.id, {
      counts: { fetched: 3, failed: 1 },
      error: { code: 'auth_failed', message: PROVIDER_TEXT },
      failures: [{ externalId: 'ISSUE-SECRET-42', code: 'missing_url' }],
    });
    const odd = await runs.create(wid, {
      integrationId: iid,
      trigger: 'calendar_push',
      status: 'failed',
      startedAt: new Date(Date.now() + 60_000),
    });
    await runs.update(wid, odd.id, { error: { code: 'Not A Code!', message: PROVIDER_TEXT } });

    const res = await call('GET', `${ws(wid)}/sync-runs`);
    assert.equal(res.status, 200, res.text);
    const views = runViews(res);
    assert.deepEqual(
      views.map((view) => view.id),
      [odd.id, failed.id, old.id],
    );
    for (const view of views) assert.deepEqual(Object.keys(view).sort(), RUN_KEYS);
    const [oddView, failedView, oldView] = views;
    assert.ok(oddView && failedView && oldView);
    assert.deepEqual(failedView.error, { code: 'auth_failed', message: 'Reconnect required' });
    assert.deepEqual(failedView.counts, { fetched: 3, failed: 1 });
    assert.deepEqual(oddView.error, { code: 'internal', message: 'Sync failed' });
    assert.equal(oldView.error, null);
    for (const leak of ['upstream said', 'ghp_FAKE', 'ISSUE-SECRET-42', 'failures']) {
      assert.ok(!res.text.includes(leak), `the answer holds "${leak}"`);
    }
  });

  it('filters by integration and limits (≤ 100); a bad query → 400; another workspace’s integration → 404', async () => {
    const wid = await newWorkspace();
    const a = await newIntegration(wid);
    const b = await newIntegration(wid);
    const runs = await models.getSyncRunRepository();
    for (const iid of [a, a, a, b]) {
      await runs.create(wid, { integrationId: iid, trigger: 'schedule', status: 'succeeded' });
    }
    const onlyB = runViews(await call('GET', `${ws(wid)}/sync-runs?integrationId=${b}`));
    assert.deepEqual(
      onlyB.map((view) => view.integrationId),
      [b],
    );
    assert.equal(runViews(await call('GET', `${ws(wid)}/sync-runs?limit=2`)).length, 2);
    assert.equal(runViews(await call('GET', `${ws(wid)}/sync-runs`)).length, 4);
    for (const query of ['limit=0', 'limit=101', 'limit=ten', 'status=failed']) {
      assert.equal((await call('GET', `${ws(wid)}/sync-runs?${query}`)).status, 400, query);
    }
    const other = await newWorkspace();
    assert.equal(
      (await call('GET', `${ws(other)}/sync-runs?integrationId=${a}`, 'owner')).status,
      404,
    );
    assert.deepEqual(runViews(await call('GET', `${ws(other)}/sync-runs`, 'owner')), []);
  });

  it('only an integration’s owner sees its runs: everyone else gets none, and 404 by id (ruling 1)', async () => {
    const wid = await newWorkspace();
    const work = await newIntegration(wid, { provider: 'linear', config: {} });
    const college = await newIntegration(wid, { provider: 'linear', config: {} });
    const runs = await models.getSyncRunRepository();
    for (const iid of [work, college]) {
      await runs.create(wid, { integrationId: iid, trigger: 'schedule', status: 'succeeded' });
    }
    const views = runViews(await call('GET', `${ws(wid)}/sync-runs`));
    assert.deepEqual(views.map((view) => view.integrationId).sort(), [work, college].sort());
    for (const who of ['editor2', 'viewer', 'owner'] as const) {
      assert.deepEqual(runViews(await call('GET', `${ws(wid)}/sync-runs`, who)), [], who);
      assert.equal(
        (await call('GET', `${ws(wid)}/sync-runs?integrationId=${work}`, who)).status,
        404,
        who,
      );
    }
  });

  it('nothing left the machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
