/**
 * The builder against the seeded demo workspace: every filter operator the catalog allows, run
 * through the real query service, matches what the stored items say; the status order is the
 * workflow's; connectors (`integrationId in [...]`) select exactly their accounts; and a second
 * full fixture sync of every seeded integration contributes items and changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { contextFor, newUser } from '../testing/workspaceFixtures.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Models from '../models/index.js';
import type * as Workspaces from '../services/workspaces.js';
import type * as Query from '../services/workspaceQuery.js';
import type * as Seed from './seedWorkspace.js';
import type * as DemoData from './demoData.js';
import type * as FixtureSets from '../sync/fixtureSets.js';
import type * as Registry from '../sync/registry.js';
import type * as RunSync from '../sync/runSync.js';
import type * as Fixtures from '../sync/transports/fixtures.js';
import type { SeedSummary } from './seedWorkspace.js';
import type { WorkspaceContext } from '../services/accessFilter.js';
import type { Clock } from '../sync/http.js';
import { OPERATORS, type Query as BuilderQuery } from '../types/builder.js';

/** Thursday 2026-11-12, 11:00 in Asia/Jerusalem, as in seedWorkspace.test.ts. */
const NOW = new Date('2026-11-12T09:00:00.000Z');
const TIME_ZONE = 'Asia/Jerusalem';
const noWaitClock: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

let db: TestDatabase;
let guard: OutboundGuard;
let models: typeof Models;
let workspaces: typeof Workspaces;
let queries: typeof Query;
let seed: typeof Seed;
let demo: typeof DemoData;
let fixtureSets: typeof FixtureSets;
let registry: typeof Registry;
let runSync: typeof RunSync;
let fixtures: typeof Fixtures;

let ownerId = '';
let ctx: WorkspaceContext;
let seeded: SeedSummary;
type Doc = Record<string, unknown>;
let items: Doc[] = [];

before(async () => {
  db = await startTestDatabase('todolist_builder_seeded_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  models = await import('../models/index.js');
  workspaces = await import('../services/workspaces.js');
  queries = await import('../services/workspaceQuery.js');
  seed = await import('./seedWorkspace.js');
  demo = await import('./demoData.js');
  fixtureSets = await import('../sync/fixtureSets.js');
  registry = await import('../sync/registry.js');
  runSync = await import('../sync/runSync.js');
  fixtures = await import('../sync/transports/fixtures.js');
  guard = installOutboundGuard();
  const owner = await newUser('builder-seeded');
  ownerId = owner.id;
  const workspace = await workspaces.createWorkspace(owner, { name: 'Builder seeded' });
  seeded = await seed.seedWorkspace(workspace.id, NOW);
  ctx = await contextFor(workspace.id, ownerId);
  items = await storedItems();
});

after(async () => {
  guard.restore();
  await db.stop();
});

async function storedItems(): Promise<Doc[]> {
  const database = mongoose.connection.db;
  assert.ok(database);
  const rows = await database
    .collection<Doc>('Items')
    .find({ workspaceId: ctx.id, deletedAt: null })
    .toArray();
  // What the owner may see: workspace-visible items, and their own.
  return rows.filter(
    (row): boolean => row['visibility'] === 'workspace' || row['ownerUserId'] === ownerId,
  );
}

/** The total of a query over the owner's items, through the same service the API uses. */
async function totalOf(rule: unknown): Promise<number> {
  const result = await queries.runWorkspaceQuery(
    ctx,
    ownerId,
    { draft: { source: 'items', where: { combinator: 'and', rules: [rule] }, limit: 1 } },
    NOW,
  );
  return result.total;
}

function dueOf(row: Doc): Date | null {
  return row['dueAt'] instanceof Date ? row['dueAt'] : null;
}

function numberOf(row: Doc): number | null {
  return typeof row['priority'] === 'number' ? row['priority'] : null;
}

function count(test: (row: Doc) => boolean): number {
  return items.filter(test).length;
}

const at = (iso: string): Date => new Date(iso);

function inWindow(due: Date | null, from: string, to: string): boolean {
  return due !== null && due >= at(from) && due < at(to);
}

function labelsOf(row: Doc): string[] {
  return Array.isArray(row['labels']) ? (row['labels'] as string[]) : [];
}

describe('builder operators against the seeded workspace', () => {
  const cases: [string, unknown, (row: Doc) => boolean][] = [
    [
      '=',
      { field: 'status', operator: '=', value: 'open' },
      (row): boolean => row['status'] === 'open',
    ],
    [
      '!=',
      { field: 'status', operator: '!=', value: 'done' },
      (row): boolean => row['status'] !== 'done',
    ],
    [
      '<',
      { field: 'priority', operator: '<', value: 3 },
      (row): boolean => (numberOf(row) ?? 99) < 3,
    ],
    [
      '<=',
      { field: 'priority', operator: '<=', value: 3 },
      (row): boolean => (numberOf(row) ?? 99) <= 3,
    ],
    [
      '>',
      { field: 'priority', operator: '>', value: 2 },
      (row): boolean => (numberOf(row) ?? -1) > 2,
    ],
    [
      '>=',
      { field: 'priority', operator: '>=', value: 3 },
      (row): boolean => (numberOf(row) ?? -1) >= 3,
    ],
    [
      'in',
      { field: 'status', operator: 'in', value: ['open', 'in_progress'] },
      (row): boolean => row['status'] === 'open' || row['status'] === 'in_progress',
    ],
    [
      'notIn',
      { field: 'kind', operator: 'notIn', value: ['event', 'file'] },
      (row): boolean => row['kind'] !== 'event' && row['kind'] !== 'file',
    ],
    [
      'contains',
      { field: 'title', operator: 'contains', value: 'API' },
      (row): boolean => String(row['title']).toLowerCase().includes('api'),
    ],
    [
      'beginsWith',
      { field: 'title', operator: 'beginsWith', value: 'plan' },
      (row): boolean => String(row['title']).toLowerCase().startsWith('plan'),
    ],
    [
      'within',
      { field: 'dueAt', operator: 'within', value: 'next_7d' },
      (row): boolean => {
        const due = dueOf(row);
        return due !== null && due >= NOW && due < at('2026-11-19T09:00:00.000Z');
      },
    ],
    [
      'between',
      {
        field: 'dueAt',
        operator: 'between',
        value: ['2026-11-12T00:00:00.000Z', '2026-11-30T00:00:00.000Z'],
      },
      (row): boolean => {
        const due = dueOf(row);
        return (
          due !== null &&
          due >= at('2026-11-12T00:00:00.000Z') &&
          due <= at('2026-11-30T00:00:00.000Z')
        );
      },
    ],
    [
      'notContains',
      { field: 'title', operator: 'notContains', value: 'API' },
      (row): boolean => !String(row['title']).toLowerCase().includes('api'),
    ],
    [
      'endsWith',
      { field: 'title', operator: 'endsWith', value: 'e' },
      (row): boolean => String(row['title']).toLowerCase().endsWith('e'),
    ],
    [
      'notBetween',
      { field: 'priority', operator: 'notBetween', value: [1, 3] },
      (row): boolean => (numberOf(row) ?? 0) < 1 || (numberOf(row) ?? 0) > 3,
    ],
    [
      // Today is Nov 12 (Jerusalem, +2): local days start at 22:00 UTC the day before.
      'inNext',
      { field: 'dueAt', operator: 'inNext', value: [14, 'days'] },
      (row): boolean =>
        inWindow(dueOf(row), '2026-11-11T22:00:00.000Z', '2026-11-26T22:00:00.000Z'),
    ],
    [
      'notInNext',
      { field: 'dueAt', operator: 'notInNext', value: [14, 'days'] },
      (row): boolean =>
        !inWindow(dueOf(row), '2026-11-11T22:00:00.000Z', '2026-11-26T22:00:00.000Z'),
    ],
    [
      'inLast',
      { field: 'dueAt', operator: 'inLast', value: [10, 'days'] },
      (row): boolean =>
        inWindow(dueOf(row), '2026-11-01T22:00:00.000Z', '2026-11-12T22:00:00.000Z'),
    ],
    [
      'notInLast',
      { field: 'dueAt', operator: 'notInLast', value: [10, 'days'] },
      (row): boolean =>
        !inWindow(dueOf(row), '2026-11-01T22:00:00.000Z', '2026-11-12T22:00:00.000Z'),
    ],
    [
      'moreThanAgo',
      { field: 'dueAt', operator: 'moreThanAgo', value: [2, 'days'] },
      (row): boolean => {
        const due = dueOf(row);
        return due !== null && due < at('2026-11-09T22:00:00.000Z');
      },
    ],
    [
      'on',
      { field: 'dueAt', operator: 'on', value: '2026-11-13T12:00:00.000Z' },
      (row): boolean =>
        inWindow(dueOf(row), '2026-11-12T22:00:00.000Z', '2026-11-13T22:00:00.000Z'),
    ],
    [
      'notOn',
      { field: 'dueAt', operator: 'notOn', value: '2026-11-13T12:00:00.000Z' },
      (row): boolean =>
        !inWindow(dueOf(row), '2026-11-12T22:00:00.000Z', '2026-11-13T22:00:00.000Z'),
    ],
    [
      'allOf',
      { field: 'labels', operator: 'allOf', value: ['docs'] },
      (row): boolean => labelsOf(row).includes('docs'),
    ],
    [
      'noneOf',
      { field: 'labels', operator: 'noneOf', value: ['docs'] },
      (row): boolean => !labelsOf(row).includes('docs'),
    ],
    ['null', { field: 'dueAt', operator: 'null' }, (row): boolean => dueOf(row) === null],
    ['notNull', { field: 'dueAt', operator: 'notNull' }, (row): boolean => dueOf(row) !== null],
  ];

  it('covers every operator the catalog has', () => {
    assert.deepEqual([...new Set(cases.map(([name]) => name))].sort(), [...OPERATORS].sort());
  });

  for (const [name, rule, expected] of cases) {
    it(`${name} returns what the stored items say`, async () => {
      const want = count(expected);
      assert.ok(
        want > 0 && want < items.length,
        `${name} splits the data (${String(want)} of ${String(items.length)})`,
      );
      assert.equal(await totalOf(rule), want);
    });
  }

  it('an array field: labels contains', async () => {
    const label =
      items.flatMap((row): string[] => (row['labels'] as string[] | undefined) ?? [])[0] ?? '';
    assert.notEqual(label, '', 'the seeded items carry labels');
    const want = count((row): boolean =>
      ((row['labels'] as string[] | undefined) ?? []).includes(label),
    );
    assert.equal(await totalOf({ field: 'labels', operator: 'contains', value: label }), want);
  });
});

describe('connectors and ordering against the seeded workspace', () => {
  it('integrationId in [two accounts] returns exactly their items, many-to-one', async () => {
    const byKey = new Map(seeded.integrations.map((entry) => [entry.key, entry.integrationId]));
    const ids = [byKey.get('clickup'), byKey.get('jira')].filter(
      (id): id is string => id !== undefined,
    );
    assert.equal(ids.length, 2);
    const result = await queries.runWorkspaceQuery(
      ctx,
      ownerId,
      {
        draft: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'integrationId', operator: 'in', value: ids }],
          },
          limit: 200,
        },
      },
      NOW,
    );
    const want = items.filter((row): boolean => ids.includes(String(row['integrationId'])));
    assert.ok(want.length >= 2);
    assert.equal(result.total, want.length);
    const providers = new Set(
      (result.rows ?? []).map(
        (row): string => (row as { source: { provider: string } }).source.provider,
      ),
    );
    assert.deepEqual([...providers].sort(), ['clickup', 'jira']);
  });

  it('two GitHub accounts are two connectors', async () => {
    const github = seeded.integrations.filter((entry) => entry.provider === 'github');
    assert.equal(github.length, 2);
    for (const entry of github) {
      const want = count((row): boolean => row['integrationId'] === entry.integrationId);
      assert.ok(want > 0, entry.key);
      assert.equal(
        await totalOf({ field: 'integrationId', operator: 'in', value: [entry.integrationId] }),
        want,
        entry.key,
      );
    }
  });

  it('sorting by status follows open, in_progress, done, cancelled', async () => {
    const result = await queries.runWorkspaceQuery(
      ctx,
      ownerId,
      { draft: { source: 'items', sort: [{ field: 'status', dir: 'asc' }], limit: 200 } },
      NOW,
    );
    const order = ['open', 'in_progress', 'done', 'cancelled'];
    const ranks = (result.rows ?? []).map((row): number =>
      order.indexOf((row as { status: string }).status),
    );
    assert.ok(ranks.length > 10);
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
    );
    assert.ok(new Set(ranks).size >= 3, 'the seed has at least three statuses');
  });

  it('the Work dashboard has a Tasks list over ClickUp and Jira, ordered by status', async () => {
    const dashboards = await (await models.getDashboardRepository()).list(ctx.id, {});
    const work = dashboards.find((dashboard) => dashboard.templateKey === 'work@1');
    assert.ok(work);
    const blocks = work.blocks as { title: string; type: string; query?: BuilderQuery }[];
    const tasks = blocks.find((block) => block.title === 'Tasks');
    assert.ok(tasks);
    assert.equal(tasks.type, 'list');
    assert.equal(tasks.query?.sort?.[0]?.field, 'status');
    assert.equal(work.publishedVersion, work.version);
  });
});

describe('a second full fixture sync of every seeded integration', () => {
  it('each provider contributes items, and the run is a no-op', async () => {
    const stored = await (await models.getIntegrationRepository()).list(ctx.id);
    assert.equal(stored.length, demo.DEMO_INTEGRATIONS.length);
    const contributed = new Set<string>();
    for (const integration of stored) {
      const set = demo.demoFixtureSet(integration.provider, integration.config) ?? '';
      assert.notEqual(set, '', integration.label);
      const adapter = registry.getAdapter(integration.provider);
      assert.ok(adapter);
      const transport = fixtures.fixtureTransport(
        await fixtures.loadFixtureSet(fixtureSets.fixtureSetDir(adapter, set)),
        {
          now: NOW,
          timeZone: TIME_ZONE,
        },
      );
      const before = count((row): boolean => row['integrationId'] === integration.id);
      assert.ok(before > 0, `${integration.label} has items`);
      const run = await runSync.runIntegrationSync(integration.id, {
        trigger: 'manual',
        mode: 'fixtures',
        fixtureSet: set,
        now: NOW,
        clock: noWaitClock,
        transport,
      });
      assert.equal(run.error, null, integration.label);
      assert.notEqual(run.status, 'failed', integration.label);
      assert.equal(run.counts.inserted, 0, `${integration.label} inserted`);
      assert.equal(run.counts.updated, 0, `${integration.label} updated`);
      assert.equal(run.counts.closed, 0, `${integration.label} closed`);
      assert.equal(run.counts.deleted, 0, `${integration.label} deleted`);
      assert.equal(run.counts.unchanged, before, `${integration.label} unchanged`);
      contributed.add(integration.provider);
    }
    assert.deepEqual([...contributed].sort(), [
      'clickup',
      'github',
      'google_calendar',
      'google_drive',
      'jira',
      'linear',
      'moodle',
    ]);
    assert.equal((await storedItems()).length, items.length);
  });

  it('demoFixtureSet picks the seed fixture set for the acme-labs org', () => {
    assert.equal(demo.demoFixtureSet('github', { owner: 'acme-labs' }), 'orgs');
    assert.equal(demo.demoFixtureSet('github', { owner: 'shalev396' }), 'v1');
    assert.equal(demo.demoFixtureSet('jira', {}), 'v1');
    assert.equal(demo.demoFixtureSet('local', {}), undefined);
  });
});
