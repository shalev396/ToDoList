/**
 * clock-timed-kinds, against a throwaway MongoDB: a clock whose filter is exactly an old default
 * (`kind = event`, or with `topic = $page.topic`) gets the timed kinds, in the draft and the
 * published copy; history ends at a changed draft; a clock chosen otherwise, any other block, a
 * deleted dashboard and every item are left alone; a second run changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: Migration;

const NOW = new Date('2026-11-18T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migrations_clock_timed_kinds');
  ({ clockTimedKinds: migration } = await import('./clockTimedKinds.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

type Doc = Record<string, unknown>;

const EVENT = { field: 'kind', operator: '=', value: 'event' };
const PAGE_TOPIC = { field: 'topic', operator: '=', value: '$page.topic' };
const TIMED = { field: 'kind', operator: 'in', value: ['event', 'block', 'travel'] };
const OLD = { combinator: 'and', rules: [EVENT] };
const OLD_TOPIC = { combinator: 'and', rules: [EVENT, PAGE_TOPIC] };

/** A block of `type` whose query filters by `where`. */
function block(id: string, type: string, where: unknown): Doc {
  return {
    id,
    type,
    title: id,
    query: { source: 'items', where, dateRange: 'today', dateField: 'startAt' },
    viz: type === 'clock' ? { kind: 'clock24', needle: 'now', showNext: true } : { kind: 'list' },
  };
}

function dashboard(id: string, blocks: Doc[], fields: Doc = {}): Doc {
  return {
    _id: id,
    workspaceId: 'w-1',
    ownerUserId: 'u-1',
    scope: { topicId: null, containerId: null, page: 'topic', groupVar: null },
    title: id,
    templateKey: null,
    visibility: 'workspace',
    vars: {},
    layouts: { lg: [], md: [], sm: [] },
    blocks,
    importance: null,
    views: [],
    version: 7,
    publishedVersion: null,
    published: null,
    updatedBy: { userId: 'u-2', agentId: null },
    deletedAt: null,
    ...fields,
  };
}

const snapshotOf = (doc: Doc): Doc => ({
  title: doc['title'],
  vars: doc['vars'],
  layouts: doc['layouts'],
  blocks: doc['blocks'],
});

async function find(id: string): Promise<Doc> {
  const doc = await raw.collection<Doc>('Dashboards').findOne({ _id: id as never });
  assert.ok(doc, id);
  return doc;
}

const whereOf = (doc: Doc, index: number, copy: 'draft' | 'published' = 'draft'): unknown => {
  const blocks = (copy === 'draft' ? doc['blocks'] : (doc['published'] as Doc)['blocks']) as Doc[];
  return (blocks[index]?.['query'] as Doc)['where'];
};

describe('clock-timed-kinds', () => {
  it('answers zero on a database without dashboards', async () => {
    assert.deepEqual(await migration.run(raw, NOW), { dashboards: 0, clocks: 0 });
  });

  it('rewrites exactly the old defaults, in the draft and the published copy', async () => {
    const main = dashboard('d-main', [
      block('clock', 'clock', OLD),
      // Not a clock: a list of events stays a list of events.
      block('events', 'list', OLD),
    ]);
    main['published'] = snapshotOf(main);
    main['publishedVersion'] = 7;
    const custom = dashboard('d-custom', [
      // Each differs from the old default in some way: chosen by someone, kept.
      block('more', 'clock', {
        combinator: 'and',
        rules: [EVENT, { field: 'status', operator: '=', value: 'open' }],
      }),
      block('or', 'clock', { combinator: 'or', rules: [EVENT] }),
      block('not', 'clock', { combinator: 'and', not: true, rules: [EVENT] }),
      block('order', 'clock', { combinator: 'and', rules: [PAGE_TOPIC, EVENT] }),
      block('todo', 'clock', { combinator: 'and', rules: [{ ...EVENT, value: 'todo' }] }),
      block('new', 'clock', { combinator: 'and', rules: [TIMED] }),
      { id: 'bare', type: 'clock', title: 'bare', query: { source: 'items' } },
    ]);
    // Its draft was changed by hand since it was published: only the published copy is old.
    const publishedOnly = dashboard('d-published', [
      block('clock', 'clock', { combinator: 'and', rules: [TIMED] }),
    ]);
    publishedOnly['published'] = snapshotOf(dashboard('x', [block('clock', 'clock', OLD)]));
    await raw.collection<Doc>('Dashboards').insertMany([
      main,
      dashboard('d-topic', [block('clock', 'clock', OLD_TOPIC)], {
        scope: { topicId: 't-1', containerId: null, page: 'topic', groupVar: null },
        views: [{ id: 'v-1', title: 'Week', blockIds: ['clock'] }],
      }),
      custom,
      publishedOnly,
      dashboard('d-deleted', [block('clock', 'clock', OLD)], { deletedAt: NOW }),
    ]);
    await raw.collection<Doc>('DashboardVersions').insertMany(
      [5, 6, 7].map((version) => ({
        _id: `d-main:v${String(version)}` as never,
        workspaceId: 'w-1',
        dashboardId: 'd-main',
        version,
        patch: [{ op: 'replace', path: '/title', value: 'd-main' }],
        inverse: [{ op: 'replace', path: '/title', value: 'old' }],
        snapshot: null,
        actorUserId: 'u-1',
        actorAgentId: null,
        summary: null,
        at: NOW,
      })),
    );
    await raw.collection<Doc>('DashboardVersions').insertOne({
      _id: 'd-published:v7' as never,
      workspaceId: 'w-1',
      dashboardId: 'd-published',
      version: 7,
      patch: [],
      inverse: [],
      snapshot: null,
      actorUserId: 'u-1',
      actorAgentId: null,
      summary: null,
      at: NOW,
    });
    const item = { _id: 'i-1', workspaceId: 'w-1', kind: 'event', title: 'Lecture', props: {} };
    await raw.collection<Doc>('Items').insertOne(item as Doc);

    assert.deepEqual(await migration.run(raw, NOW), { dashboards: 3, clocks: 4 });

    const migratedMain = await find('d-main');
    assert.deepEqual(whereOf(migratedMain, 0), { combinator: 'and', rules: [TIMED] });
    assert.deepEqual(whereOf(migratedMain, 0, 'published'), { combinator: 'and', rules: [TIMED] });
    assert.deepEqual(whereOf(migratedMain, 1), OLD);
    assert.deepEqual(whereOf(migratedMain, 1, 'published'), OLD);
    // The rest of the clock is as it was.
    const [clock] = migratedMain['blocks'] as Doc[];
    assert.ok(clock);
    assert.deepEqual(clock['viz'], { kind: 'clock24', needle: 'now', showNext: true });
    assert.equal((clock['query'] as Doc)['dateRange'], 'today');
    assert.equal(migratedMain['version'], 7);
    assert.equal(migratedMain['publishedVersion'], 7);

    const topic = await find('d-topic');
    assert.deepEqual(whereOf(topic, 0), { combinator: 'and', rules: [TIMED, PAGE_TOPIC] });
    assert.equal(topic['published'], null);

    const kept = await find('d-custom');
    assert.deepEqual(kept['blocks'], custom['blocks']);

    const published = await find('d-published');
    assert.deepEqual(whereOf(published, 0), { combinator: 'and', rules: [TIMED] });
    assert.deepEqual(whereOf(published, 0, 'published'), { combinator: 'and', rules: [TIMED] });

    assert.deepEqual(whereOf(await find('d-deleted'), 0), OLD);

    // History ends at a changed draft: one snapshot of it, so undo never brings the old filter
    // back. A dashboard whose draft didn't change keeps its history.
    const history = await raw
      .collection<Doc>('DashboardVersions')
      .find({ dashboardId: 'd-main' })
      .toArray();
    assert.equal(history.length, 1);
    const [reset] = history;
    assert.ok(reset);
    assert.equal(reset['summary'], 'history-reset');
    assert.equal(reset['version'], 7);
    assert.equal(reset['actorUserId'], 'u-2');
    assert.deepEqual((reset['snapshot'] as Doc)['blocks'], migratedMain['blocks']);
    const topicHistory = await raw
      .collection<Doc>('DashboardVersions')
      .find({ dashboardId: 'd-topic' })
      .toArray();
    assert.deepEqual((topicHistory[0]?.['snapshot'] as Doc)['views'], [
      { id: 'v-1', title: 'Week', blockIds: ['clock'] },
    ]);
    assert.equal(
      await raw.collection<Doc>('DashboardVersions').countDocuments({ dashboardId: 'd-published' }),
      1,
    );
    assert.equal(
      (await raw.collection<Doc>('DashboardVersions').findOne({ dashboardId: 'd-published' }))?._id,
      'd-published:v7',
    );

    // Items are never touched.
    assert.deepEqual(await raw.collection<Doc>('Items').findOne({ _id: 'i-1' as never }), item);
  });

  it('changes nothing the second time', async () => {
    const dashboards = await raw.collection<Doc>('Dashboards').find({}).sort({ _id: 1 }).toArray();
    const versions = await raw
      .collection<Doc>('DashboardVersions')
      .find({})
      .sort({ _id: 1 })
      .toArray();
    assert.deepEqual(await migration.run(raw, NOW), { dashboards: 0, clocks: 0 });
    assert.deepEqual(
      await raw.collection<Doc>('Dashboards').find({}).sort({ _id: 1 }).toArray(),
      dashboards,
    );
    assert.deepEqual(
      await raw.collection<Doc>('DashboardVersions').find({}).sort({ _id: 1 }).toArray(),
      versions,
    );
  });
});
