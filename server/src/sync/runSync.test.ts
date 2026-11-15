import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { IAuditLogRepository } from '../models/definitions/AuditLog.js';
import type { ContainerFilter, IContainerRepository } from '../models/definitions/Container.js';
import type { IIntegrationRepository, IntegrationData } from '../models/definitions/Integration.js';
import type { IItemRepository, ItemData } from '../models/definitions/Item.js';
import type { ISyncRunRepository } from '../models/definitions/SyncRun.js';
import type { ISyncStateRepository } from '../models/definitions/SyncState.js';
import type { TopicRule, IWorkspaceRepository } from '../models/definitions/Workspace.js';
import { ContainerMongoModel } from '../models/mongoose/Container.js';
import { IntegrationMongoModel } from '../models/mongoose/Integration.js';
import { ItemMongoModel } from '../models/mongoose/Item.js';
import {
  createFakeAdapter,
  FAKE_BASE_URL,
  FAKE_FIXTURES_DIR,
  FAKE_PROVIDER,
  type FakeFetchCall,
  type FakeItem,
  type FakeProject,
} from '../testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Provider } from '../types/domain.js';
import type { HttpRequest, HttpResponse, Transport } from './http.js';
import { registerAdapter } from './registry.js';
import type { SyncRunOptions } from '../testing/syncCalls.js';
import { setVaultLoaderForTests, type SyncVault } from './secrets.js';
import {
  fixtureTransport,
  loadFixtureSet,
  type FixtureEntry,
  type FixtureTransport,
} from './transports/fixtures.js';
import type { SyncCounts, SyncRunSummary } from './types.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Repositories {
  workspaces: IWorkspaceRepository;
  integrations: IIntegrationRepository;
  items: IItemRepository;
  containers: IContainerRepository;
  runs: ISyncRunRepository;
  states: ISyncStateRepository;
  audit: IAuditLogRepository;
}

let db: TestDatabase;
let guard: OutboundGuard;
let r: Repositories;
let fakeCalls: FakeFetchCall[];

before(async () => {
  // Environment first: config/environment.ts reads it when first imported (by the engine).
  db = await startTestDatabase('todolist_runsync_test');
  guard = installOutboundGuard();
  const m = await import('../models/index.js');
  r = {
    workspaces: await m.getWorkspaceRepository(),
    integrations: await m.getIntegrationRepository(),
    items: await m.getItemRepository(),
    containers: await m.getContainerRepository(),
    runs: await m.getSyncRunRepository(),
    states: await m.getSyncStateRepository(),
    audit: await m.getAuditLogRepository(),
  };
  const fake = createFakeAdapter();
  registerAdapter(fake.adapter);
  fakeCalls = fake.calls;
});

after(async () => {
  guard.restore();
  await db.stop();
});

afterEach(() => {
  setVaultLoaderForTests(null);
});

async function run(integrationId: string, opts: SyncRunOptions): Promise<SyncRunSummary> {
  const { runIntegrationSync } = await import('../testing/syncCalls.js');
  return runIntegrationSync(integrationId, opts);
}

interface Setup {
  workspaceId: string;
  integration: IntegrationData;
}

let setups = 0;

async function setup(
  options: {
    rules?: TopicRule[];
    config?: Record<string, unknown>;
    topicId?: string;
    provider?: Provider;
    expiresAt?: Date | null;
  } = {},
): Promise<Setup> {
  setups += 1;
  const workspace = await r.workspaces.create({
    name: `Sync ${String(setups)}`,
    slug: `sync-${String(setups)}`,
    ownerId: 'u-owner',
    settings: { topicRules: options.rules ?? [] },
  });
  const integration = await r.integrations.create(workspace.id, {
    connectedBy: 'u-owner',
    provider: options.provider ?? FAKE_PROVIDER,
    accountId: `fake-account-${String(setups)}`,
    label: 'Fake',
    authMethod: 'none',
    topicId: options.topicId ?? 'work',
    config: options.config ?? {},
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  });
  return { workspaceId: workspace.id, integration };
}

async function fakeTransport(set: 'v1' | 'v2'): Promise<FixtureTransport> {
  return fixtureTransport(await loadFixtureSet(join(FAKE_FIXTURES_DIR, set)));
}

const PROJECT: FakeProject = {
  id: 'p1',
  name: 'shalev396/Elytra',
  url: `${FAKE_BASE_URL}/projects/p1`,
};

/** An open item of project p1, as the fake provider sends it. */
function fakeItem(id: string, dueAt: string | null, extra: Partial<FakeItem> = {}): FakeItem {
  return {
    id,
    key: `FAKE-${id}`,
    title: `Item ${id}`,
    status: 'open',
    closedAt: null,
    projectId: 'p1',
    dueAt,
    updatedAt: '2026-11-01T08:00:00Z',
    url: `${FAKE_BASE_URL}/items/${id}`,
    ...extra,
  };
}

/** An item listing (the `items` resource by default) as one page of fixtures. */
function itemPages(items: FakeItem[], resource = 'items'): FixtureEntry[] {
  return [
    {
      request: { url: `${FAKE_BASE_URL}/api/${resource}?page=1` },
      response: { body: { items, next: null } },
    },
  ];
}

/** Fixtures answering the project list with `projects`, plus the given item fixtures. */
function fakeData(projects: FakeProject[], items: readonly FixtureEntry[]): FixtureTransport {
  return fixtureTransport([
    { request: { graphql: 'FakeProjects' }, response: { body: { data: { projects } } } },
    ...items,
  ]);
}

/** Answers every request with `status` and records the requests. */
function statusTransport(status: number): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    send: (request): Promise<HttpResponse> => {
      calls.push(request);
      return Promise.resolve({ status, headers: {}, body: '{}' });
    },
  };
}

/** Every item of the integration, soft-deleted ones included, by external id. */
async function itemsOf(s: Setup): Promise<Map<string, ItemData>> {
  const docs = await ItemMongoModel.find({
    workspaceId: s.workspaceId,
    integrationId: s.integration.id,
  }).lean<(Omit<ItemData, 'id'> & { _id: string })[]>();
  return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
}

function item(items: Map<string, ItemData>, externalId: string): ItemData {
  const found = items.get(externalId);
  assert.ok(found, `item ${externalId}`);
  return found;
}

function counts(partial: Partial<SyncCounts>): SyncCounts {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    closed: 0,
    deleted: 0,
    failed: 0,
    ...partial,
  };
}

/** Installs a vault stub; the returned record shows how it was used. */
function stubVault(secret: Record<string, string>): { loads: number; decrypts: string[] } {
  const usage = { loads: 0, decrypts: [] as string[] };
  const vault: SyncVault = {
    decryptForSync: async (integrationId, fn) => {
      usage.decrypts.push(integrationId);
      return fn(secret);
    },
  };
  setVaultLoaderForTests(() => {
    usage.loads += 1;
    return Promise.resolve(vault);
  });
  return usage;
}

describe('runIntegrationSync: fixture sets v1 → v1 → v2', () => {
  let s: Setup;

  before(async () => {
    s = await setup();
  });

  it('v1: inserts 1 container and 4 items, fails the item without a URL, ends partial', async () => {
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.counts, counts({ fetched: 5, inserted: 4, failed: 1 }));
    assert.equal(summary.error, null);
    assert.ok(summary.runId !== null);

    const containers = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.deepEqual(
      containers.map((container) => [
        container.name,
        container.topicId,
        container.source.accountId,
      ]),
      [['shalev396/Elytra', 'work', s.integration.accountId]],
    );
    const items = await itemsOf(s);
    assert.deepEqual([...items.keys()].sort(), ['A', 'B', 'C', 'D']);
    for (const stored of items.values()) {
      assert.equal(stored.source.provider, FAKE_PROVIDER);
      assert.equal(stored.source.accountId, s.integration.accountId);
      assert.match(stored.source.hash ?? '', /^sha1:[0-9a-f]{40}$/);
      assert.equal(stored.deletedAt, null);
    }
    assert.equal(item(items, 'A').containerId, containers[0]?.id);
    assert.equal(item(items, 'D').containerId, null);

    const runDoc = await r.runs.findById(s.workspaceId, summary.runId);
    assert.ok(runDoc);
    assert.deepEqual(
      [runDoc.status, runDoc.trigger, runDoc.error, runDoc.counts],
      ['partial', 'manual', null, summary.counts],
    );
    assert.ok(runDoc.finishedAt !== null && runDoc.finishedAt >= runDoc.startedAt);
    assert.deepEqual(runDoc.failures, [{ externalId: 'E', code: 'missing_url' }]);

    const integration = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.deepEqual([integration?.status, integration?.lastError], ['active', null]);
    assert.ok(integration?.lastSyncAt);

    const itemsState = await r.states.get(s.workspaceId, s.integration.id, 'items');
    assert.equal(itemsState?.cursor, '2026-11-05T08:00:00Z');
    assert.ok(itemsState.lastFullSyncAt);

    const [entry] = await r.audit.list(s.workspaceId, { action: 'sync.run' }, 10);
    assert.ok(entry);
    assert.deepEqual(
      [entry.actorUserId, entry.targetType, entry.targetId, entry.meta],
      ['system', 'integration', s.integration.id, { trigger: 'manual', counts: summary.counts }],
    );
  });

  it('v1 again: nothing changes', async () => {
    const before = await itemsOf(s);
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.counts, counts({ fetched: 5, unchanged: 4, failed: 1 }));
    const after = await itemsOf(s);
    for (const [externalId, stored] of after) {
      assert.deepEqual(stored.updatedAt, item(before, externalId).updatedAt, externalId);
    }
  });

  it('v2: A and B updated, D unchanged, C swept; B is closed (counted), not deleted', async () => {
    const summary = await run(s.integration.id, {
      trigger: 'schedule',
      mode: 'fixtures',
      transport: await fakeTransport('v2'),
    });
    assert.equal(summary.status, 'partial');
    assert.deepEqual(
      summary.counts,
      counts({ fetched: 4, updated: 2, unchanged: 1, closed: 1, deleted: 1, failed: 1 }),
    );
    const items = await itemsOf(s);
    assert.equal(item(items, 'A').title, 'Alpha v2');
    const b = item(items, 'B');
    assert.deepEqual(
      [b.status, b.closedAt, b.deletedAt],
      ['done', new Date('2026-11-10T09:00:00Z'), null],
    );
    assert.ok(item(items, 'C').deletedAt instanceof Date);
    assert.equal(item(items, 'D').deletedAt, null);
    const [container] = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.equal(container?.deletedAt, null, 'the project was seen again');
  });
});

describe('runIntegrationSync: the sweep is per resource', () => {
  it('an incremental resource means no sweep: C stays', async () => {
    const s = await setup({ config: { incremental: true } });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const transport = await fakeTransport('v2');
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.deepEqual(
      summary.counts,
      counts({ fetched: 4, updated: 2, unchanged: 1, closed: 1, failed: 1 }),
    );
    assert.equal(item(await itemsOf(s), 'C').deletedAt, null);
    assert.ok(
      transport.calls.some((call) => new URL(call.url).searchParams.has('since')),
      'the adapter fetched incrementally from the stored cursor',
    );
    const itemsState = await r.states.get(s.workspaceId, s.integration.id, 'items');
    assert.equal(itemsState?.lastFullSyncAt, null);
    assert.ok(itemsState.lastIncrementalAt);
    assert.ok((await r.states.get(s.workspaceId, s.integration.id, 'projects'))?.lastFullSyncAt);
  });

  it('stamps every record with the resource that wrote it', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    for (const stored of (await itemsOf(s)).values()) assert.equal(stored.syncResource, 'items');
    const [container] = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.equal(container?.syncResource, 'projects');
  });

  it('two resources, one full and one incremental: only the full one sweeps', async () => {
    const s = await setup({ config: { incremental: true } });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    // v2's items, and a project list that no longer has p1.
    const transport = fakeData(
      [],
      (await loadFixtureSet(join(FAKE_FIXTURES_DIR, 'v2'))).filter(
        (entry) => entry.request.graphql === undefined,
      ),
    );
    await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.deepEqual(
      await r.containers.list(s.workspaceId, { integrationId: s.integration.id }),
      [],
      'projects listed in full: p1 is swept',
    );
    assert.equal(item(await itemsOf(s), 'C').deletedAt, null, 'items were incremental: C stays');
  });

  it('a windowed full listing deletes the missing items inside its window and keeps the rest', async () => {
    const s = await setup({
      config: {
        window: { field: 'dueAt', from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
      },
    });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages([
          fakeItem('inside', '2026-11-15T21:59:00Z'),
          fakeItem('before', '2026-10-01T21:59:00Z'),
          fakeItem('undated', null),
          fakeItem('listed', '2026-11-20T21:59:00Z'),
        ]),
      ),
    });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('listed', '2026-11-20T21:59:00Z')])),
    });
    assert.equal(summary.counts.deleted, 1);
    const items = await itemsOf(s);
    assert.ok(item(items, 'inside').deletedAt instanceof Date, 'missing inside the window');
    assert.equal(item(items, 'before').deletedAt, null, 'slid out of the window: history kept');
    assert.equal(item(items, 'undated').deletedAt, null, 'not in any window');
    assert.equal(item(items, 'listed').deletedAt, null);
  });

  it('a resource that fails does not sweep', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const v2 = await fakeTransport('v2');
    // Page 1 of v2 (A, B) arrives, then page 2 fails: the items listing never finishes.
    const transport: Transport = {
      send: (request) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? Promise.resolve({ status: 404, headers: {}, body: '{}' })
          : v2.send(request),
    };
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.deepEqual(
      [summary.status, summary.error?.code, summary.counts.deleted],
      ['failed', 'not_found', 0],
    );
    const items = await itemsOf(s);
    assert.equal(item(items, 'C').deletedAt, null);
    assert.equal(item(items, 'D').deletedAt, null);
  });
});

describe('runIntegrationSync: resources no longer listed', () => {
  /** v1 of three resources: project p1, items A and B, and an `extra` list with X1 and X2. */
  async function syncThreeResources(s: Setup): Promise<void> {
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        [
          ...itemPages([fakeItem('A', null), fakeItem('B', null)]),
          ...itemPages([fakeItem('X1', null), fakeItem('X2', null)], 'extra'),
        ],
      ),
    });
  }

  async function listOnly(s: Setup, resources: string[]): Promise<void> {
    await r.integrations.update(s.workspaceId, s.integration.id, { config: { resources } });
  }

  it('a successful run deletes the records of resources no longer listed: items and containers', async () => {
    const s = await setup({ config: { resources: ['projects', 'items', 'extra'] } });
    await syncThreeResources(s);
    // A calendar removed from config, say: `extra` and `projects` are no longer listed.
    await listOnly(s, ['items']);
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([], itemPages([fakeItem('A', null), fakeItem('B', null)])),
    });
    assert.deepEqual([summary.status, summary.error], ['succeeded', null]);
    assert.deepEqual(summary.counts, counts({ fetched: 2, unchanged: 2, deleted: 2 }));
    const items = await itemsOf(s);
    assert.ok(item(items, 'X1').deletedAt instanceof Date);
    assert.ok(item(items, 'X2').deletedAt instanceof Date);
    assert.equal(item(items, 'A').deletedAt, null);
    assert.deepEqual(
      await r.containers.list(s.workspaceId, { integrationId: s.integration.id }),
      [],
      'p1 belonged to projects',
    );
  });

  it('a failed run deletes nothing of them', async () => {
    const s = await setup({ config: { resources: ['projects', 'items', 'extra'] } });
    await syncThreeResources(s);
    await listOnly(s, ['projects', 'items']);
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: statusTransport(502),
    });
    assert.equal(summary.error?.code, 'server_error');
    for (const id of ['X1', 'X2']) assert.equal(item(await itemsOf(s), id).deletedAt, null, id);
  });

  it('spares a record that failed in the run, and records written before resources were stamped', async () => {
    const s = await setup({ config: { resources: ['projects', 'items', 'extra'] } });
    await syncThreeResources(s);
    await ItemMongoModel.updateOne(
      { workspaceId: s.workspaceId, 'source.externalId': 'X2' },
      { $set: { syncResource: null } },
    );
    await listOnly(s, ['projects', 'items']);
    // X1 moved to `items`, but cannot be mapped there: it keeps its `extra` stamp.
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages([
          fakeItem('A', null),
          fakeItem('B', null),
          fakeItem('X1', null, { broken: true }),
        ]),
      ),
    });
    assert.deepEqual(summary.counts, counts({ fetched: 3, unchanged: 2, failed: 1 }));
    const items = await itemsOf(s);
    assert.equal(item(items, 'X1').deletedAt, null, 'a failure is not a deletion');
    assert.equal(item(items, 'X2').deletedAt, null, 'no resource: never an orphan');
  });

  it('a record that failed without an id stops the sweep: it may be one of them', async () => {
    const s = await setup({ config: { resources: ['projects', 'items', 'extra'] } });
    await syncThreeResources(s);
    await listOnly(s, ['projects', 'items']);
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages([fakeItem('A', null), fakeItem('B', null), fakeItem('', null)]),
      ),
    });
    for (const id of ['X1', 'X2']) assert.equal(item(await itemsOf(s), id).deletedAt, null, id);
  });
});

describe('runIntegrationSync: failures are not deletions', () => {
  it('a record that fails keeps its stored copy and lastSeenAt; only a missing one is swept', async () => {
    const s = await setup();
    const listed = ['A', 'B', 'C', 'D'].map((id) => fakeItem(id, null));
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages(listed)),
    });
    const before = await itemsOf(s);
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      // A has lost its link, the adapter cannot map B, D is unchanged and C is gone.
      transport: fakeData(
        [PROJECT],
        itemPages([
          fakeItem('A', null, { url: '' }),
          fakeItem('B', null, { broken: true }),
          fakeItem('D', null),
        ]),
      ),
    });
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.counts, counts({ fetched: 3, unchanged: 1, deleted: 1, failed: 2 }));
    const after = await itemsOf(s);
    for (const id of ['A', 'B']) {
      assert.equal(item(after, id).deletedAt, null, `${id} failed: not deleted`);
      assert.deepEqual(item(after, id).lastSeenAt, item(before, id).lastSeenAt, id);
    }
    assert.ok(item(after, 'C').deletedAt instanceof Date, 'C is gone at the source');
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(runDoc?.failures, [
      { externalId: 'B', code: 'unmappable' },
      { externalId: 'A', code: 'missing_url' },
    ]);
  });

  it('keeps every failed id, past the 50 the run records', async () => {
    const s = await setup();
    const ids = Array.from({ length: 60 }, (_, index) => `F${String(index)}`);
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages(ids.map((id) => fakeItem(id, null)))),
    });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages(ids.map((id) => fakeItem(id, null, { broken: true }))),
      ),
    });
    assert.deepEqual([summary.counts.failed, summary.counts.deleted], [60, 0]);
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.equal(runDoc?.failures.length, 50);
    for (const stored of (await itemsOf(s)).values()) assert.equal(stored.deletedAt, null);
  });

  it('keeps an adapter failure code only when it is short snake_case, else invalid_failure_code', async () => {
    const s = await setup();
    const failing = (id: string, failureCode: string): FakeItem =>
      fakeItem(id, null, { broken: true, failureCode });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages([
          failing('A', 'bad_due_date'),
          failing('B', 'z'.repeat(41)),
          failing('C', 'Token FAKE-abc rejected for x@example.invalid'),
          failing('D', `x${'y'.repeat(41)}`),
          failing('E', 'Bad_case'),
          failing('F', 'x'),
          failing('G', ''),
        ]),
      ),
    });
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(runDoc?.failures, [
      { externalId: 'A', code: 'bad_due_date' },
      { externalId: 'B', code: 'z'.repeat(41) },
      { externalId: 'C', code: 'invalid_failure_code' },
      { externalId: 'D', code: 'invalid_failure_code' },
      { externalId: 'E', code: 'invalid_failure_code' },
      { externalId: 'F', code: 'invalid_failure_code' },
      { externalId: 'G', code: 'invalid_failure_code' },
    ]);
  });

  it('a record that fails without an id stops its resource sweep: nothing can be ruled gone', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null), fakeItem('B', null)])),
    });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null), fakeItem('', null)])),
    });
    assert.deepEqual(summary.counts, counts({ fetched: 2, unchanged: 1, failed: 1 }));
    assert.equal(item(await itemsOf(s), 'B').deletedAt, null);
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(runDoc?.failures, [{ externalId: '', code: 'missing_id' }]);
  });
});

describe('runIntegrationSync: delete signals', () => {
  /** What the fake provider sends for a record deleted at the source: its id only. */
  const gone = (id: string): FakeItem => fakeItem(id, null, { deleted: true });

  /** A stored item without the fields a delete may change. */
  function kept(stored: ItemData): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(stored).filter(([key]) => key !== 'deletedAt' && key !== 'updatedAt'),
    );
  }

  it('a delete-only record deletes the stored copy and overwrites nothing else; an unknown id is ignored', async () => {
    const s = await setup({ config: { incremental: true } });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages([fakeItem('A', '2026-11-15T21:59:00Z'), fakeItem('B', null)]),
      ),
    });
    const before = item(await itemsOf(s), 'A');
    const now = new Date('2026-11-20T08:00:00Z');
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      now,
      transport: fakeData([PROJECT], itemPages([gone('A'), gone('Z'), fakeItem('B', null)])),
    });
    assert.deepEqual([summary.status, summary.error], ['succeeded', null]);
    assert.deepEqual(summary.counts, counts({ fetched: 3, unchanged: 1, deleted: 1 }));
    const after = await itemsOf(s);
    const a = item(after, 'A');
    assert.deepEqual(a.deletedAt, now);
    assert.deepEqual(kept(a), kept(before), 'title, dates, link, hash, lastSeenAt: as they were');
    assert.equal(after.has('Z'), false, 'an id never stored is ignored');
  });

  it('a delete signalled again for an item already deleted is unchanged: its deletedAt is kept', async () => {
    const s = await setup({ config: { incremental: true } });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null), fakeItem('B', null)])),
    });
    const signals = (deletedAt: string): FixtureTransport =>
      // A by id only; B as a whole record that carries its deletedAt.
      fakeData([PROJECT], itemPages([gone('A'), fakeItem('B', null, { deletedAt })]));
    const first = new Date('2026-11-20T08:00:00Z');
    const deleted = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      now: first,
      transport: signals('2026-11-19T00:00:00Z'),
    });
    assert.deepEqual(deleted.counts, counts({ fetched: 2, deleted: 2 }));

    const again = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      now: new Date('2026-11-27T08:00:00Z'),
      transport: signals('2026-11-26T00:00:00Z'),
    });
    assert.deepEqual(again.counts, counts({ fetched: 2, unchanged: 2 }));
    const items = await itemsOf(s);
    assert.deepEqual(item(items, 'A').deletedAt, first, 'the purge clock is not reset');
    assert.deepEqual(item(items, 'B').deletedAt, new Date('2026-11-19T00:00:00Z'));
  });

  it('a delete-only container deletes the stored container only; later items no longer find it', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null)])),
    });
    // A project without an id fails, so the projects listing is not swept: only the delete-only
    // record can delete p1.
    const nameless: FakeProject = { id: '', name: 'Nameless', url: `${FAKE_BASE_URL}/projects/x` };
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [{ ...PROJECT, deleted: true }, nameless],
        itemPages([fakeItem('A', null), fakeItem('N', null)]),
      ),
    });
    const [p1] = await ContainerMongoModel.find({
      workspaceId: s.workspaceId,
      integrationId: s.integration.id,
    }).lean<{ name: string; deletedAt: Date | null }[]>();
    assert.ok(p1?.deletedAt instanceof Date);
    assert.equal(p1.name, 'shalev396/Elytra', 'nothing else overwritten');
    const items = await itemsOf(s);
    assert.equal(item(items, 'N').containerId, null, 'the deleted project left the cache');
  });

  it('a delete-only record without an id fails as missing_id, and its resource is not swept', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null), fakeItem('B', null)])),
    });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null), gone('')])),
    });
    assert.deepEqual(summary.counts, counts({ fetched: 2, unchanged: 1, failed: 1 }));
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(runDoc?.failures, [{ externalId: '', code: 'missing_id' }]);
    assert.equal(item(await itemsOf(s), 'B').deletedAt, null);
  });
});

describe('runIntegrationSync: per-record validation', () => {
  /** Values the fake provider may send but no record may be stored with. */
  const bad = (extra: Record<string, unknown>): Partial<FakeItem> => extra;

  it('an invalid record is skipped as invalid_record with its id; the run goes on', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT],
        itemPages(['A', 'B', 'C', 'D', 'G'].map((id) => fakeItem(id, '2026-11-15T21:59:00Z'))),
      ),
    });
    const before = await itemsOf(s);
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData(
        [PROJECT, { id: 'p-bad', name: '   ', url: `${FAKE_BASE_URL}/projects/p-bad` }],
        itemPages([
          fakeItem('A', 'not a date'),
          fakeItem('B', null, bad({ status: 'archived' })),
          fakeItem('C', null, { title: 'c'.repeat(1001) }),
          fakeItem('D', '2026-11-15T21:59:00Z'),
          fakeItem('E', null),
          fakeItem('F', null, bad({ topicId: 42 })),
        ]),
      ),
    });
    // G is gone at the source: the sweep still runs, and still spares the invalid ones.
    assert.deepEqual([summary.status, summary.error], ['partial', null]);
    assert.deepEqual(
      summary.counts,
      counts({ fetched: 6, inserted: 1, unchanged: 1, deleted: 1, failed: 5 }),
    );
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(
      runDoc?.failures,
      ['p-bad', 'A', 'B', 'C', 'F'].map((externalId) => ({ externalId, code: 'invalid_record' })),
    );
    const after = await itemsOf(s);
    for (const id of ['A', 'B', 'C']) {
      assert.deepEqual(item(after, id), item(before, id), `${id}: its stored copy is untouched`);
    }
    assert.ok(item(after, 'G').deletedAt instanceof Date);
    assert.equal(after.has('F'), false, 'never stored');
    assert.equal(item(after, 'E').deletedAt, null);
    const containers = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.deepEqual(
      containers.map((container) => container.source.externalId),
      ['p1'],
    );
  });
});

describe('runIntegrationSync: container lookups', () => {
  it("loads the integration's containers once per run, then only the ids a page wrote or a sweep removed", async (t) => {
    const s = await setup({ config: { resources: ['items', 'projects', 'late'] } });
    const list = r.containers.list.bind(r.containers);
    const lookups: ContainerFilter[] = [];
    t.mock.method(r.containers, 'list', (workspaceId: string, filter: ContainerFilter) => {
      lookups.push(filter);
      return list(workspaceId, filter);
    });
    const listing = (projects: FakeProject[]): FixtureTransport =>
      fakeData(projects, [
        ...itemPages([fakeItem('A', null)]),
        ...itemPages([fakeItem('L', null)], 'late'),
      ]);
    const scope = { integrationId: s.integration.id };

    // Run 1: A looks p1 up before it exists; the projects page writes p1; L then finds it.
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: listing([PROJECT]),
    });
    const [p1] = await list(s.workspaceId, scope);
    assert.ok(p1);
    let items = await itemsOf(s);
    assert.equal(item(items, 'A').containerId, null);
    assert.equal(item(items, 'L').containerId, p1.id, 'the cache learnt p1 from its page');
    assert.deepEqual(lookups, [scope, { ...scope, externalIds: ['p1'] }]);

    // Run 2: A finds p1; the projects listing no longer has it, so it is swept, and L must not
    // find it any more.
    lookups.length = 0;
    await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport: listing([]) });
    items = await itemsOf(s);
    assert.equal(item(items, 'A').containerId, p1.id);
    assert.equal(item(items, 'L').containerId, null, 'the swept project left the cache');
    assert.deepEqual(lookups, [scope, { ...scope, externalIds: ['p1'] }]);
  });
});

describe('runIntegrationSync: topics', () => {
  it("a topic rule beats the integration's default; items inherit their container's topic", async () => {
    const s = await setup({
      rules: [{ match: 'shalev396/*', topicId: 'personal' }],
      topicId: 'work',
    });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const [container] = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.equal(container?.topicId, 'personal');
    const items = await itemsOf(s);
    assert.equal(item(items, 'A').topicId, 'personal', 'inherited from its container');
    assert.equal(item(items, 'B').topicId, 'personal');
    assert.equal(item(items, 'C').topicId, 'college', 'fixed by the adapter');
    assert.equal(item(items, 'D').topicId, 'work', 'no container: the integration topic');
  });

  it('a changed rule rewrites the records it affects on the next run', async () => {
    const s = await setup({ topicId: 'work' });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    await r.workspaces.update(s.workspaceId, {
      settings: { topicRules: [{ match: 'SHALEV396/*', topicId: 'personal' }] },
    });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    // A and B move with their container; C keeps its fixed topic; D has no container.
    assert.deepEqual(summary.counts, counts({ fetched: 5, updated: 2, unchanged: 2, failed: 1 }));
    assert.equal(item(await itemsOf(s), 'A').topicId, 'personal');
  });
});

describe('runIntegrationSync: failures', () => {
  it('401: the run fails as auth_failed, the integration needs a reconnect, no retry', async () => {
    const s = await setup();
    const transport = statusTransport(401);
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.error, { code: 'auth_failed', message: 'Reconnect required' });
    assert.equal(transport.calls.length, 1);
    assert.ok(summary.runId !== null);
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId);
    assert.deepEqual([runDoc?.status, runDoc?.error], ['failed', summary.error]);
    const integration = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.deepEqual(
      [integration?.status, integration?.lastError],
      ['error', { code: 'auth_failed', message: 'Reconnect required' }],
    );
  });

  it('the third failed run in a row sets the integration to error; a success resets it', async () => {
    const s = await setup();
    const fail = async (): Promise<IntegrationData | null> => {
      const summary = await run(s.integration.id, {
        trigger: 'schedule',
        mode: 'fixtures',
        transport: statusTransport(404),
      });
      assert.deepEqual([summary.status, summary.error?.code], ['failed', 'not_found']);
      return r.integrations.findById(s.workspaceId, s.integration.id);
    };
    for (const attempt of [1, 2]) {
      const integration = await fail();
      assert.equal(integration?.status, 'active', `after failure ${String(attempt)}`);
      assert.equal(integration.lastError?.code, 'not_found');
    }
    assert.equal((await fail())?.status, 'error');

    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const recovered = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.deepEqual([recovered?.status, recovered?.lastError], ['active', null]);
    assert.equal((await fail())?.status, 'active', 'the count starts over');
  });

  it('error messages are fixed text, never what the provider said', async () => {
    const s = await setup();
    const transport: Transport = {
      send: () =>
        Promise.resolve({
          status: 400,
          headers: {},
          body: JSON.stringify({
            error: 'token FAKE-leak-123 is invalid for user x@example.invalid',
          }),
        }),
    };
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.deepEqual(summary.error, {
      code: 'client_error',
      message: 'The provider refused the request',
    });
    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.equal(JSON.stringify(runDoc).includes('FAKE-leak'), false);
  });

  it('an adapter that breaks the contract fails the run as adapter_error', async () => {
    for (const breakContract of ['window', 'page', 'reserved']) {
      const s = await setup({ config: { breakContract } });
      const summary = await run(s.integration.id, {
        trigger: 'manual',
        mode: 'fixtures',
        transport: await fakeTransport('v1'),
      });
      assert.deepEqual(
        [summary.status, summary.error],
        ['failed', { code: 'adapter_error', message: 'The provider adapter failed' }],
        breakContract,
      );
    }
  });

  it('never writes a parentId an adapter sets: adapters only know external ids', async () => {
    const s = await setup({ config: { breakContract: 'parentId' } });
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    for (const stored of (await itemsOf(s)).values()) assert.equal(stored.parentId, null);
    const containers = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.deepEqual(
      containers.map((container) => container.parentId),
      [null],
    );
  });

  it('a provider without an adapter fails the run as no_adapter', async () => {
    const s = await setup({ provider: 'notion' });
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'no_adapter']);
  });
});

describe('runIntegrationSync: deterministic failures and runs that throw', () => {
  it('a missing fixture fails the run as fixtures_missing at once, without retries', async () => {
    const s = await setup();
    const transport = fakeData(
      [PROJECT],
      [
        {
          request: { url: `${FAKE_BASE_URL}/api/items?page=1` },
          response: { body: { items: [fakeItem('A', null)], next: 2 } },
        },
      ],
    );
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'fixtures_missing']);
    const page2 = transport.calls.filter((call) => call.url.endsWith('page=2'));
    assert.equal(page2.length, 1, 'sent once: no backoff and retries');
  });

  it('an adapter bug (a TypeError) fails the run as adapter_error', async () => {
    const s = await setup({ config: { breakContract: 'typeError' } });
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'adapter_error']);
  });

  it('a listing past its bound fails the run as listing_too_large: nothing swept, no state saved', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const before = await r.states.get(s.workspaceId, s.integration.id, 'items');
    await r.integrations.update(s.workspaceId, s.integration.id, { config: { tooLarge: true } });
    // v2 no longer lists C: a listing that ended would sweep it.
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v2'),
    });
    assert.deepEqual(
      [summary.status, summary.error],
      [
        'failed',
        { code: 'listing_too_large', message: 'The provider listing is too large to sync' },
      ],
    );
    assert.equal(item(await itemsOf(s), 'C').deletedAt, null, 'nothing swept');
    const after = await r.states.get(s.workspaceId, s.integration.id, 'items');
    assert.deepEqual(
      [after?.cursor, after?.lastFullSyncAt],
      [before?.cursor, before?.lastFullSyncAt],
      'the state of the v1 run, untouched',
    );
  });

  it('a write the database still refuses fails the run as invalid_data', async (t) => {
    const s = await setup();
    const refused = Object.assign(new Error('refused'), { name: 'ValidationError' });
    t.mock.method(r.items, 'bulkUpsert', () => Promise.reject(refused));
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: fakeData([PROJECT], itemPages([fakeItem('A', null)])),
    });
    assert.deepEqual(
      [summary.status, summary.error],
      ['failed', { code: 'invalid_data', message: 'A synced record could not be stored' }],
    );
  });

  it('a run that throws after it started ends failed with finishedAt, never left running', async (t) => {
    const s = await setup();
    const lookup = r.integrations.findByIdForWorker.bind(r.integrations);
    let lookups = 0;
    // The run loads its integration, then the database goes away.
    t.mock.method(r.integrations, 'findByIdForWorker', async (id: string) => {
      lookups += 1;
      if (lookups > 1) throw new Error('database unreachable');
      return lookup(id);
    });
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    await assert.rejects(
      run(s.integration.id, {
        runId: queued.id,
        mode: 'fixtures',
        transport: await fakeTransport('v1'),
      }),
      /database unreachable/,
    );
    const runDoc = await r.runs.findById(s.workspaceId, queued.id);
    assert.deepEqual([runDoc?.status, runDoc?.error?.code], ['failed', 'internal']);
    assert.ok(runDoc?.finishedAt);
  });

  it('a throw after the run was recorded keeps what it recorded', async (t) => {
    const s = await setup();
    t.mock.method(r.audit, 'append', () => Promise.reject(new Error('audit log unreachable')));
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    await assert.rejects(
      run(s.integration.id, {
        runId: queued.id,
        mode: 'fixtures',
        transport: await fakeTransport('v1'),
      }),
      /audit log unreachable/,
    );
    const runDoc = await r.runs.findById(s.workspaceId, queued.id);
    assert.deepEqual([runDoc?.status, runDoc?.error], ['partial', null]);
  });
});

describe('runIntegrationSync: transports and secrets', () => {
  it('sends only GETs and allow-listed GraphQL POSTs', async () => {
    const s = await setup();
    const transport = await fakeTransport('v1');
    await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.ok(transport.calls.length > 0);
    for (const call of transport.calls) {
      // A request is a GET or a POST; a POST must be a named, allow-listed GraphQL operation.
      assert.ok(
        call.method === 'GET' || typeof call.graphqlOperation === 'string',
        `${call.method} ${call.url}`,
      );
    }
    assert.ok(transport.calls.some((call) => call.graphqlOperation === 'FakeProjects'));
  });

  it("fixtures mode replays the adapter's fixture sets and never touches the vault", async () => {
    const usage = stubVault({ token: 'FAKE-token-0000000000' });
    const s = await setup();
    const first = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' });
    assert.deepEqual(first.counts, counts({ fetched: 5, inserted: 4, failed: 1 }));
    const second = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      fixtureSet: 'v2',
    });
    assert.deepEqual(
      second.counts,
      counts({ fetched: 4, updated: 2, unchanged: 1, closed: 1, deleted: 1, failed: 1 }),
    );
    assert.deepEqual(usage, { loads: 0, decrypts: [] });
    const seen = fakeCalls.filter((call) => call.integrationId === s.integration.id);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((call) => !call.seesSecret));
  });

  it('live mode decrypts once per run, for this integration, inside the run', async () => {
    const usage = stubVault({ token: 'FAKE-token-0000000000' });
    const s = await setup();
    const summary = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'live',
      transport: await fakeTransport('v1'),
    });
    assert.equal(summary.status, 'partial');
    assert.deepEqual(usage, { loads: 1, decrypts: [s.integration.id] });
    const seen = fakeCalls.filter((call) => call.integrationId === s.integration.id);
    assert.ok(seen.length > 0);
    // Opened once, inside the run; the adapter gets the strategy's auth, never the secret.
    assert.ok(seen.every((call) => !call.seesSecret && call.authKind === 'api_key'));
  });

  it('a vault failure fails the run as credential_unavailable before any request', async () => {
    setVaultLoaderForTests(() =>
      Promise.resolve({ decryptForSync: () => Promise.reject(new Error('no credential')) }),
    );
    const s = await setup();
    const transport = await fakeTransport('v1');
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'live', transport });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'credential_unavailable']);
    assert.equal(transport.calls.length, 0);
  });

  it('a live run takes a test transport only under node:test: elsewhere it fails before any request', async () => {
    const usage = stubVault({ token: 'FAKE-token-0000000000' });
    const s = await setup();
    const transport = await fakeTransport('v1');
    const context = process.env['NODE_TEST_CONTEXT'];
    Reflect.deleteProperty(process.env, 'NODE_TEST_CONTEXT');
    let summary: SyncRunSummary;
    try {
      summary = await run(s.integration.id, { trigger: 'manual', mode: 'live', transport });
    } finally {
      process.env['NODE_TEST_CONTEXT'] = context;
    }
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'internal']);
    assert.equal(transport.calls.length, 0, 'nothing reached the stand-in');
    assert.equal(usage.loads, 0, 'no credential was opened');
  });

  it('an unknown or unsafe fixture set fails the run as fixtures_missing', async () => {
    const s = await setup();
    for (const fixtureSet of ['v9', '../v1', '..', '']) {
      const summary = await run(s.integration.id, {
        trigger: 'manual',
        mode: 'fixtures',
        fixtureSet,
      });
      assert.deepEqual(
        [summary.status, summary.error?.code],
        ['failed', 'fixtures_missing'],
        fixtureSet,
      );
    }
  });
});

describe('runIntegrationSync: paused and expired integrations', () => {
  const messages = { paused: 'The integration is paused', expired: 'The connection has expired' };

  for (const status of ['paused', 'expired'] as const) {
    it(`an integration that is ${status} is not synced: a failed run with skipped_${status}`, async () => {
      const s = await setup();
      await r.integrations.update(s.workspaceId, s.integration.id, { status });
      const transport = await fakeTransport('v1');
      const summary = await run(s.integration.id, {
        trigger: 'manual',
        mode: 'fixtures',
        transport,
      });
      const error = { code: `skipped_${status}`, message: messages[status] };
      assert.ok(summary.runId !== null);
      assert.deepEqual(summary, {
        runId: summary.runId,
        status: 'failed',
        counts: counts({}),
        error,
      });
      assert.equal(transport.calls.length, 0);

      const runDoc = await r.runs.findById(s.workspaceId, summary.runId);
      assert.deepEqual(
        [runDoc?.status, runDoc?.error, runDoc?.trigger],
        ['failed', error, 'manual'],
      );
      assert.ok(runDoc?.finishedAt);
      const integration = await r.integrations.findById(s.workspaceId, s.integration.id);
      assert.deepEqual(
        [integration?.status, integration?.lastError, integration?.lastSyncAt],
        [status, null, null],
      );
      assert.equal((await itemsOf(s)).size, 0);
      assert.equal(await r.states.get(s.workspaceId, s.integration.id, '__run__'), null);
    });
  }

  it('a queued run of a paused integration ends failed with skipped_paused, keeping its trigger', async () => {
    const s = await setup();
    await r.integrations.update(s.workspaceId, s.integration.id, { status: 'paused' });
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    const summary = await run(s.integration.id, { runId: queued.id, mode: 'fixtures' });
    assert.deepEqual(
      [summary.runId, summary.status, summary.error?.code],
      [queued.id, 'failed', 'skipped_paused'],
    );
    const runDoc = await r.runs.findById(s.workspaceId, queued.id);
    assert.deepEqual(
      [runDoc?.status, runDoc?.error?.code, runDoc?.trigger],
      ['failed', 'skipped_paused', 'schedule'],
    );
    assert.ok(runDoc?.finishedAt);
  });

  it('a pause or an expiry set while the run is in flight is never overwritten', async () => {
    const s = await setup();
    const v1 = await fakeTransport('v1');
    const pausing: Transport = {
      send: async (request) => {
        await r.integrations.update(s.workspaceId, s.integration.id, { status: 'paused' });
        return v1.send(request);
      },
    };
    const synced = await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: pausing,
    });
    assert.equal(synced.status, 'partial');
    const paused = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.deepEqual([paused?.status, paused?.lastError], ['paused', null]);
    assert.ok(paused?.lastSyncAt, 'the run still records when it synced');

    const t = await setup();
    const expiring: Transport = {
      send: async () => {
        await r.integrations.update(t.workspaceId, t.integration.id, { status: 'expired' });
        return { status: 401, headers: {}, body: '{}' };
      },
    };
    const failed = await run(t.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: expiring,
    });
    assert.equal(failed.error?.code, 'auth_failed');
    const expired = await r.integrations.findById(t.workspaceId, t.integration.id);
    assert.deepEqual([expired?.status, expired?.lastError?.code], ['expired', 'auth_failed']);
  });
});

describe('runIntegrationSync: a disconnect during the run', () => {
  /** What the disconnect route does: the integration first, then its items and containers. */
  async function disconnect(s: Setup): Promise<void> {
    await r.integrations.softDelete(s.workspaceId, s.integration.id);
    await r.items.softDeleteForIntegration(s.workspaceId, s.integration.id);
    await r.containers.softDeleteForIntegration(s.workspaceId, s.integration.id);
  }

  /** Every container of the integration, soft-deleted ones included. */
  async function containersOf(s: Setup): Promise<{ deletedAt: Date | null }[]> {
    return ContainerMongoModel.find({
      workspaceId: s.workspaceId,
      integrationId: s.integration.id,
    }).lean<{ deletedAt: Date | null }[]>();
  }

  it('stops after the resource, deletes again what the run wrote, and fails as integration_deleted', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const v1 = await fakeTransport('v1');
    const calls: HttpRequest[] = [];
    // Disconnected while the projects are being listed: the run then writes p1 back.
    const transport: Transport = {
      send: async (request) => {
        calls.push(request);
        if (request.graphqlOperation === 'FakeProjects') await disconnect(s);
        return v1.send(request);
      },
    };
    const summary = await run(s.integration.id, {
      trigger: 'schedule',
      mode: 'fixtures',
      transport,
    });
    assert.deepEqual(
      [summary.status, summary.error],
      ['failed', { code: 'integration_deleted', message: 'The integration was disconnected' }],
    );
    assert.deepEqual(
      calls.map((call) => call.graphqlOperation ?? call.url),
      ['FakeProjects'],
      'the items resource never ran',
    );
    const containers = await containersOf(s);
    assert.ok(containers.length > 0);
    assert.ok(
      containers.every((container) => container.deletedAt instanceof Date),
      'p1 deleted again',
    );
    for (const stored of (await itemsOf(s)).values()) assert.ok(stored.deletedAt instanceof Date);

    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual([runDoc?.status, runDoc?.error?.code], ['failed', 'integration_deleted']);
    assert.ok(runDoc?.finishedAt);
    const runState = await r.states.get(s.workspaceId, s.integration.id, '__run__');
    assert.equal(runState?.consecutiveErrors, 0, 'a disconnect is not a failed run');
  });

  it('is caught before finishing too, whatever else failed', async () => {
    const s = await setup();
    const transport: Transport = {
      send: async () => {
        await disconnect(s);
        return { status: 401, headers: {}, body: '{}' };
      },
    };
    const summary = await run(s.integration.id, { trigger: 'manual', mode: 'fixtures', transport });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'integration_deleted']);
    const stored = await IntegrationMongoModel.findById(s.integration.id).lean<{
      status: string;
      lastError: unknown;
    }>();
    assert.deepEqual([stored?.status, stored?.lastError], ['active', null], 'left as disconnected');
  });
});

describe('runIntegrationSync: retries of a job', () => {
  it('the deliveries of one failing run count as one failed run in a row', async () => {
    const s = await setup();
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    // Rate-limited: a code the worker retries (the client gives up at once with Retry-After 0).
    const limited: Transport = {
      send: () => Promise.resolve({ status: 429, headers: { 'retry-after': '0' }, body: '{}' }),
    };
    // The first try, then 3 retries of the same job.
    for (let delivery = 0; delivery < 4; delivery += 1) {
      const summary = await run(s.integration.id, {
        runId: queued.id,
        mode: 'fixtures',
        transport: limited,
      });
      assert.deepEqual(
        [summary.runId, summary.status, summary.error?.code],
        [queued.id, 'failed', 'rate_limited'],
      );
    }
    const failedRuns = async (): Promise<number | undefined> =>
      (await r.states.get(s.workspaceId, s.integration.id, '__run__'))?.consecutiveErrors;
    assert.equal(await failedRuns(), 1);
    const integration = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.equal(integration?.status, 'active', 'still below the threshold');

    await run(s.integration.id, { trigger: 'schedule', mode: 'fixtures', transport: limited });
    assert.equal(await failedRuns(), 2, 'another run counts again');
  });

  it('a crash while counting a failed run cannot under-count: its redelivery counts it, once', async (t) => {
    const s = await setup();
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    const limited: Transport = {
      send: () => Promise.resolve({ status: 429, headers: { 'retry-after': '0' }, body: '{}' }),
    };
    const deliver = (): Promise<SyncRunSummary> =>
      run(s.integration.id, { runId: queued.id, mode: 'fixtures', transport: limited });
    // The first delivery dies as it counts the failure: nothing of the count is written.
    const crash = t.mock.method(r.states, 'countFailedRun', () =>
      Promise.reject(new Error('worker killed')),
    );
    await assert.rejects(deliver(), /worker killed/);
    crash.mock.restore();
    for (let redelivery = 0; redelivery < 2; redelivery += 1) {
      assert.equal((await deliver()).error?.code, 'rate_limited');
    }
    const runState = await r.states.get(s.workspaceId, s.integration.id, '__run__');
    assert.equal(runState?.consecutiveErrors, 1);
  });
});

describe('runIntegrationSync: runs, schedule and status', () => {
  it('a missing or deleted integration is a no-op', async () => {
    const skipped: SyncRunSummary = {
      runId: null,
      status: 'skipped',
      counts: counts({}),
      error: null,
    };
    assert.deepEqual(
      await run('no-such-integration', { trigger: 'manual', mode: 'fixtures' }),
      skipped,
    );
    const s = await setup();
    await r.integrations.softDelete(s.workspaceId, s.integration.id);
    assert.deepEqual(await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' }), skipped);
    assert.deepEqual(await r.runs.listForIntegration(s.workspaceId, s.integration.id, 5), []);
  });

  it('a queued run of a disconnected integration ends failed with integration_deleted', async () => {
    const s = await setup();
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    await r.integrations.softDelete(s.workspaceId, s.integration.id);
    const now = new Date('2026-11-12T09:00:00Z');
    const summary = await run(s.integration.id, { runId: queued.id, mode: 'fixtures', now });
    const error = { code: 'integration_deleted', message: 'The integration was disconnected' };
    assert.deepEqual(summary, { runId: queued.id, status: 'failed', counts: counts({}), error });
    const runDoc = await r.runs.findById(s.workspaceId, queued.id);
    assert.deepEqual(
      [runDoc?.status, runDoc?.error, runDoc?.finishedAt, runDoc?.trigger],
      ['failed', error, now, 'schedule'],
      'never left queued',
    );
    assert.deepEqual(await r.audit.list(s.workspaceId, { action: 'sync.run' }, 5), []);
    assert.equal(await r.states.get(s.workspaceId, s.integration.id, '__run__'), null);
  });

  it('so does one of an organization being deleted', async () => {
    const s = await setup();
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    await r.workspaces.softDelete(s.workspaceId);
    const summary = await run(s.integration.id, { runId: queued.id, mode: 'fixtures' });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'integration_deleted']);
    assert.equal((await r.runs.findById(s.workspaceId, queued.id))?.status, 'failed');
  });

  it('a redelivered run left running by a crash, its integration gone since: failed, its rows deleted again', async () => {
    const s = await setup();
    await run(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    const crashed = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
      status: 'running',
    });
    // Disconnected: the integration is deleted, but the crashed run had revived its rows.
    await r.integrations.softDelete(s.workspaceId, s.integration.id);
    const summary = await run(s.integration.id, { runId: crashed.id, mode: 'fixtures' });
    assert.deepEqual([summary.status, summary.error?.code], ['failed', 'integration_deleted']);
    for (const stored of (await itemsOf(s)).values()) assert.ok(stored.deletedAt instanceof Date);
    assert.deepEqual(
      await r.containers.list(s.workspaceId, { integrationId: s.integration.id }),
      [],
    );
  });

  it('a finished run of a disconnected integration is left as it was', async () => {
    const s = await setup();
    const done = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
      status: 'succeeded',
    });
    await r.integrations.softDelete(s.workspaceId, s.integration.id);
    const summary = await run(s.integration.id, { runId: done.id, mode: 'fixtures' });
    assert.deepEqual([summary.runId, summary.status], [null, 'skipped']);
    assert.equal((await r.runs.findById(s.workspaceId, done.id))?.status, 'succeeded');
  });

  it('runs a queued run in place, with its own trigger; an unknown run id is a no-op', async () => {
    const s = await setup();
    const queued = await r.runs.create(s.workspaceId, {
      integrationId: s.integration.id,
      trigger: 'schedule',
    });
    const summary = await run(s.integration.id, {
      runId: queued.id,
      mode: 'fixtures',
      transport: await fakeTransport('v1'),
    });
    assert.equal(summary.runId, queued.id);
    const runs = await r.runs.listForIntegration(s.workspaceId, s.integration.id, 5);
    assert.deepEqual(
      runs.map((runDoc) => [runDoc.id, runDoc.status, runDoc.trigger]),
      [[queued.id, 'partial', 'schedule']],
    );
    const [entry] = await r.audit.list(s.workspaceId, { action: 'sync.run' }, 1);
    assert.equal(entry?.meta['trigger'], 'schedule');

    const unknown = await run(s.integration.id, { runId: 'no-such-run', mode: 'fixtures' });
    assert.equal(unknown.status, 'skipped');
    assert.equal((await r.runs.listForIntegration(s.workspaceId, s.integration.id, 5)).length, 1);
  });

  it('tells the adapter when a full sync is due: none completed in the last 20 hours', async () => {
    const s = await setup();
    const t0 = new Date('2026-11-12T06:00:00Z');
    const dueAt = async (now: Date): Promise<boolean[]> => {
      const from = fakeCalls.length;
      await run(s.integration.id, { trigger: 'schedule', mode: 'fixtures', now });
      return fakeCalls.slice(from).map((call) => call.fullSyncDue);
    };
    assert.deepEqual(await dueAt(t0), [true, true], 'never synced');
    assert.deepEqual(await dueAt(new Date(t0.getTime() + 10 * HOUR)), [false, false]);
    assert.deepEqual(await dueAt(new Date(t0.getTime() + 31 * HOUR)), [true, true]);

    const incremental = await setup({ config: { incremental: true } });
    for (const offset of [0, HOUR]) {
      const from = fakeCalls.length;
      await run(incremental.integration.id, {
        trigger: 'schedule',
        mode: 'fixtures',
        now: new Date(t0.getTime() + offset),
      });
      assert.ok(
        fakeCalls.slice(from).every((call) => call.fullSyncDue),
        'no complete full sync yet',
      );
    }
  });

  it('hands every fetch() of a run the same context, and each run its own', async () => {
    const s = await setup({ config: { resources: ['projects', 'items', 'late'] } });
    const contextsOfARun = async (): Promise<number[]> => {
      const from = fakeCalls.length;
      await run(s.integration.id, {
        trigger: 'manual',
        mode: 'fixtures',
        transport: fakeData(
          [PROJECT],
          [...itemPages([fakeItem('A', null)]), ...itemPages([fakeItem('L', null)], 'late')],
        ),
      });
      return fakeCalls.slice(from).map((call) => call.context);
    };
    const first = await contextsOfARun();
    const second = await contextsOfARun();
    assert.equal(first.length, 3);
    assert.equal(new Set(first).size, 1, 'one context for the whole run');
    assert.equal(new Set(second).size, 1);
    assert.notEqual(first[0], second[0], 'never shared with another run');
  });

  it("hands the adapter the stored state and the workspace's time zone", async () => {
    const s = await setup();
    await r.workspaces.update(s.workspaceId, { settings: { timezone: 'Europe/London' } });
    await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' });
    const from = fakeCalls.length;
    await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' });
    const items = fakeCalls.slice(from).find((call) => call.resource === 'items');
    assert.equal(items?.state?.cursor, '2026-11-05T08:00:00Z');
    assert.equal(items.timeZone, 'Europe/London');
  });

  it('an expiry within 14 days leaves the integration expiring', async () => {
    const s = await setup({ expiresAt: new Date(Date.now() + 5 * DAY) });
    await run(s.integration.id, { trigger: 'manual', mode: 'fixtures' });
    const integration = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.equal(integration?.status, 'expiring');
  });
});

describe('runIntegrationSync: network', () => {
  it('never opened a connection outside this machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
