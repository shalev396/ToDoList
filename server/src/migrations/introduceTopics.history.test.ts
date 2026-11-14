/**
 * The topics migration and dashboard history (review H2): stored patches and inverses are RFC 6902
 * operations the migration cannot rewrite, so it ends the history there. The migrated state is a
 * fresh snapshot; undo, redo and revert stop at that boundary and never bring `area` back.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { contextFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import type { WorkspaceContext } from '../services/accessFilter.js';
import type * as Dashboards from '../services/dashboards.js';
import type * as TopicsService from '../services/topics.js';
import type * as Migration from './introduceTopics.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let svc: typeof Dashboards;
let topics: typeof TopicsService;
let migration: typeof Migration;
let ctx: WorkspaceContext;
let actor: { userId: string; agentId: null };
let workspaceId = '';

const NOW = new Date('2026-11-13T09:00:00Z');
const DASHBOARD_ID = 'd-history';
const COLLECTIONS = ['Topics', 'Dashboards', 'DashboardVersions', 'Workspaces'];

function block(field: string, value: unknown): Record<string, unknown> {
  return {
    id: 'blk_list',
    type: 'list',
    title: 'Open',
    query: {
      source: 'items',
      where: { combinator: 'and', rules: [{ field, operator: '=', value }] },
    },
    viz: { kind: 'list' },
  };
}

function state(area: string | null, field: string, value: unknown): Record<string, unknown> {
  return {
    title: 'History',
    scope: { area, containerId: null, page: 'topic', groupVar: null },
    vars: area === null ? {} : { area },
    layouts: { lg: [], md: [], sm: [] },
    blocks: [block(field, value)],
  };
}

function version(
  n: number,
  patch: unknown[],
  inverse: unknown[],
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    _id: `hv-${String(n)}`,
    workspaceId,
    dashboardId: DASHBOARD_ID,
    version: n,
    patch,
    inverse,
    snapshot,
    actorUserId: actor.userId,
    actorAgentId: null,
    summary: null,
    at: NOW,
  };
}

async function snapshotOfCollections(): Promise<unknown[]> {
  return Promise.all(
    COLLECTIONS.map((name) => raw.collection(name).find({}).sort({ _id: 1 }).toArray()),
  );
}

before(async () => {
  db = await startTestDatabase('todolist_migration_topics_history');
  svc = await import('../services/dashboards.js');
  topics = await import('../services/topics.js');
  migration = await import('./introduceTopics.js');
  const models = await import('../models/index.js');
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;

  const owner = await newUser('history-owner');
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'History', slug: 'history-ws', ownerId: owner.id });
  workspaceId = workspace.id;
  await (
    await models.getMembershipRepository()
  ).create(workspaceId, { userId: owner.id, role: 'owner' });
  ctx = await contextFor(workspaceId, owner.id);
  actor = { userId: owner.id, agentId: null };

  // Version 4 is the current one: scope, page variable and rule all on `area`.
  await raw.collection('Dashboards').insertOne({
    _id: DASHBOARD_ID as never,
    workspaceId,
    ownerUserId: owner.id,
    ...state('work', 'area', 'work'),
    templateKey: null,
    visibility: 'private',
    version: 4,
    publishedVersion: null,
    published: null,
    updatedBy: { userId: owner.id, agentId: null },
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await raw.collection('DashboardVersions').insertMany([
    version(1, [], [], state(null, 'status', 'open')),
    version(
      2,
      [{ op: 'replace', path: '/scope/area', value: 'work' }],
      [{ op: 'replace', path: '/scope/area', value: null }],
      null,
    ),
    version(
      3,
      [{ op: 'add', path: '/vars/area', value: 'work' }],
      [{ op: 'remove', path: '/vars/area' }],
      null,
    ),
    version(
      4,
      [
        { op: 'replace', path: '/blocks/0/query/where/rules/0/field', value: 'area' },
        { op: 'replace', path: '/blocks/0/query/where/rules/0/value', value: 'work' },
      ],
      [
        { op: 'replace', path: '/blocks/0/query/where/rules/0/field', value: 'status' },
        { op: 'replace', path: '/blocks/0/query/where/rules/0/value', value: 'open' },
      ],
      null,
    ),
  ]);
});

after(async () => {
  await db.stop();
});

describe('introduce topics (migration): dashboard history', () => {
  it('ends the history at the migration and keeps the current state', async () => {
    await migration.introduceTopics.run(raw, NOW);
    const workId = topics.defaultTopicId(workspaceId, 'work');

    const view = await svc.getDashboard(ctx, actor, DASHBOARD_ID, {});
    assert.equal(view.version, 4);
    assert.deepEqual(view.scope, {
      topicId: workId,
      containerId: null,
      page: 'topic',
      groupVar: null,
    });
    assert.deepEqual(view.vars, { topic: workId });
    assert.deepEqual(view.blocks, [block('topic', workId)]);

    const versions = await raw
      .collection('DashboardVersions')
      .find({ dashboardId: DASHBOARD_ID })
      .toArray();
    assert.equal(versions.length, 1);
    const [boundary] = versions;
    assert.ok(boundary);
    assert.equal(boundary['version'], 4);
    assert.deepEqual([boundary['patch'], boundary['inverse']], [[], []]);
    assert.doesNotMatch(JSON.stringify(boundary['snapshot']), /"area"/);
  });

  it('undo, redo and revert stop at the migration and never bring area back', async () => {
    await assert.rejects(
      svc.undoDashboard(ctx, actor, DASHBOARD_ID, { expectedVersion: 4 }),
      hasStatus(409),
    );
    await assert.rejects(
      svc.redoDashboard(ctx, actor, DASHBOARD_ID, { expectedVersion: 4 }),
      hasStatus(409),
    );
    for (const toVersion of [1, 2, 3]) {
      await assert.rejects(
        svc.revertDashboard(ctx, actor, DASHBOARD_ID, { expectedVersion: 4, toVersion }),
        hasStatus(404),
      );
    }

    // After the boundary, history works again, and stays on topics.
    const workId = topics.defaultTopicId(workspaceId, 'work');
    const reverted = await svc.revertDashboard(ctx, actor, DASHBOARD_ID, {
      expectedVersion: 4,
      toVersion: 4,
    });
    assert.equal(reverted.version, 5);
    await svc.undoDashboard(ctx, actor, DASHBOARD_ID, { expectedVersion: 5 });
    await svc.redoDashboard(ctx, actor, DASHBOARD_ID, { expectedVersion: 6 });

    const stored = await raw.collection('Dashboards').findOne({ _id: DASHBOARD_ID as never });
    assert.ok(stored);
    assert.doesNotMatch(JSON.stringify(stored), /"area"/);
    assert.deepEqual(stored['blocks'], [block('topic', workId)]);
    const history = await raw
      .collection('DashboardVersions')
      .find({ dashboardId: DASHBOARD_ID })
      .toArray();
    assert.doesNotMatch(JSON.stringify(history), /"area"/);
  });

  it('changes nothing the second time', async () => {
    const before = await snapshotOfCollections();
    const counts = await migration.introduceTopics.run(raw, NOW);
    assert.equal(counts['topics'], 0);
    assert.equal(counts['dashboards'], 0);
    assert.equal(counts['versions'], 0);
    assert.deepEqual(await snapshotOfCollections(), before);
  });
});
