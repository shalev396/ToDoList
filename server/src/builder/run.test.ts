import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AggregateOptions } from '../models/definitions/common.js';
import type { ContainerUpsert } from '../models/definitions/Container.js';
import type { IContainerRepository, IItemRepository } from '../models/index.js';
import type { CreateLocalItemInput, ItemUpsert } from '../models/definitions/Item.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { ContainerQueryRow, ItemQueryRow, Query, QueryResult } from '../types/builder.js';
import { BLOCK_CATALOG } from './catalog.js';
import type { CompileContext } from './compile.js';
import type { RunQueryDeps } from './run.js';

let db: TestDatabase;
let items: IItemRepository;
let containers: IContainerRepository;
let runQuery: (query: Query, ctx: CompileContext, deps: RunQueryDeps) => Promise<QueryResult>;
let deps: RunQueryDeps;
const calls: AggregateOptions[] = [];

const FAKE_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';
const NOW = new Date('2026-11-11T08:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const EXTRA_TODOS = 25;

/** u-1 sees every integration the tests seed (its own or shared). */
const ACCESS: CompileContext['access'] = {
  userId: 'u-1',
  integrations: (['jira', 'clickup', 'google_calendar', 'moodle'] as const).map((provider) => ({
    id: `i-${provider}`,
    provider,
    accountId: 'acct',
    ownerUserId: 'u-1',
  })),
  local: 'visible',
};

function context(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    ws: { id: 'w-a' },
    userId: 'u-1',
    access: ACCESS,
    vars: {},
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    weekStart: 'sun',
    preview: false,
    ...overrides,
  };
}

function mirrored(
  provider: 'jira' | 'clickup' | 'google_calendar',
  externalId: string,
  extra: Partial<ItemUpsert> = {},
): ItemUpsert {
  return {
    integrationId: `i-${provider}`,
    kind: provider === 'google_calendar' ? 'event' : 'issue',
    topicId: provider === 'google_calendar' ? 'college' : 'work',
    title: `${provider} ${externalId}`,
    status: 'open',
    source: {
      provider,
      accountId: 'acct',
      externalId,
      key: provider === 'jira' ? `ADS-${externalId}` : null,
      url: `https://${provider}.example/items/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
    ...extra,
  };
}

before(async () => {
  db = await startTestDatabase('todolist_run_query');
  const models = await import('../models/index.js');
  items = await models.getItemRepository();
  containers = await models.getContainerRepository();
  ({ runQuery } = await import('./run.js'));
  deps = {
    items: (workspaceId, stages, options): Promise<Record<string, unknown>[]> => {
      calls.push(options);
      return items.aggregate(workspaceId, stages, options);
    },
    containers: (workspaceId, stages, options): Promise<Record<string, unknown>[]> => {
      calls.push(options);
      return containers.aggregate(workspaceId, stages, options);
    },
  };

  await items.bulkUpsert('w-a', [
    mirrored('jira', '1', { dueAt: new Date(NOW.getTime() + 2 * DAY), priority: 3 }),
    mirrored('jira', '2', { dueAt: new Date(NOW.getTime() + 1 * DAY), labels: ['backend'] }),
    mirrored('jira', '3', {
      status: 'done',
      closedAt: NOW,
      props: { storyPoints: 5, apiToken: 'FAKE-not-a-token', nested: { secret: 'FAKE', ok: 1 } },
    }),
    mirrored('clickup', '1', { dueAt: new Date(NOW.getTime() - DAY) }),
    mirrored('google_calendar', '1', { startAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) }),
    mirrored('google_calendar', 'gone', { deletedAt: NOW }),
  ]);
  await items.createLocal('w-a', { ownerUserId: 'u-1', title: 'My own todo', topicId: 'personal' });
  await items.createLocal('w-a', {
    ownerUserId: 'u-other',
    title: 'Someone else private',
    topicId: 'personal',
    visibility: 'private',
  });
  for (let index = 0; index < EXTRA_TODOS; index += 1) {
    await items.createLocal('w-a', {
      ownerUserId: 'u-1',
      title: `Todo ${String(index)}`,
      topicId: 'personal',
      dueAt: new Date(NOW.getTime() + (index + 5) * DAY),
    });
  }
  await items.bulkUpsert('w-r', [
    mirrored('jira', 'r1', {
      title: `Rotate ${FAKE_TOKEN} today`,
      props: {
        meta: { ok: 1, secret: 'FAKE', deep: { token: 'FAKE', keep: 2 } },
        text: FAKE_TOKEN,
      },
    }),
  ]);
  const local = await items.createLocal('w-r', {
    ownerUserId: 'u-1',
    title: 'Todo',
    topicId: 'work',
  });
  await items.setOverlay('w-r', local.id, { note: `note ${FAKE_TOKEN}` });
  await items.bulkUpsert('w-b', [
    mirrored('jira', 'b1', { title: 'B workspace only' }),
    mirrored('jira', 'b2', { title: 'B workspace only' }),
  ]);
  const course = (externalId: string, name: string): ContainerUpsert => ({
    integrationId: 'i-moodle',
    topicId: 'college',
    type: 'course',
    name,
    source: {
      provider: 'moodle',
      accountId: 'braude',
      externalId,
      key: null,
      url: `https://moodle.example/course/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
  });
  await containers.bulkUpsert('w-a', [course('c1', 'Calculus'), course('c2', 'Algebra')]);
  await containers.bulkUpsert('w-b', [course('c9', 'B course')]);
});

after(async () => {
  await db.stop();
});

/** Workspace A as u-1 sees it: everything but u-other's private item and the deleted event. */
const VISIBLE_IN_A = 6 + EXTRA_TODOS;

describe('runQuery', () => {
  it('the donut total equals the list count', async () => {
    const donut = await runQuery(
      { source: 'items', groupBy: ['source.provider'], aggregate: { op: 'count' } },
      context(),
      deps,
    );
    const list = await runQuery({ source: 'items', limit: 200 }, context(), deps);
    assert.equal(list.rows?.length, VISIBLE_IN_A);
    assert.equal(list.total, VISIBLE_IN_A);
    assert.equal(donut.total, VISIBLE_IN_A);
    assert.equal(
      donut.groups?.reduce((sum, group) => sum + Number(group.value), 0),
      VISIBLE_IN_A,
    );
    assert.equal(donut.rows, undefined);
    assert.deepEqual(
      donut.groups.map((group) => [group.key, group.value]),
      [
        [{ 'source.provider': 'local' }, 1 + EXTRA_TODOS],
        [{ 'source.provider': 'jira' }, 3],
        [{ 'source.provider': 'clickup' }, 1],
        [{ 'source.provider': 'google_calendar' }, 1],
      ],
    );
  });

  it("never returns another workspace's items or containers", async () => {
    const list = await runQuery({ source: 'items', limit: 200 }, context(), deps);
    assert.ok((list.rows ?? []).every((row) => !(row as ItemQueryRow).title.startsWith('B ')));
    const reach = await runQuery(
      {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'title', operator: '=', value: 'B workspace only' }],
        },
      },
      context(),
      deps,
    );
    assert.deepEqual([reach.total, reach.rows?.length], [0, 0]);
    const courses = await runQuery({ source: 'containers' }, context(), deps);
    assert.deepEqual(
      courses.rows?.map((row) => (row as ContainerQueryRow).name),
      ['Algebra', 'Calculus'],
    );
    const inB = await runQuery({ source: 'items' }, context({ ws: { id: 'w-b' } }), deps);
    assert.equal(inB.total, 2);
  });

  it('keeps private items to their owner, deleted items out, and applies an agent narrowing', async () => {
    const titles = async (ctx: CompileContext): Promise<string[]> =>
      ((await runQuery({ source: 'items', limit: 200 }, ctx, deps)).rows ?? []).map(
        (row) => (row as ItemQueryRow).title,
      );
    assert.ok(!(await titles(context())).includes('Someone else private'));
    assert.ok(
      (
        await titles(context({ userId: 'u-other', access: { ...ACCESS, userId: 'u-other' } }))
      ).includes('Someone else private'),
    );
    assert.ok(!(await titles(context())).includes('google_calendar gone'));
    assert.deepEqual(await titles(context({ ws: { id: 'w-a', onlyTopics: ['college'] } })), [
      'google_calendar 1',
    ]);
  });

  it('reads only the integrations in the access: an unshared one stays out', async () => {
    const jiraOnly = { ...ACCESS, integrations: ACCESS.integrations.slice(0, 1) };
    const rows = (
      await runQuery({ source: 'items', limit: 200 }, context({ access: jiraOnly }), deps)
    ).rows as ItemQueryRow[];
    const providers = new Set(rows.map((row) => row.source.provider));
    assert.deepEqual([...providers].sort(), ['jira', 'local']);
  });

  it('dedups a record two integrations of one account mirror, keeping the first in order', async () => {
    await items.bulkUpsert('w-d', [
      { ...mirrored('jira', 'same', { title: 'From A' }), integrationId: 'i-a' },
      { ...mirrored('jira', 'only-b', { title: 'Only B' }), integrationId: 'i-b' },
    ]);
    // B's copy of the same issue: the natural key holds the integration's own account copy.
    await items.bulkUpsert('w-d', [
      {
        ...mirrored('jira', 'same', { title: 'From B' }),
        integrationId: 'i-b',
        source: { ...mirrored('jira', 'same').source, accountId: 'acct', etag: 'b' },
      },
    ]);
    const access: CompileContext['access'] = {
      userId: 'u-1',
      integrations: ['i-a', 'i-b'].map((id) => ({
        id,
        provider: 'jira' as const,
        accountId: 'acct',
        ownerUserId: id === 'i-a' ? 'u-1' : 'u-2',
      })),
      local: 'visible',
    };
    const ws = { id: 'w-d' };
    const plain = await runQuery({ source: 'items' }, context({ ws, access }), deps);
    const deduped = await runQuery(
      { source: 'items' },
      context({ ws, access, connectors: ['i-a', 'i-b'], dedup: ['i-a', 'i-b'] }),
      deps,
    );
    const titlesOf = (result: QueryResult): string[] =>
      (result.rows ?? []).map((row) => (row as ItemQueryRow).title).sort();
    assert.equal(deduped.total, 2);
    assert.deepEqual(titlesOf(deduped), ['From A', 'Only B']);
    const reversed = await runQuery(
      { source: 'items' },
      context({ ws, access, connectors: ['i-b', 'i-a'], dedup: ['i-b', 'i-a'] }),
      deps,
    );
    assert.deepEqual(titlesOf(reversed), ['From B', 'Only B']);
    assert.ok(plain.total >= deduped.total);
  });

  it('caps preview at 20 rows within 2 s, and runs full queries within 10 s', async () => {
    calls.length = 0;
    const preview = await runQuery({ source: 'items' }, context({ preview: true }), deps);
    assert.equal(preview.rows?.length, 20);
    assert.equal(preview.total, VISIBLE_IN_A);
    const full = await runQuery({ source: 'items' }, context(), deps);
    assert.equal(full.rows?.length, 50 > VISIBLE_IN_A ? VISIBLE_IN_A : 50);
    assert.deepEqual(calls, [{ maxTimeMS: 2000 }, { maxTimeMS: 10_000 }]);
  });

  it('gives every row an id and a source.url, and no _id', async () => {
    const list = await runQuery({ source: 'items', limit: 200 }, context(), deps);
    const courses = await runQuery({ source: 'containers' }, context(), deps);
    for (const row of [...(list.rows ?? []), ...(courses.rows ?? [])]) {
      assert.equal(typeof row.id, 'string');
      assert.ok(row.id.length > 0);
      assert.equal('_id' in row, false);
      assert.match(row.source.url, /^(https:\/\/|\/w\/w-a\/items\/)/);
    }
    const local = list.rows?.find((row) => (row as ItemQueryRow).title === 'My own todo');
    assert.equal(local?.source.url, `/w/w-a/items/${local?.id ?? ''}`);
  });

  it('sorts by dueAt ascending with undated items last', async () => {
    const list = await runQuery({ source: 'items', limit: 200 }, context(), deps);
    const due = (list.rows ?? []).map((row) => (row as ItemQueryRow).dueAt);
    const firstNull = due.findIndex((value) => value === null);
    assert.ok(firstNull > 0);
    assert.ok(due.slice(firstNull).every((value) => value === null));
    const dated = due.slice(0, firstNull).map((value) => value?.getTime() ?? 0);
    assert.deepEqual(
      dated,
      [...dated].sort((a, b) => a - b),
    );
    assert.equal((list.rows?.[0] as ItemQueryRow).title, 'clickup 1');
  });

  it('returns rows and a count per column for a kanban', async () => {
    const kanban = await runQuery(
      { source: 'items', groupBy: ['status'], limit: 200 },
      context(),
      deps,
    );
    assert.equal(kanban.rows?.length, VISIBLE_IN_A);
    assert.deepEqual(
      kanban.groups?.map((group) => [group.key['status'], group.value]),
      [
        ['open', VISIBLE_IN_A - 1],
        ['done', 1],
      ],
    );
  });

  it('aggregates and filters through the compiler', async () => {
    const earliest = await runQuery(
      {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'source.provider', operator: 'in', value: ['jira', 'clickup'] }],
        },
        groupBy: ['source.provider'],
        aggregate: { op: 'earliest' },
      },
      context(),
      deps,
    );
    assert.deepEqual(
      earliest.groups?.map((group) => [group.key['source.provider'], group.value]),
      [
        ['clickup', new Date(NOW.getTime() - DAY)],
        ['jira', new Date(NOW.getTime() + DAY)],
      ],
    );
    const counter = await runQuery(
      { source: 'items', aggregate: { op: 'count' } },
      context(),
      deps,
    );
    assert.deepEqual(counter.groups, [{ key: {}, value: VISIBLE_IN_A }]);
    const today = await runQuery(
      { source: 'items', dateRange: 'today', dateField: 'startAt' },
      context(),
      deps,
    );
    assert.deepEqual(
      today.rows?.map((row) => (row as ItemQueryRow).title),
      ['google_calendar 1'],
    );
  });

  it('reports the variables it used and the rules it skipped', async () => {
    const query: Query = {
      source: 'items',
      where: {
        combinator: 'and',
        rules: [
          { field: 'source.provider', operator: '=', value: '$page.provider' },
          { field: 'labels', operator: 'contains', value: '$page.label' },
        ],
      },
    };
    const result = await runQuery(query, context({ vars: { '$page.provider': 'jira' } }), deps);
    assert.equal(result.total, 3);
    assert.deepEqual(result.appliedVars, { '$page.provider': 'jira' });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /\$page\.label/);
  });

  it('drops credential-shaped keys from props', async () => {
    const done = await runQuery(
      {
        source: 'items',
        where: { combinator: 'and', rules: [{ field: 'status', operator: '=', value: 'done' }] },
      },
      context(),
      deps,
    );
    assert.deepEqual((done.rows?.[0] as ItemQueryRow).props, { storyPoints: 5, nested: { ok: 1 } });
  });

  it('the repository passes maxTimeMS to MongoDB', async () => {
    await assert.rejects(items.aggregate('w-a', [{ $count: 'n' }], { maxTimeMS: -1 }), /maxTimeMS/);
    const [count] = await items.aggregate<{ n: number }>('w-a', [{ $count: 'n' }], {
      maxTimeMS: 5000,
    });
    assert.ok((count?.n ?? 0) > 0);
  });

  it('scrubs deny-listed keys from object-valued group keys', async () => {
    const result = await runQuery(
      { source: 'items', groupBy: ['props.meta'], aggregate: { op: 'count' } },
      context({ ws: { id: 'w-r' } }),
      deps,
    );
    const keyed = result.groups?.find((group) => group.key['props.meta'] !== null);
    assert.deepEqual(keyed?.key, { 'props.meta': { ok: 1, deep: { keep: 2 } } });
  });

  it('redacts token-shaped text in titles, previews, notes and props', async () => {
    const result = await runQuery(
      { source: 'items', limit: 200 },
      context({ ws: { id: 'w-r' } }),
      deps,
    );
    const rows = (result.rows ?? []) as ItemQueryRow[];
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(result).includes(FAKE_TOKEN));
    const mirroredRow = rows.find((row) => row.source.provider === 'jira');
    assert.equal(mirroredRow?.title, 'Rotate [REDACTED:github_token] today');
    assert.equal(mirroredRow.props['text'], '[REDACTED:github_token]');
    assert.equal(
      rows.find((row) => row.source.provider === 'local')?.overlay.note,
      'note [REDACTED:github_token]',
    );
  });
});

describe('runQuery: a timesheet (a topic’s painted time and its open to-dos)', () => {
  /** The week of NOW in Asia/Jerusalem, Sunday to Sunday, as the grid sets `$page.range`. */
  const WEEK = { from: '2026-11-07T22:00:00Z', to: '2026-11-14T22:00:00Z' };
  const timesheetQuery = (): Query => {
    const query = BLOCK_CATALOG.timesheet.defaults.query;
    assert.ok(query !== undefined);
    return query;
  };
  const titles = (result: QueryResult): string[] =>
    ((result.rows ?? []) as ItemQueryRow[]).map((row) => row.title).sort();
  let plannedId = '';

  before(async () => {
    const block = (
      title: string,
      startAt: string,
      endAt: string,
      props: Record<string, unknown>,
    ): CreateLocalItemInput => ({
      ownerUserId: 'u-1',
      title,
      topicId: 'work',
      kind: 'block' as const,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      props: { ...props },
    });
    // An area painted every Tuesday since October: one series row, weeks before the range.
    await items.createLocal(
      'w-t',
      block('TLVTech', '2026-10-20T06:00:00Z', '2026-10-20T14:00:00Z', {
        layer: 'area',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      }),
    );
    await items.createLocal(
      'w-t',
      block('Deep work', '2026-11-12T07:00:00Z', '2026-11-12T09:00:00Z', { layer: 'block' }),
    );
    await items.createLocal(
      'w-t',
      block('Next week block', '2026-11-19T07:00:00Z', '2026-11-19T09:00:00Z', { layer: 'block' }),
    );
    const planned = await items.createLocal('w-t', {
      ownerUserId: 'u-1',
      title: 'Write the report',
      topicId: 'work',
    });
    plannedId = planned.id;
    await items.setOverlay('w-t', planned.id, { plannedAt: '2026-11-10T10:30' });
    await items.createLocal('w-t', {
      ownerUserId: 'u-1',
      title: 'Due in December',
      topicId: 'work',
      status: 'in_progress',
      dueAt: new Date('2026-12-20T10:00:00Z'),
    });
    await items.createLocal('w-t', {
      ownerUserId: 'u-1',
      title: 'Already done',
      topicId: 'work',
      status: 'done',
    });
    await items.createLocal('w-t', { ownerUserId: 'u-1', title: 'Buy milk', topicId: 'personal' });
    await items.bulkUpsert('w-t', [
      mirrored('jira', 't1', { title: 'Fix the login' }),
      mirrored('jira', 't2', { title: 'Shipped issue', status: 'done' }),
      mirrored('google_calendar', 't3', {
        title: 'Standup',
        topicId: 'work',
        startAt: new Date('2026-11-11T07:00:00Z'),
      }),
    ]);
  });

  it('reads the topic’s areas and blocks in the week, and its open to-dos whatever their dates', async () => {
    const result = await runQuery(
      timesheetQuery(),
      context({ ws: { id: 'w-t' }, blockType: 'timesheet', vars: { topic: 'work', range: WEEK } }),
      deps,
    );
    assert.deepEqual(titles(result), [
      'Deep work',
      'Due in December',
      'Fix the login',
      'TLVTech',
      'Write the report',
    ]);
    const rows = (result.rows ?? []) as ItemQueryRow[];
    // Reserved time first (sorted by kind), so the row cap never cuts an area for a to-do.
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['block', 'block', 'issue', 'todo', 'todo'],
    );
    const area = rows.find((row) => row.title === 'TLVTech');
    assert.equal(area?.props['layer'], 'area');
    assert.deepEqual(area.props['recurrence'], ['RRULE:FREQ=WEEKLY;BYDAY=TU']);
    // A planned to-do carries its plan, a wall time in the workspace's zone.
    assert.equal(rows.find((row) => row.id === plannedId)?.overlay.plannedAt, '2026-11-10T10:30');
    assert.deepEqual(result.appliedVars, { '$page.topic': 'work', '$page.range': WEEK });
  });

  it('on the main page (no topic set) reads every topic', async () => {
    const result = await runQuery(
      timesheetQuery(),
      context({ ws: { id: 'w-t' }, blockType: 'timesheet', vars: { range: WEEK } }),
      deps,
    );
    assert.ok(titles(result).includes('Buy milk'));
    assert.ok(!titles(result).includes('Already done'));
    assert.ok(!titles(result).includes('Standup'));
  });

  it('as any other block, the same range narrows the to-dos too', async () => {
    const result = await runQuery(
      timesheetQuery(),
      context({ ws: { id: 'w-t' }, blockType: 'calendar', vars: { topic: 'work', range: WEEK } }),
      deps,
    );
    assert.deepEqual(titles(result), ['Deep work', 'TLVTech']);
  });
});
