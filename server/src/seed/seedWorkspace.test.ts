/**
 * seedWorkspace on a throwaway MongoDB: the demo integrations synced from their fixtures (the
 * adapters on an instant clock, so their request throttles cost nothing), local to-dos and the
 * template dashboards; a second run changes nothing; no credential is ever stored in plaintext;
 * and createWorkspace's loadDemoData uses it on dev and qa only (refused on prod).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { contextFor, newUser } from '../testing/workspaceFixtures.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Models from '../models/index.js';
import type * as Workspaces from '../services/workspaces.js';
import type * as Seed from './seedWorkspace.js';
import type * as DemoData from './demoData.js';
import type { SeedSummary } from './seedWorkspace.js';
import type { Transport } from '../sync/http.js';
import { fakeCredential } from './fakeCredentials.js';
import { findSecrets } from '../services/secretPatterns.js';

/** The instant every fixture resolves against: Thursday 2026-11-12, 11:00 in Asia/Jerusalem. */
const NOW = new Date('2026-11-12T09:00:00.000Z');
const TIME_ZONE = 'Asia/Jerusalem';

let db: TestDatabase;
let guard: OutboundGuard;
let models: typeof Models;
let workspaces: typeof Workspaces;
let seed: typeof Seed;
let demo: typeof DemoData;

before(async () => {
  db = await startTestDatabase('todolist_seed_workspace_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  models = await import('../models/index.js');
  workspaces = await import('../services/workspaces.js');
  seed = await import('./seedWorkspace.js');
  demo = await import('./demoData.js');
  guard = installOutboundGuard();
});

after(async () => {
  guard.restore();
  await db.stop();
});

async function newWorkspace(label: string): Promise<{ workspaceId: string; ownerId: string }> {
  const owner = await newUser(label);
  const workspace = await workspaces.createWorkspace(owner, { name: `Demo ${label}` });
  return { workspaceId: workspace.id, ownerId: owner.id };
}

type Doc = Record<string, unknown> & { _id: unknown };

async function docs(collection: string, filter: Record<string, unknown>): Promise<Doc[]> {
  const database = mongoose.connection.db;
  assert.ok(database);
  return database.collection<Doc>(collection).find(filter).toArray();
}

function byExternalId(rows: Doc[]): Map<string, Doc> {
  return new Map(rows.map((row) => [String((row['source'] as Doc)['externalId']), row]));
}

function updatedAtById(rows: Doc[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => [String(row._id), (row['updatedAt'] as Date).toISOString()]),
  );
}

/** What each demo integration holds after its first fixture sync (the adapters' v1/workspaces sets). */
const EXPECTED: Record<string, { items: number; containers: number; failed: number }> = {
  jira: { items: 9, containers: 1, failed: 1 },
  clickup: { items: 10, containers: 6, failed: 1 },
  linear: { items: 8, containers: 2, failed: 1 },
  moodle: { items: 10, containers: 3, failed: 2 },
  'google-calendar': { items: 12, containers: 2, failed: 1 },
  'github-user': { items: 12, containers: 3, failed: 1 },
  'github-org': { items: 1, containers: 1, failed: 0 },
};

describe('seedWorkspace', () => {
  let workspaceId = '';
  let ownerId = '';
  let first: SeedSummary;
  let firstMs = 0;
  /** The workspace's default topics: the seed gives them their stable ids. */
  const ids = { work: '', college: '', personal: '' };

  before(async () => {
    ({ workspaceId, ownerId } = await newWorkspace('seeded'));
    const { defaultTopicId } = await import('../services/topics.js');
    for (const slug of ['work', 'college', 'personal'] as const) {
      ids[slug] = defaultTopicId(workspaceId, slug);
    }
    const started = Date.now();
    first = await seed.seedWorkspace(workspaceId, NOW);
    firstMs = Date.now() - started;
  });

  it('does not wait on provider throttles: seeding finishes well under 5 s', () => {
    assert.ok(firstMs < 5000, `seeding took ${String(firstMs)} ms`);
  });

  it('live mode still throttles: Moodle spaces its requests 1 s apart on the real clock', async () => {
    const { moodleAdapter } = await import('../sync/providers/moodle.js');
    const transport: Transport = {
      send: () => Promise.resolve({ status: 200, headers: {}, body: '{}' }),
    };
    const client = moodleAdapter.createClient(transport);
    const started = Date.now();
    await client.getJson('https://moodle.example.test/a');
    await client.getJson('https://moodle.example.test/b');
    assert.ok(Date.now() - started >= 900, 'the second request waited for the throttle');
  });

  it('connects one integration per demo account, each synced from its fixtures', async () => {
    assert.equal(first.workspaceId, workspaceId);
    const { defaultTopicId } = await import('../services/topics.js');
    const slugs = new Map(
      (['work', 'college', 'personal'] as const).map((slug) => [
        defaultTopicId(workspaceId, slug),
        slug,
      ]),
    );
    assert.deepEqual(
      first.integrations.map(({ key, provider, topicId }) => [
        key,
        provider,
        topicId === null ? null : slugs.get(topicId),
      ]),
      [
        ['jira', 'jira', 'work'],
        ['clickup', 'clickup', 'work'],
        ['linear', 'linear', 'personal'],
        ['moodle', 'moodle', 'college'],
        ['google-calendar', 'google_calendar', 'personal'],
        ['github-user', 'github', 'personal'],
        ['github-org', 'github', 'work'],
      ],
    );
    for (const seeded of first.integrations) {
      const expected = EXPECTED[seeded.key];
      assert.ok(expected, seeded.key);
      assert.deepEqual(
        { items: seeded.items, containers: seeded.containers, failed: seeded.failed },
        expected,
        seeded.key,
      );
      // Partial: the fixtures hold records without a URL, which are skipped.
      assert.equal(seeded.status, expected.failed > 0 ? 'partial' : 'succeeded', seeded.key);
      assert.equal(seeded.error, null, seeded.key);
    }
    assert.equal(first.localTodos, demo.DEMO_TODOS.length);
    assert.equal(first.dashboards, demo.DEMO_DASHBOARDS.length);
  });

  it('connects through the services: active, a sealed credential, the fixture config', async () => {
    const integrations = await (await models.getIntegrationRepository()).list(workspaceId);
    assert.equal(integrations.length, demo.DEMO_INTEGRATIONS.length);
    const credentials = await docs('Credentials', { workspaceId });
    assert.equal(credentials.length, integrations.length);
    for (const integration of integrations) {
      assert.equal(integration.status, 'active', integration.label);
      assert.equal(integration.connectedBy, ownerId);
      assert.ok(
        credentials.some((credential) => credential._id === integration.credentialId),
        integration.label,
      );
      assert.ok(!integration.accountId.startsWith('pending:'), integration.label);
    }
    const config = (provider: string): unknown =>
      integrations.find((integration) => integration.provider === provider)?.config;
    assert.deepEqual(config('jira'), { baseUrl: 'https://example.invalid/jira' });
    assert.deepEqual(config('moodle'), { siteUrl: 'https://example.invalid/moodle' });
    assert.deepEqual(config('google_calendar'), {
      calendars: [
        { id: 'personal@example.invalid', mode: 'read' },
        { id: 'college@example.invalid', mode: 'read' },
      ],
    });
    const workspace = await (await models.getWorkspaceRepository()).findById(workspaceId);
    assert.deepEqual(workspace?.settings.topicRules, [
      { match: 'shalev396/*', topicId: ids.personal },
      { match: 'Braude*', topicId: ids.college },
    ]);
  });

  it('stores every item with a URL; records without one are counted as failures, not stored', async () => {
    const items = await docs('Items', { workspaceId });
    assert.ok(items.length > 0);
    for (const item of items) {
      const url = (item['source'] as Doc)['url'];
      assert.ok(typeof url === 'string' && url.trim() !== '', String(item['title']));
    }
    const runs = await docs('SyncRuns', { workspaceId, trigger: 'seed' });
    assert.equal(runs.length, demo.DEMO_INTEGRATIONS.length);
    const failures = runs.flatMap(
      (run) => run['failures'] as { externalId: string; code: string }[],
    );
    assert.equal(
      failures.length,
      Object.values(EXPECTED).reduce((sum, { failed }) => sum + failed, 0),
    );
    assert.ok(failures.every((failure) => failure.code === 'missing_url'));
    const stored = byExternalId(items);
    for (const failure of failures) assert.equal(stored.has(failure.externalId), false);
  });

  it('puts AutoDS at work, shalev396/* in personal, acme-labs at work, Moodle in college', async () => {
    const integrations = await (await models.getIntegrationRepository()).list(workspaceId);
    const idOf = (provider: string, accountId?: string): string => {
      const found = integrations.find(
        (integration) =>
          integration.provider === provider &&
          (accountId === undefined || integration.accountId === accountId),
      );
      assert.ok(found, provider);
      return found.id;
    };
    const areasOf = async (integrationId: string): Promise<string[]> => [
      ...new Set(
        (await docs('Items', { workspaceId, integrationId, deletedAt: null })).map((item) =>
          String(item['topicId']),
        ),
      ),
    ];
    const containers = await docs('Containers', { workspaceId, deletedAt: null });
    const container = (name: string): Doc => {
      const found = containers.find((row) => row['name'] === name);
      assert.ok(found, name);
      return found;
    };
    const itemsIn = async (containerName: string): Promise<Doc[]> =>
      docs('Items', { workspaceId, containerId: container(containerName)._id, deletedAt: null });

    assert.equal(container('AutoDS')['topicId'], ids.work);
    assert.deepEqual(await areasOf(idOf('jira')), [ids.work]);
    assert.equal(container('shalev396/Elytra')['topicId'], ids.personal);
    const elytra = await itemsIn('shalev396/Elytra');
    assert.ok(elytra.length > 0);
    assert.ok(elytra.every((item) => item['topicId'] === ids.personal));
    assert.equal(container('acme-labs/api')['topicId'], ids.work);
    const api = await itemsIn('acme-labs/api');
    assert.deepEqual(
      api.map((item) => [item['kind'], item['topicId']]),
      [['pr', ids.work]],
    );
    assert.deepEqual(await areasOf(idOf('moodle')), [ids.college]);
    assert.equal(container('Braude Classes')['topicId'], ids.college);
    assert.ok((await itemsIn('Braude Classes')).every((item) => item['topicId'] === ids.college));
    assert.equal(container('Shalev (demo)')['topicId'], ids.personal);
  });

  it('adds local to-dos: overdue, today, later this week and undated', async () => {
    const todos = await docs('Items', { workspaceId, 'source.provider': 'local' });
    assert.equal(todos.length, demo.DEMO_TODOS.length);
    const day = (date: unknown): string =>
      date instanceof Date ? date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }) : 'none';
    const today = day(NOW);
    const dues = todos.map((todo) => day(todo['dueAt']));
    assert.ok(dues.includes(today), 'one is due today');
    assert.ok(dues.includes('none'), 'one has no date');
    assert.ok(
      dues.some((due) => due !== 'none' && due < today),
      'one is overdue',
    );
    // Week starting Sunday 2026-11-08: later this week is Fri 13th or Sat 14th.
    assert.ok(
      dues.some((due) => due > today && due <= '2026-11-14'),
      'one is due later this week',
    );
    for (const todo of todos) {
      assert.equal(todo['ownerUserId'], ownerId);
      assert.equal(todo['kind'], 'todo');
      assert.equal(todo['visibility'], 'workspace');
    }
  });

  it('instantiates the template dashboards, published, the main one titled "Dashboard"', async () => {
    const dashboards = await docs('Dashboards', { workspaceId, deletedAt: null });
    const scopes = dashboards
      .map((dashboard) => {
        const scope = dashboard['scope'] as Doc;
        const slug = Object.entries(ids).find(([, id]) => id === scope['topicId'])?.[0] ?? null;
        return `${String(dashboard['templateKey'])} ${String(slug)} ${String(scope['page'])}`;
      })
      .sort();
    assert.deepEqual(scopes, [
      'college-course@1 college group',
      'college@1 college topic',
      'dashboard@1 null topic',
      'personal@1 personal topic',
      'project@1 personal group',
      'project@1 work group',
      'work@1 work topic',
    ]);
    const main = dashboards.find((dashboard) => dashboard['templateKey'] === 'dashboard@1');
    assert.equal(main?.['title'], 'Dashboard');
    // Work also got its connector list (version 2), published with it.
    assert.ok(
      dashboards.every((dashboard) => dashboard['publishedVersion'] === dashboard['version']),
    );
  });

  it('a second run changes nothing: the same summary, no updatedAt bumped, nothing added', async () => {
    const watched = ['Items', 'Containers', 'Dashboards', 'Credentials', 'Workspaces'] as const;
    const before = new Map<string, Record<string, string>>();
    for (const name of watched) {
      const filter = name === 'Workspaces' ? { _id: workspaceId } : { workspaceId };
      before.set(name, updatedAtById(await docs(name, filter)));
    }
    const integrationsBefore = (await docs('Integrations', { workspaceId })).map((row) => row._id);
    const versionsBefore = (await docs('DashboardVersions', { workspaceId })).length;

    const second = await seed.seedWorkspace(workspaceId, NOW);

    assert.deepEqual(second, first);
    for (const name of watched) {
      const filter = name === 'Workspaces' ? { _id: workspaceId } : { workspaceId };
      assert.deepEqual(updatedAtById(await docs(name, filter)), before.get(name), name);
    }
    assert.deepEqual(
      (await docs('Integrations', { workspaceId })).map((row) => row._id),
      integrationsBefore,
    );
    assert.equal((await docs('DashboardVersions', { workspaceId })).length, versionsBefore);
  });

  it('never stores a credential in plaintext: no secret shape and no FAKE value in any document', async () => {
    const database = mongoose.connection.db;
    assert.ok(database);
    const values = demo.DEMO_INTEGRATIONS.flatMap((spec) =>
      Object.values(fakeCredential(spec.authMethod, spec.key)),
    );
    let scanned = 0;
    for (const collection of await database.collections()) {
      for (const document of await collection.find({}).toArray()) {
        const text = JSON.stringify(document);
        assert.deepEqual(findSecrets(text), [], collection.collectionName);
        for (const value of values) assert.equal(text.includes(value), false);
        scanned += 1;
      }
    }
    assert.ok(scanned > 100);
  });

  it('never leaves the machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});

describe("createWorkspace's loadDemoData", () => {
  /** Rows or groups of one block of the dashboard, as `/query` answers its owner. */
  async function blockResults(
    workspaceId: string,
    ownerId: string,
    dashboardId: string,
    blockId: string,
  ): Promise<unknown[]> {
    const { runWorkspaceQuery } = await import('../services/workspaceQuery.js');
    const ctx = await contextFor(workspaceId, ownerId);
    const result = await runWorkspaceQuery(ctx, ownerId, { dashboardId, blockId });
    return [...(result.rows ?? []), ...(result.groups ?? [])];
  }

  it('fills a new workspace on dev: its main dashboard shows the demo data', async () => {
    const owner = await newUser('load-demo');
    const workspace = await workspaces.createWorkspace(owner, {
      name: 'Loaded demo',
      loadDemoData: true,
    });

    const integrations = await (await models.getIntegrationRepository()).list(workspace.id);
    assert.equal(integrations.length, demo.DEMO_INTEGRATIONS.length);
    assert.ok(integrations.every((integration) => integration.status === 'active'));
    // Demo data never syncs: marked, and left out of the scheduled dispatch.
    assert.ok(integrations.every((integration) => integration.demo));
    const dispatchable = await (await models.getIntegrationRepository()).listActiveForDispatch();
    assert.ok(dispatchable.every((integration) => integration.workspaceId !== workspace.id));
    const dashboards = await (await models.getDashboardRepository()).list(workspace.id, {});
    assert.equal(dashboards.length, demo.DEMO_DASHBOARDS.length);
    const main = dashboards.find((dashboard) => dashboard.templateKey === 'dashboard@1');
    assert.ok(main, 'the main dashboard');
    assert.notEqual(main.published, null);

    // The blocks that don't depend on today's date: open work by provider, upcoming deadlines.
    const blockIds = (type: string): string[] =>
      (main.blocks as { id: string; type: string }[])
        .filter((block) => block.type === type)
        .map((block) => block.id);
    const [donut] = blockIds('chart');
    const [deadlines] = blockIds('deadlines');
    assert.ok(donut !== undefined && deadlines !== undefined);
    const byProvider = (await blockResults(workspace.id, owner.id, main.id, donut)) as {
      key: Record<string, unknown>;
      value: number;
    }[];
    const providers = byProvider.flatMap(({ key }) => Object.values(key)).map(String);
    for (const provider of ['jira', 'clickup', 'linear', 'moodle', 'github', 'local']) {
      assert.ok(providers.includes(provider), provider);
    }
    assert.ok((await blockResults(workspace.id, owner.id, main.id, deadlines)).length > 0);
    assert.deepEqual(guard.externalHosts(), []);
  });

  it('loads it on qa too', async () => {
    const owner = await newUser('load-demo-qa');
    let seeded = '';
    const qa = await workspaces.createWorkspace(
      owner,
      { name: 'QA demo', loadDemoData: true },
      {
        env: 'qa',
        seed: (workspaceId) => {
          seeded = workspaceId;
          return Promise.resolve();
        },
      },
    );
    assert.equal(seeded, qa.id);
  });

  it('refuses it on prod before creating anything, and leaves a plain workspace empty', async () => {
    const owner = await newUser('load-demo-prod');
    await assert.rejects(
      workspaces.createWorkspace(
        owner,
        { name: 'Prod demo', loadDemoData: true },
        { env: 'prod', seed: () => assert.fail('never seeded') },
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as { statusCode?: unknown }).statusCode === 400 &&
        error.message === 'Demo data is not available on this stage',
    );
    assert.equal((await docs('Workspaces', { name: 'Prod demo' })).length, 0);
    const plain = await workspaces.createWorkspace(owner, { name: 'Plain' });
    for (const workspace of [plain]) {
      for (const collection of ['Integrations', 'Credentials', 'Items', 'Containers']) {
        const rows = await docs(collection, { workspaceId: workspace.id });
        assert.equal(rows.length, 0, `${workspace.name}: ${collection}`);
      }
      // D1: only the empty Personal page, no template pages.
      const pages = await docs('Dashboards', { workspaceId: workspace.id });
      assert.equal(pages.length, 1, `${workspace.name}: Dashboards`);
      assert.equal(pages[0]?.['templateKey'], null);
      const stored = await (await models.getWorkspaceRepository()).findById(workspace.id);
      assert.deepEqual(stored?.settings.topicRules, []);
    }
  });
});
