/**
 * H5 in a dashboard block (the compiled pipeline, run on a real mongod): a provider copy of a local
 * to-do is hidden only while its to-do shows in the same read; otherwise the copy is a row of its
 * own. The to-do shows when the viewer may see it and it matches the block's whole filter (its
 * connectors, date range, rules, variables and topic narrowing); sort, limit and pages do not
 * count. Counts, groups and rows agree. The access filter stays the first stage.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CreateLocalItemInput, ItemUpsert } from '../models/definitions/Item.js';
import type { IItemRepository } from '../models/index.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Query, QueryResult, RuleGroup } from '../types/builder.js';
import type { CompileContext } from './compile.js';
import type { RunQueryDeps } from './run.js';

let db: TestDatabase;
let items: IItemRepository;
let runQuery: (query: Query, ctx: CompileContext, deps: RunQueryDeps) => Promise<QueryResult>;
let deps: RunQueryDeps;

/** u-1 and u-2 both see the Linear integration (u-1's, shared on a block). */
const context = (
  ws: string,
  userId = 'u-1',
  extra: Partial<CompileContext> = {},
): CompileContext => ({
  ws: { id: ws },
  userId,
  vars: {},
  now: new Date('2026-11-11T08:00:00Z'),
  timeZone: 'Asia/Jerusalem',
  weekStart: 'sun',
  preview: false,
  access: {
    userId,
    integrations: [{ id: 'i-linear', provider: 'linear', accountId: 'acct', ownerUserId: 'u-1' }],
    local: 'visible',
  },
  ...extra,
});

before(async () => {
  db = await startTestDatabase('todolist_builder_copy_absorption');
  const models = await import('../models/index.js');
  items = await models.getItemRepository();
  const containers = await models.getContainerRepository();
  ({ runQuery } = await import('./run.js'));
  deps = {
    items: (workspaceId, stages, options): Promise<Record<string, unknown>[]> =>
      items.aggregate(workspaceId, stages, options),
    containers: (workspaceId, stages, options): Promise<Record<string, unknown>[]> =>
      containers.aggregate(workspaceId, stages, options),
  };
});

after(async () => {
  await db.stop();
});

let n = 0;

interface Pair {
  ws: string;
  todo: string;
  copy: string;
}

/** A Linear issue of the shared integration, open unless `fields` say otherwise. */
async function mirrored(ws: string, id: string, fields: Partial<ItemUpsert> = {}): Promise<string> {
  await items.bulkUpsert(ws, [
    {
      id,
      integrationId: 'i-linear',
      kind: 'issue',
      topicId: null,
      title: `Linear ${id}`,
      status: 'open',
      source: {
        provider: 'linear',
        accountId: 'acct',
        externalId: id,
        key: id.toUpperCase(),
        url: `https://linear.app/x/issue/${id}`,
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
      ...fields,
    },
  ]);
  return id;
}

/**
 * In a workspace of its own: u-1's to-do "Plan" (shared, open unless `todo` says otherwise) and
 * its Linear copy "Plan (Linear)" (open unless `copy` says otherwise), marked as TodoCopy marks it.
 */
async function pair(
  todo: Partial<CreateLocalItemInput> = {},
  copy: Partial<ItemUpsert> = {},
): Promise<Pair> {
  n += 1;
  const ws = `w-copy-${String(n)}`;
  const made = await items.createLocal(ws, {
    ownerUserId: 'u-1',
    title: 'Plan',
    topicId: null,
    visibility: 'workspace',
    ...todo,
  });
  const copyId = await mirrored(ws, `copy-${String(n)}`, { title: 'Plan (Linear)', ...copy });
  await items.setOverlay(ws, copyId, {
    copyOf: made.id,
    copyOfOwner: made.ownerUserId,
    copyOfShared: made.visibility === 'workspace',
  });
  return { ws, todo: made.id, copy: copyId };
}

const rule = (field: string, operator: string, value?: unknown): RuleGroup =>
  ({
    combinator: 'and',
    rules: [{ field, operator, ...(value === undefined ? {} : { value }) }],
  }) as RuleGroup;

const OPEN = rule('status', 'in', ['open', 'in_progress']);

async function run(query: Partial<Query>, ctx: CompileContext): Promise<QueryResult> {
  return runQuery({ source: 'items', limit: 50, ...query }, ctx, deps);
}

async function idsOf(query: Partial<Query>, ctx: CompileContext): Promise<string[]> {
  return ((await run(query, ctx)).rows ?? []).map((row) => row.id).sort();
}

describe('a dashboard block and a provider copy', () => {
  it('to-do open, copy open: one row, the to-do (unfiltered, and filtered to open)', async () => {
    const { ws, todo } = await pair();
    assert.deepEqual(await idsOf({}, context(ws)), [todo]);
    assert.deepEqual(await idsOf({ where: OPEN }, context(ws)), [todo]);
    assert.equal((await run({ aggregate: { op: 'count' } }, context(ws))).total, 1);
  });

  it('to-do done, copy open: an "open" block shows the copy (the hole)', async () => {
    const { ws, todo, copy } = await pair({ status: 'done' });
    assert.deepEqual(await idsOf({ where: OPEN }, context(ws)), [copy]);
    // Unfiltered, both are in the read: one row, the to-do.
    assert.deepEqual(await idsOf({}, context(ws)), [todo]);
  });

  it('the same through a $page variable (a cross-filter from another block)', async () => {
    const { ws, todo, copy } = await pair({ status: 'done' });
    const where = rule('status', '=', '$page.status');
    assert.deepEqual(await idsOf({ where }, context(ws, 'u-1', { vars: { status: 'open' } })), [
      copy,
    ]);
    assert.deepEqual(await idsOf({ where }, context(ws, 'u-1', { vars: { status: 'done' } })), [
      todo,
    ]);
  });

  it('to-do done, copy done: a "done" block shows the to-do only', async () => {
    const { ws, todo } = await pair({ status: 'done' }, { status: 'done', closedAt: new Date() });
    assert.deepEqual(await idsOf({ where: rule('status', '=', 'done') }, context(ws)), [todo]);
  });

  it('a kind = issue block shows the copy', async () => {
    const { ws, copy } = await pair();
    assert.deepEqual(await idsOf({ where: rule('kind', '=', 'issue') }, context(ws)), [copy]);
  });

  it('a block filtered by the copy’s provider shows the copy; filtered to local, the to-do', async () => {
    const { ws, todo, copy } = await pair();
    const linear = rule('source.provider', '=', 'linear');
    assert.deepEqual(await idsOf({ where: linear }, context(ws)), [copy]);
    const local = rule('source.provider', '=', 'local');
    assert.deepEqual(await idsOf({ where: local }, context(ws)), [todo]);
    const both = rule('source.provider', 'in', ['local', 'linear']);
    assert.deepEqual(await idsOf({ where: both }, context(ws)), [todo]);
  });

  it('connectors without local show the copy (the old excludesLocal case); with local, the to-do', async () => {
    const { ws, todo, copy } = await pair();
    assert.deepEqual(await idsOf({}, context(ws, 'u-1', { connectors: ['i-linear'] })), [copy]);
    assert.deepEqual(await idsOf({}, context(ws, 'u-1', { connectors: ['i-linear', 'local'] })), [
      todo,
    ]);
  });

  it('a calendar’s date range: the copy shows while its to-do is outside the range', async () => {
    const inRange = new Date('2026-11-12T10:00:00Z');
    const later = new Date('2026-12-20T10:00:00Z');
    const block = { blockType: 'calendar' as const };
    const { ws, copy } = await pair({ dueAt: later }, { dueAt: inRange });
    const week = { dateRange: 'this_week' as const };
    assert.deepEqual(await idsOf(week, context(ws, 'u-1', block)), [copy]);
    const both = await pair({ dueAt: inRange }, { dueAt: inRange });
    assert.deepEqual(await idsOf(week, context(both.ws, 'u-1', block)), [both.todo]);
  });

  it('a topic narrowing (an MCP key’s topics) the to-do is outside of shows the copy', async () => {
    const { ws, todo, copy } = await pair({ topicId: 't-home' }, { topicId: 't-work' });
    const narrowed = context(ws, 'u-1', { ws: { id: ws, onlyTopics: ['t-work'] } });
    assert.deepEqual(await idsOf({}, narrowed), [copy]);
    assert.deepEqual(await idsOf({}, context(ws)), [todo]);
  });

  it('the copy of a to-do private to another member: visibility rules unchanged', async () => {
    const { ws, todo, copy } = await pair({ visibility: 'private' });
    // u-1 made the to-do: one row, the to-do.
    assert.deepEqual(await idsOf({}, context(ws, 'u-1')), [todo]);
    // u-2 may not see it, so the copy (of the shared integration) is theirs to see.
    assert.deepEqual(await idsOf({}, context(ws, 'u-2')), [copy]);
    assert.deepEqual(await idsOf({ where: OPEN }, context(ws, 'u-2')), [copy]);
  });

  it('sort and limit do not count: a copy that would sort first stays hidden', async () => {
    const { ws, todo } = await pair();
    // "Plan (Linear)" sorts before "Plan" descending, yet the one row is the to-do.
    const first = await run({ sort: [{ field: 'title', dir: 'desc' }], limit: 1 }, context(ws));
    assert.deepEqual(
      (first.rows ?? []).map((row) => row.id),
      [todo],
    );
    assert.equal(first.total, 1);
  });

  it('a group-by-source chart: the counts match the rows', async () => {
    const { ws, todo, copy } = await pair({ status: 'done' });
    // A second to-do, open, with an open copy of its own; and a plain Linear issue.
    const other = await items.createLocal(ws, {
      ownerUserId: 'u-1',
      title: 'Write',
      topicId: null,
      visibility: 'workspace',
    });
    const otherCopy = await mirrored(ws, `${ws}-other-copy`, { title: 'Write (Linear)' });
    await items.setOverlay(ws, otherCopy, {
      copyOf: other.id,
      copyOfOwner: 'u-1',
      copyOfShared: true,
    });
    const plain = await mirrored(ws, `${ws}-plain`);

    for (const where of [OPEN, undefined]) {
      const rows = await idsOf(where === undefined ? {} : { where }, context(ws));
      const chart = await run(
        {
          ...(where === undefined ? {} : { where }),
          groupBy: ['source.provider'],
          aggregate: { op: 'count' },
        },
        context(ws),
      );
      const counted = (chart.groups ?? []).reduce(
        (sum, group) => sum + (typeof group.value === 'number' ? group.value : 0),
        0,
      );
      assert.equal(counted, rows.length);
      assert.equal(chart.total, rows.length);
    }
    // Open: the done to-do's open copy, the other to-do (its copy hidden), the plain issue.
    assert.deepEqual(await idsOf({ where: OPEN }, context(ws)), [copy, other.id, plain].sort());
    const open = await run(
      { where: OPEN, groupBy: ['source.provider'], aggregate: { op: 'count' } },
      context(ws),
    );
    assert.deepEqual(
      Object.fromEntries(
        (open.groups ?? []).map((group) => [group.key['source.provider'], group.value]),
      ),
      { linear: 2, local: 1 },
    );
    assert.ok(todo);
  });
});
