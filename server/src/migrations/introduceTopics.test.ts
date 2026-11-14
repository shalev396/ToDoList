/**
 * The topics migration (H2; PERMISSIONS-V2 "Dynamic topics"): every workspace gets the three
 * default topics with their stable ids; items, containers, integrations, topic rules, dashboards
 * (pages, published copies, history) and saved views move from `area` to topic ids; and a second
 * run changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as TopicsService from '../services/topics.js';
import type * as Migration from './introduceTopics.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let migration: typeof Migration;
let topics: typeof TopicsService;

const NOW = new Date('2026-11-13T09:00:00Z');

before(async () => {
  db = await startTestDatabase('todolist_migration_topics');
  migration = await import('./introduceTopics.js');
  topics = await import('../services/topics.js');
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

/** A rule as dashboards stored it before topics. */
function rule(field: string, operator: string, value?: unknown): Record<string, unknown> {
  return value === undefined ? { field, operator } : { field, operator, value };
}

async function seedOldShape(): Promise<void> {
  await raw.collection('Workspaces').insertMany([
    {
      _id: 'w-he' as never,
      name: 'Hebrew',
      slug: 'hebrew',
      ownerId: 'u-1',
      settings: {
        timezone: 'Asia/Jerusalem',
        weekStart: 'sun',
        areas: ['college', 'personal'],
        areaRules: [
          { match: 'shalev396/*', area: 'personal' },
          { match: 'Braude*', area: 'college' },
        ],
      },
    },
    {
      _id: 'w-en' as never,
      name: 'English',
      slug: 'english',
      ownerId: 'u-2',
      settings: { timezone: 'Asia/Jerusalem', weekStart: 'sun' },
    },
  ]);
  // w-en already has a Work topic, made by the new code before the migration ran.
  await raw.collection('Topics').insertOne({
    _id: 'topic-made-early' as never,
    workspaceId: 'w-en',
    name: 'Work',
    slug: 'work',
    icon: null,
    colour: null,
    order: 0,
    createdBy: 'u-2',
  });
  await raw.collection('Items').insertMany([
    {
      _id: 'i-1' as never,
      workspaceId: 'w-he',
      kind: 'todo',
      area: 'college',
      title: 'Read',
      status: 'open',
      overlay: { areaOverride: 'personal', pinned: true },
    },
    {
      _id: 'i-2' as never,
      workspaceId: 'w-he',
      kind: 'todo',
      area: 'work',
      title: 'Ship',
      status: 'open',
    },
    {
      _id: 'i-3' as never,
      workspaceId: 'w-en',
      kind: 'todo',
      area: 'work',
      title: 'Plan',
      status: 'open',
    },
  ]);
  await raw.collection('Containers').insertOne({
    _id: 'c-1' as never,
    workspaceId: 'w-he',
    integrationId: 'int-1',
    area: 'college',
    type: 'course',
    name: 'Algorithms',
  });
  await raw.collection('Integrations').insertOne({
    _id: 'int-1' as never,
    workspaceId: 'w-he',
    provider: 'moodle',
    area: 'college',
    label: 'Moodle',
  });
  await raw.collection('Dashboards').insertMany([
    {
      _id: 'd-main' as never,
      workspaceId: 'w-he',
      title: 'לוח',
      scope: { area: null, containerId: null, page: 'topic', groupVar: null },
      vars: { range: 'this_week', area: null },
      blocks: [
        {
          id: 'blk_area',
          type: 'filter',
          title: 'תחום',
          viz: { kind: 'chips', field: 'area' },
          sets: '$page.area',
        },
        {
          id: 'blk_list',
          type: 'list',
          title: 'Open',
          query: {
            source: 'items',
            where: { combinator: 'and', rules: [rule('area', '=', '$page.area')] },
            groupBy: ['area'],
            sort: [{ field: 'area', dir: 'asc' }],
          },
          viz: { kind: 'table', columns: ['title', 'area'] },
          listen: ['$page.area'],
        },
      ],
      layouts: { lg: [], md: [], sm: [] },
      published: {
        title: 'לוח',
        vars: { area: 'college' },
        layouts: { lg: [], md: [], sm: [] },
        blocks: [
          {
            id: 'blk_list',
            type: 'list',
            query: {
              source: 'items',
              where: { combinator: 'and', rules: [rule('area', 'in', ['work', 'college'])] },
            },
          },
        ],
      },
      deletedAt: null,
    },
    {
      _id: 'd-college' as never,
      workspaceId: 'w-he',
      title: 'לימודים',
      scope: { area: 'college', containerId: null, page: 'topic', groupVar: null },
      vars: {},
      blocks: [
        {
          id: 'blk_due',
          type: 'list',
          query: {
            source: 'items',
            where: {
              combinator: 'and',
              rules: [rule('area', '=', 'college'), rule('dueAt', 'notNull')],
            },
          },
        },
      ],
      layouts: { lg: [], md: [], sm: [] },
      published: null,
      deletedAt: null,
    },
  ]);
  await raw.collection('DashboardVersions').insertOne({
    _id: 'v-1' as never,
    workspaceId: 'w-he',
    dashboardId: 'd-college',
    version: 1,
    patch: [],
    inverse: [],
    snapshot: {
      title: 'לימודים',
      scope: { area: 'college', containerId: null, page: 'topic', groupVar: null },
      vars: {},
      layouts: { lg: [], md: [], sm: [] },
      blocks: [
        {
          id: 'blk_due',
          type: 'list',
          query: {
            source: 'items',
            where: { combinator: 'and', rules: [rule('area', '=', 'college')] },
          },
        },
      ],
    },
  });
  await raw.collection('Views').insertOne({
    _id: 'view-1' as never,
    workspaceId: 'w-he',
    title: 'Work and college',
    query: {
      source: 'items',
      where: { combinator: 'or', rules: [rule('area', 'in', ['work', 'college'])] },
    },
    viz: { kind: 'list' },
  });
}

describe('introduce topics (migration)', () => {
  it('gives every workspace the three defaults and moves its data to topic ids', async () => {
    await seedOldShape();
    const counts = await migration.introduceTopics.run(raw, NOW);
    assert.equal(counts['workspaces'], 2);
    assert.equal(counts['topics'], 5);

    const he = await raw
      .collection('Topics')
      .find({ workspaceId: 'w-he' })
      .sort({ order: 1 })
      .toArray();
    const id = (slug: 'work' | 'college' | 'personal'): string =>
      topics.defaultTopicId('w-he', slug);
    // The workspace's own areas first, in their order, then the rest; Hebrew titles mean Hebrew names.
    assert.deepEqual(
      he.map((topic): unknown[] => [topic._id, topic['slug'], topic['name'], topic['order']]),
      [
        [id('college'), 'college', 'לימודים', 0],
        [id('personal'), 'personal', 'אישי', 1],
        [id('work'), 'work', 'עבודה', 2],
      ],
    );
    const en = await raw
      .collection('Topics')
      .find({ workspaceId: 'w-en' })
      .sort({ order: 1 })
      .toArray();
    assert.deepEqual(
      en.map((topic): unknown[] => [topic._id, topic['slug'], topic['name']]),
      [
        ['topic-made-early', 'work', 'Work'],
        [topics.defaultTopicId('w-en', 'college'), 'college', 'College'],
        [topics.defaultTopicId('w-en', 'personal'), 'personal', 'Personal'],
      ],
    );

    const items = await raw.collection('Items').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(
      items.map((item): unknown[] => [item._id, item['topicId'], 'area' in item]),
      [
        ['i-1', id('college'), false],
        ['i-2', id('work'), false],
        ['i-3', 'topic-made-early', false],
      ],
    );
    assert.deepEqual(items[0]?.['overlay'], { pinned: true, topicOverride: id('personal') });
    const container = await raw.collection('Containers').findOne({ _id: 'c-1' as never });
    assert.deepEqual([container?.['topicId'], 'area' in (container ?? {})], [id('college'), false]);
    const integration = await raw.collection('Integrations').findOne({ _id: 'int-1' as never });
    assert.deepEqual(
      [integration?.['topicId'], 'area' in (integration ?? {})],
      [id('college'), false],
    );

    const workspace = await raw.collection('Workspaces').findOne({ _id: 'w-he' as never });
    assert.deepEqual(workspace?.['settings'], {
      timezone: 'Asia/Jerusalem',
      weekStart: 'sun',
      topicRules: [
        { match: 'shalev396/*', topicId: id('personal') },
        { match: 'Braude*', topicId: id('college') },
      ],
    });
  });

  it('rewrites stored dashboard queries, published copies, history and saved views', async () => {
    const id = (slug: 'work' | 'college' | 'personal'): string =>
      topics.defaultTopicId('w-he', slug);
    const main = await raw.collection('Dashboards').findOne({ _id: 'd-main' as never });
    assert.ok(main);
    assert.deepEqual(main['scope'], {
      topicId: null,
      containerId: null,
      page: 'topic',
      groupVar: null,
    });
    assert.deepEqual(main['vars'], { range: 'this_week', topic: null });
    const [filter, list] = main['blocks'] as Record<string, unknown>[];
    assert.ok(filter && list);
    assert.deepEqual(filter['viz'], { kind: 'chips', field: 'topic' });
    assert.equal(filter['sets'], '$page.topic');
    assert.deepEqual(list['query'], {
      source: 'items',
      where: { combinator: 'and', rules: [rule('topic', '=', '$page.topic')] },
      groupBy: ['topic'],
      sort: [{ field: 'topic', dir: 'asc' }],
    });
    assert.deepEqual(list['viz'], { kind: 'table', columns: ['title', 'topic'] });
    assert.deepEqual(list['listen'], ['$page.topic']);
    const published = main['published'] as Record<string, unknown>;
    assert.deepEqual(published['vars'], { topic: id('college') });
    assert.deepEqual((published['blocks'] as Record<string, unknown>[])[0]?.['query'], {
      source: 'items',
      where: { combinator: 'and', rules: [rule('topic', 'in', [id('work'), id('college')])] },
    });

    const college = await raw.collection('Dashboards').findOne({ _id: 'd-college' as never });
    assert.ok(college);
    assert.deepEqual(college['scope'], {
      topicId: id('college'),
      containerId: null,
      page: 'topic',
      groupVar: null,
    });
    assert.deepEqual(
      ((college['blocks'] as Record<string, unknown>[])[0]?.['query'] as Record<string, unknown>)[
        'where'
      ],
      { combinator: 'and', rules: [rule('topic', '=', id('college')), rule('dueAt', 'notNull')] },
    );

    const version = await raw
      .collection('DashboardVersions')
      .findOne({ _id: 'd-college:history-reset' as never });
    assert.ok(version);
    // The old versions are gone: the migrated page is the one version left, with no patches.
    assert.deepEqual(
      [version['version'], version['patch'], version['inverse'], version['summary']],
      [1, [], [], 'history-reset'],
    );
    const snapshot = version['snapshot'] as Record<string, unknown>;
    assert.deepEqual(snapshot['scope'], {
      topicId: id('college'),
      containerId: null,
      page: 'topic',
      groupVar: null,
    });
    assert.match(
      JSON.stringify(snapshot['blocks']),
      new RegExp(`"field":"topic","operator":"=","value":"${id('college')}"`),
    );

    const view = await raw.collection('Views').findOne({ _id: 'view-1' as never });
    assert.deepEqual(view?.['query'], {
      source: 'items',
      where: { combinator: 'or', rules: [rule('topic', 'in', [id('work'), id('college')])] },
    });
  });

  it('changes nothing the second time', async () => {
    const before = await Promise.all(
      ['Topics', 'Items', 'Dashboards', 'DashboardVersions', 'Views', 'Workspaces'].map((name) =>
        raw.collection(name).find({}).sort({ _id: 1 }).toArray(),
      ),
    );
    const counts = await migration.introduceTopics.run(raw, NOW);
    assert.equal(counts['topics'], 0);
    assert.equal(counts['items'], 0);
    assert.equal(counts['dashboards'], 0);
    const after = await Promise.all(
      ['Topics', 'Items', 'Dashboards', 'DashboardVersions', 'Views', 'Workspaces'].map((name) =>
        raw.collection(name).find({}).sort({ _id: 1 }).toArray(),
      ),
    );
    assert.deepEqual(after, before);
  });

  it('runs after dropping member scoping, in the migrations list', async () => {
    const { MIGRATIONS } = await import('./index.js');
    // Later migrations follow (importance, permissions v2: permissionsV2.test.ts).
    assert.deepEqual(MIGRATIONS.map(({ id }) => id).slice(0, 3), [
      '2026-11-13-drop-area-scope',
      '2026-11-13-introduce-topics',
      '2026-11-14-add-importance-attribute',
    ]);
  });
});
