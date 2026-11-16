/**
 * Integration.syncTogether (SyncEngine.executeTogether): several runs at once leave exactly what
 * one sync each (Integration.runSync) leaves. Every case syncs the same integrations twice, in two
 * workspaces of the same name: together in one, one by one in the other; the two workspaces'
 * documents (testing/workspaceDump.ts: ids named, wall-clock times masked) must be equal. The
 * fake provider (testing/fakeAdapter.ts) stands in for a real one.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import mongoose from 'mongoose';

import type { IntegrationData } from '../../models/definitions/Integration.js';
import {
  createFakeAdapter,
  FAKE_BASE_URL,
  FAKE_FIXTURES_DIR,
  FAKE_PROVIDER,
  type FakeItem,
} from '../../testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { dumpWorkspace } from '../../testing/workspaceDump.js';
import type { Transport } from '../../sync/http.js';
import { registerAdapter } from '../../sync/registry.js';
import {
  fixtureTransport,
  loadFixtureSet,
  type FixtureEntry,
} from '../../sync/transports/fixtures.js';
import type { SyncRunSummary } from '../../sync/types.js';
import type * as IntegrationModule from '../integration/index.js';
import type * as Models from '../../models/index.js';

const NOW = new Date('2026-11-12T09:00:00.000Z');

let db: TestDatabase;
let guard: OutboundGuard;
let Integration: typeof IntegrationModule.Integration;

before(async () => {
  // Through the (instant) proxy: the driver reports every command, which a case counts.
  db = await startTestDatabase('todolist_sync_together_test', {}, { roundTripMs: 0 });
  // Every collection and index exists first, so only the syncs' own commands are counted.
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  guard = installOutboundGuard();
  ({ Integration } = await import('../integration/index.js'));
  registerAdapter(createFakeAdapter().adapter);
});

after(async () => {
  guard.restore();
  await db.stop();
});

/** One fake integration of a case: its label (its name in the dump) and its config. */
interface Spec {
  label: string;
  config?: Record<string, unknown>;
  transport: () => Promise<Transport>;
}

let workspaces = 0;

/** A workspace named `name` (every case makes two of the same name) with the integrations. */
async function setup(
  name: string,
  specs: readonly Spec[],
): Promise<{ workspaceId: string; integrations: IntegrationData[] }> {
  const models = await import('../../models/index.js');
  workspaces += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({
    name,
    slug: `together-${String(workspaces)}`,
    ownerId: 'u-owner',
    settings: { topicRules: [] },
  });
  const repository = await models.getIntegrationRepository();
  const integrations: IntegrationData[] = [];
  for (const spec of specs) {
    integrations.push(
      await repository.create(workspace.id, {
        connectedBy: 'u-owner',
        provider: FAKE_PROVIDER,
        accountId: `account-${spec.label}`,
        label: spec.label,
        authMethod: 'none',
        topicId: 'work',
        config: spec.config ?? {},
      }),
    );
  }
  return { workspaceId: workspace.id, integrations };
}

async function options(spec: Spec): Promise<{
  trigger: 'seed';
  mode: 'fixtures';
  now: Date;
  transport: Transport;
}> {
  return { trigger: 'seed', mode: 'fixtures', now: NOW, transport: await spec.transport() };
}

/** The same integrations synced together in one workspace and one by one in another. */
async function twins(
  name: string,
  specs: readonly Spec[],
): Promise<{
  together: Awaited<ReturnType<typeof setup>>;
  alone: Awaited<ReturnType<typeof setup>>;
}> {
  return { together: await setup(name, specs), alone: await setup(name, specs) };
}

async function syncTogether(
  { workspaceId, integrations }: Awaited<ReturnType<typeof setup>>,
  specs: readonly Spec[],
): Promise<SyncRunSummary[]> {
  return Integration.syncTogether(
    workspaceId,
    await Promise.all(
      integrations.map(async (integration, index) => {
        const spec = specs[index];
        assert.ok(spec);
        return { integrationId: integration.id, options: await options(spec) };
      }),
    ),
  );
}

async function syncAlone(
  { integrations }: Awaited<ReturnType<typeof setup>>,
  specs: readonly Spec[],
): Promise<SyncRunSummary[]> {
  const summaries: SyncRunSummary[] = [];
  for (const [index, integration] of integrations.entries()) {
    const spec = specs[index];
    assert.ok(spec);
    summaries.push(await Integration.runSync(integration.id, await options(spec)));
  }
  return summaries;
}

/** What `work` answers, and how many commands it sent to the database. */
async function counted<T>(work: () => Promise<T>): Promise<{ result: T; commands: number }> {
  let commands = 0;
  const count = (): void => {
    commands += 1;
  };
  const client = mongoose.connection.getClient();
  client.on('commandStarted', count);
  try {
    return { result: await work(), commands };
  } finally {
    client.off('commandStarted', count);
  }
}

/** What a summary says, its run id aside. */
function outcomes(summaries: readonly SyncRunSummary[]): unknown[] {
  return summaries.map(({ status, counts, error }) => ({ status, counts, error }));
}

/** The documents of the two workspaces, which must be equal. */
async function assertSame(
  together: Awaited<ReturnType<typeof setup>>,
  alone: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
  const [a, b] = await Promise.all([
    dumpWorkspace(together.workspaceId),
    dumpWorkspace(alone.workspaceId),
  ]);
  delete a['Workspaces'];
  delete b['Workspaces'];
  assert.deepEqual(a, b);
}

async function fixtureSet(set: 'v1' | 'v2'): Promise<Transport> {
  return fixtureTransport(await loadFixtureSet(join(FAKE_FIXTURES_DIR, set)));
}

/** The project list and the item listings of `resources`, as one fixture set. */
function custom(items: Record<string, FakeItem[]>): Transport {
  const entries: FixtureEntry[] = [
    {
      request: { graphql: 'FakeProjects' },
      response: {
        body: {
          data: {
            projects: [{ id: 'p1', name: 'shalev396/Elytra', url: `${FAKE_BASE_URL}/projects/p1` }],
          },
        },
      },
    },
    ...Object.entries(items).map(([resource, listed]) => ({
      request: { url: `${FAKE_BASE_URL}/api/${resource}?page=1` },
      response: { body: { items: listed, next: null } },
    })),
  ];
  return fixtureTransport(entries);
}

function fakeItem(id: string, extra: Partial<FakeItem> = {}): FakeItem {
  return {
    id,
    key: `FAKE-${id}`,
    title: `Item ${id}`,
    status: 'open',
    closedAt: null,
    projectId: 'p1',
    dueAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00Z',
    url: `${FAKE_BASE_URL}/items/${id}`,
    ...extra,
  };
}

describe('Integration.syncTogether', () => {
  it('replays integrations that never synced as one sync each would, a failed run too', async () => {
    const specs: Spec[] = [
      { label: 'plain', transport: () => fixtureSet('v1') },
      // Its second item listing has no fixture: the run fails after storing the first.
      {
        label: 'failing',
        config: { resources: ['projects', 'items', 'missing'] },
        transport: () => fixtureSet('v1'),
      },
      {
        label: 'closed',
        transport: () =>
          Promise.resolve(
            custom({
              items: [
                fakeItem('X', { status: 'done', closedAt: '2026-11-10T10:00:00Z' }),
                fakeItem('Y', { deletedAt: '2026-11-11T10:00:00Z' }),
                fakeItem('Z', { url: '' }),
              ],
            }),
          ),
      },
    ];
    const { together, alone } = await twins('Fresh', specs);
    const batched = await counted(() => syncTogether(together, specs));
    const oneByOne = await counted(() => syncAlone(alone, specs));
    assert.deepEqual(outcomes(batched.result), outcomes(oneByOne.result));
    assert.deepEqual(
      batched.result.map(({ status }) => status),
      ['partial', 'failed', 'partial'],
    );
    await assertSame(together, alone);
    // Replayed in memory and written at once (the failed run finishes on its own).
    assert.ok(
      batched.commands * 2 < oneByOne.commands,
      `${String(batched.commands)} commands together, ${String(oneByOne.commands)} one by one`,
    );

    // Synced before: each syncs on its own, still as runSync would.
    const v2 = specs.map(
      (spec): Spec => ({ ...spec, transport: (): Promise<Transport> => fixtureSet('v2') }),
    );
    assert.deepEqual(
      outcomes(await syncTogether(together, v2)),
      outcomes(await syncAlone(alone, v2)),
    );
    await assertSame(together, alone);
  });

  it('syncs a run the replay refuses on its own: a delete-only record, a record listed twice', async () => {
    const specs: Spec[] = [
      { label: 'replayed', transport: () => fixtureSet('v1') },
      {
        label: 'delete-only',
        transport: () =>
          Promise.resolve(custom({ items: [fakeItem('A'), fakeItem('B', { deleted: true })] })),
      },
      {
        label: 'twice',
        config: { resources: ['projects', 'items', 'again'] },
        transport: () =>
          Promise.resolve(custom({ items: [fakeItem('A')], again: [fakeItem('A')] })),
      },
    ];
    const { together, alone } = await twins('Refused', specs);
    assert.deepEqual(
      outcomes(await syncTogether(together, specs)),
      outcomes(await syncAlone(alone, specs)),
    );
    await assertSame(together, alone);
  });

  it('a gone integration is skipped as runSync skips it', async () => {
    const specs: Spec[] = [
      { label: 'kept', transport: () => fixtureSet('v1') },
      { label: 'gone', transport: () => fixtureSet('v1') },
    ];
    const { together, alone } = await twins('Gone', specs);
    const models = await import('../../models/index.js');
    const repository = await models.getIntegrationRepository();
    for (const setupOf of [together, alone]) {
      const gone = setupOf.integrations[1];
      assert.ok(gone);
      await repository.softDelete(setupOf.workspaceId, gone.id);
    }
    const batched = await syncTogether(together, specs);
    assert.deepEqual(outcomes(batched), outcomes(await syncAlone(alone, specs)));
    assert.equal(batched[1]?.status, 'skipped');
    await assertSame(together, alone);
  });

  /**
   * One write of the batch fails (stubbed on its repository, once): the batch throws, and no run
   * of it is left `running`, whatever step failed. Each batch has a run that replays, one the
   * replay refuses and one that fails, so every kind of run is open when the write fails.
   */
  async function failingAt(
    name: string,
    stub: (models: typeof Models) => Promise<() => void>,
  ): Promise<void> {
    const specs: Spec[] = [
      { label: 'replayed', transport: () => fixtureSet('v1') },
      {
        label: 'refused',
        transport: () =>
          Promise.resolve(custom({ items: [fakeItem('A'), fakeItem('B', { deleted: true })] })),
      },
      {
        label: 'failing',
        config: { resources: ['projects', 'items', 'missing'] },
        transport: () => fixtureSet('v1'),
      },
    ];
    const setupOf = await setup(`Failing ${name}`, specs);
    const models = await import('../../models/index.js');
    const restore = await stub(models);
    try {
      await assert.rejects(syncTogether(setupOf, specs), /injected/, name);
    } finally {
      restore();
    }
    const all = (
      await Promise.all(
        setupOf.integrations.map(async (integration) =>
          (await models.getSyncRunRepository()).listForIntegration(
            setupOf.workspaceId,
            integration.id,
            10,
          ),
        ),
      )
    ).flat();
    assert.ok(all.length > 0, `${name}: runs were opened`);
    assert.deepEqual(
      all.filter((run) => run.status === 'running' || run.status === 'queued').map((run) => run.id),
      [],
      `${name}: no run is left open`,
    );
  }

  /** Replaces `method` of `target` with one that throws once; answers how to restore it. */
  function throwOnce<T extends object>(
    target: T,
    method: keyof T & string,
    before?: (original: (...args: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<void>,
  ): () => void {
    const original = target[method] as (...args: unknown[]) => Promise<unknown>;
    let thrown = false;
    Object.assign(target, {
      [method]: async (...args: unknown[]): Promise<unknown> => {
        if (thrown) return original.apply(target, args);
        thrown = true;
        await before?.(original, args);
        throw new Error(`injected: ${method}`);
      },
    });
    return () => {
      Object.assign(target, { [method]: original });
    };
  }

  it('a failed write at any step leaves no run running', async () => {
    await failingAt('opening the runs', async (models) =>
      // The first run is written, then the write stops.
      throwOnce(await models.getSyncRunRepository(), 'createMany', async (original, args) => {
        const [workspaceId, inputs] = args as [string, unknown[]];
        await original(workspaceId, inputs.slice(0, 1));
      }),
    );
    await failingAt('the first reads', async (models) =>
      throwOnce(await models.getContainerRepository(), 'existsForIntegrations'),
    );
    await failingAt('the rows', async (models) =>
      throwOnce(await models.getItemRepository(), 'bulkUpsert'),
    );
    await failingAt('the cursors', async (models) =>
      throwOnce(await models.getSyncStateRepository(), 'upsertMany'),
    );
    await failingAt('the runs', async (models) =>
      throwOnce(await models.getSyncRunRepository(), 'updateMany'),
    );
    await failingAt('the audit entries', async (models) =>
      throwOnce(await models.getAuditLogRepository(), 'appendMany'),
    );
  });

  it('refuses anything but the demo seed’s fixture replays, before opening a run', async () => {
    const specs: Spec[] = [{ label: 'any', transport: () => fixtureSet('v1') }];
    const { workspaceId, integrations } = await setup('Refused modes', specs);
    const integrationId = integrations[0]?.id ?? '';
    for (const options of [
      { trigger: 'manual', mode: 'fixtures' },
      { trigger: 'seed', mode: 'live' },
    ] as const) {
      await assert.rejects(
        Integration.syncTogether(workspaceId, [{ integrationId, options }]),
        /only the demo seed/,
      );
    }
    const models = await import('../../models/index.js');
    const runs = await (
      await models.getSyncRunRepository()
    ).listForIntegration(workspaceId, integrationId, 10);
    assert.deepEqual(runs, []);
  });

  it('never leaves the machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
