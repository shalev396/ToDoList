/**
 * H5 in a dashboard block (the compiled pipeline, run on a real mongod): a provider copy of a local
 * to-do is hidden only while its to-do shows in the same read; otherwise the copy is a row of its
 * own. The to-do shows when the viewer may see it and it matches the block's whole filter (its
 * connectors, date range, rules, variables and topic narrowing); sort, limit and pages do not
 * count. Counts, groups and rows agree. The access filter stays the first stage.
 *
 * A to-do in the result that does not show hides nothing: one the block's `hide` display rule
 * matches (the client hides it), and a cancelled one (time views drop it). A soft-deleted to-do is
 * in no read. The absorption runs before the dedup of two integrations of one account.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CreateLocalItemInput, ItemUpsert } from '../models/definitions/Item.js';
import type { IItemRepository } from '../models/index.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { DisplayRule, Query, QueryResult, RuleGroup } from '../types/builder.js';
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

describe('a to-do in the result that does not show', () => {
  const doneHidden: DisplayRule = {
    if: { field: 'status', operator: '=', value: 'done' },
    then: { hide: true },
  };

  it('a list block with "if status = done then hide": the done to-do hidden, its open copy shown', async () => {
    const { ws, todo, copy } = await pair({ status: 'done' });
    const list = (rules: DisplayRule[]): CompileContext =>
      context(ws, 'u-1', { blockType: 'list', displayRules: rules });
    // The rows still hold the to-do (the client hides it, as before); the copy is now a row too.
    const shown = await run({}, list([doneHidden]));
    assert.deepEqual((shown.rows ?? []).map((row) => row.id).sort(), [todo, copy].sort());
    assert.equal(shown.total, 2);
    // No hide rule, or one that only tones or badges: one row, the to-do.
    assert.deepEqual(await idsOf({}, list([])), [todo]);
    assert.deepEqual(await idsOf({}, list([{ if: doneHidden.if, then: { tone: 'muted' } }])), [
      todo,
    ]);
    // A hide rule the to-do does not match: it shows, so it still absorbs its copy.
    assert.deepEqual(
      await idsOf(
        {},
        list([{ if: { field: 'status', operator: '=', value: 'open' }, then: { hide: true } }]),
      ),
      [todo],
    );
  });

  it('a counter or a chart hides no row, so its hide rules count for nothing: one task, one count', async () => {
    const { ws } = await pair({ status: 'done' });
    const count = { aggregate: { op: 'count' as const } };
    const counter = await run(
      count,
      context(ws, 'u-1', { blockType: 'counter', displayRules: [doneHidden] }),
    );
    assert.equal(counter.total, 1);
    const chart = await run(
      { ...count, groupBy: ['source.provider'] },
      context(ws, 'u-1', { blockType: 'chart', displayRules: [doneHidden] }),
    );
    assert.deepEqual(
      (chart.groups ?? []).map((group) => [group.key['source.provider'], group.value]),
      [['local', 1]],
    );
    // The same rule on a list, which hides the done to-do: the copy is its own row there.
    const list = await run(
      {},
      context(ws, 'u-1', { blockType: 'list', displayRules: [doneHidden] }),
    );
    assert.equal(list.total, 2);
  });

  it('a malformed rule (stored past the schema) is skipped, never an error', async () => {
    const { ws, todo, copy } = await pair({ status: 'done' });
    const malformed = [
      { if: doneHidden.if, then: 'hide' },
      { then: { hide: true } },
      null,
      {
        if: { field: 'status', operator: 'no-such-operator', value: 'done' },
        then: { hide: true },
      },
    ] as unknown as DisplayRule[];
    assert.deepEqual(await idsOf({}, context(ws, 'u-1', { displayRules: malformed })), [todo]);
    assert.deepEqual(
      await idsOf({}, context(ws, 'u-1', { displayRules: [...malformed, doneHidden] })),
      [copy, todo].sort(),
    );
  });

  it('a hide rule reads $page variables and computed fields as the client does', async () => {
    const { ws, todo, copy } = await pair({ status: 'done' });
    const byVar: DisplayRule = {
      if: { field: 'status', operator: '=', value: '$page.hidden' },
      then: { hide: true },
    };
    // Unset: the rule does nothing (no warning reaches the result either).
    const unset = await run({}, context(ws, 'u-1', { displayRules: [byVar] }));
    assert.deepEqual(
      (unset.rows ?? []).map((row) => row.id),
      [todo],
    );
    assert.deepEqual(unset.warnings, []);
    assert.deepEqual(unset.appliedVars, {});
    const set = context(ws, 'u-1', { displayRules: [byVar], vars: { hidden: 'done' } });
    assert.deepEqual(await idsOf({}, set), [copy, todo].sort());
    // The built-in Importance reads 3 when unset: a rule on it matches the to-do.
    const importance: DisplayRule = {
      if: { field: 'attr.importance', operator: '=', value: 3 },
      then: { hide: true },
    };
    assert.deepEqual(
      await idsOf(
        { where: rule('kind', '!=', 'event') },
        context(ws, 'u-1', { displayRules: [importance] }),
      ),
      [copy, todo].sort(),
    );
    // A rule the compiler refuses hides nothing, and never breaks the block.
    const refused: DisplayRule = {
      if: { field: 'no.such.field', operator: '=', value: 'x' },
      then: { hide: true },
    };
    assert.deepEqual(await idsOf({}, context(ws, 'u-1', { displayRules: [refused] })), [todo]);
  });

  it('a cancelled to-do hides nothing: its open copy shows in a calendar and in a list', async () => {
    const due = new Date('2026-11-12T10:00:00Z');
    const { ws, todo, copy } = await pair({ status: 'cancelled', dueAt: due }, { dueAt: due });
    const week = { dateRange: 'this_week' as const };
    assert.deepEqual(
      await idsOf(week, context(ws, 'u-1', { blockType: 'calendar' })),
      [copy, todo].sort(),
    );
    assert.deepEqual(
      await idsOf({}, context(ws, 'u-1', { blockType: 'list' })),
      [copy, todo].sort(),
    );
  });

  it('a soft-deleted to-do whose copy is still marked: the copy shows', async () => {
    const { ws, todo, copy } = await pair();
    const mongoose = (await import('mongoose')).default;
    // As if its release never ran: the copy still names the to-do.
    await mongoose.connection
      .collection('Items')
      .updateOne({ _id: todo as never }, { $set: { deletedAt: new Date() } });
    assert.deepEqual(await idsOf({}, context(ws)), [copy]);
    assert.deepEqual(await idsOf({ where: OPEN }, context(ws)), [copy]);
  });

  it('runs before the dedup of two integrations of one account', async () => {
    const { ws, todo, copy } = await pair();
    // A second integration of the same Linear account mirrors the same issue, unmarked.
    const mirror = await mirrored(ws, `${ws}-mirror`, {
      integrationId: 'i-linear-2',
      title: 'Plan (Linear, second)',
      source: {
        provider: 'linear',
        accountId: 'acct',
        externalId: copy,
        key: copy.toUpperCase(),
        url: `https://linear.app/x/issue/${copy}`,
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    });
    const both: CompileContext = context(ws, 'u-1', {
      access: {
        userId: 'u-1',
        integrations: [
          { id: 'i-linear', provider: 'linear', accountId: 'acct', ownerUserId: 'u-1' },
          { id: 'i-linear-2', provider: 'linear', accountId: 'acct', ownerUserId: 'u-2' },
        ],
        local: 'visible',
      },
      connectors: ['i-linear', 'i-linear-2', 'local'],
      dedup: ['i-linear', 'i-linear-2'],
    });
    // The marked copy is dropped first; the dedup then keeps the second integration's record (as
    // the access filter's rule did). Absorbing after the dedup would have dropped both.
    assert.deepEqual(await idsOf({}, both), [mirror, todo].sort());
  });
});
