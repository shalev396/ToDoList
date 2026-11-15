import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SourceRef } from '../models/definitions/common.js';
import type { ItemUpsert } from '../models/definitions/Item.js';
import type { SyncRunData } from '../models/definitions/SyncRun.js';
import { ContainerMongoModel } from '../models/mongoose/Container.js';
import { ItemMongoModel } from '../models/mongoose/Item.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';

const DAY = 24 * 60 * 60 * 1000;
/** A purge that found nothing a deleted workspace left of its dashboards. */
const NO_ORPHANS = { dashboards: 0, versions: 0, views: 0 };
const NOW = new Date('2026-11-12T03:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_purge_test');
});

after(async () => {
  await db.stop();
});

function source(externalId: string): SourceRef {
  return {
    provider: 'jira',
    accountId: 'site.example.invalid',
    externalId,
    key: null,
    url: `https://site.example.invalid/browse/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: `sha1:${externalId}`,
  };
}

/** Seeds items and a container per age (null = live) in a workspace; returns the local item's id. */
async function seed(workspaceId: string, ages: Record<string, number | null>): Promise<string> {
  const { getContainerRepository, getItemRepository } = await import('../models/index.js');
  const items = await getItemRepository();
  const containers = await getContainerRepository();
  await items.bulkUpsert(
    workspaceId,
    Object.keys(ages).map((externalId) => ({
      integrationId: 'i-jira',
      kind: 'issue' as const,
      topicId: 'work' as const,
      title: externalId,
      status: 'open' as const,
      source: source(externalId),
    })),
  );
  await containers.bulkUpsert(
    workspaceId,
    Object.keys(ages).map((externalId) => ({
      integrationId: 'i-jira',
      topicId: 'work' as const,
      type: 'project' as const,
      name: externalId,
      source: source(externalId),
    })),
  );
  for (const [externalId, age] of Object.entries(ages)) {
    const filter = { workspaceId, 'source.externalId': externalId };
    const update = { $set: { deletedAt: age === null ? null : daysAgo(age) } };
    await ItemMongoModel.updateOne(filter, update);
    await ContainerMongoModel.updateOne(filter, update);
  }
  // A local to-do its owner deleted 40 days ago goes too.
  const local = await items.createLocal(workspaceId, {
    ownerUserId: 'u-owner',
    title: 'Old to-do',
    topicId: 'personal',
  });
  await ItemMongoModel.updateOne({ _id: local.id }, { $set: { deletedAt: daysAgo(40) } });
  return local.id;
}

async function remaining(model: 'Items' | 'Containers', workspaceId: string): Promise<string[]> {
  const docs = await ItemMongoModel.db
    .collection(model)
    .find({ workspaceId, 'source.provider': 'jira' }, { projection: { 'source.externalId': 1 } })
    .toArray();
  return docs.map((doc) => (doc['source'] as SourceRef).externalId).sort();
}

describe('purgeDeleted', () => {
  it('hard-deletes only rows soft-deleted more than 30 days ago, in every workspace', async () => {
    const ages = {
      live: null,
      'deleted-29d': 29,
      'deleted-30d': 30,
      'deleted-31d': 31,
      'deleted-90d': 90,
    };
    const localA = await seed('w-purge-a', ages);
    await seed('w-purge-b', ages);

    const { purgeDeleted } = await import('./purge.js');
    const result = await purgeDeleted(NOW);

    assert.deepEqual(result, {
      before: daysAgo(30),
      items: 6,
      containers: 4,
      timedOutRuns: 0,
      orphanedDashboards: NO_ORPHANS,
    });
    for (const workspaceId of ['w-purge-a', 'w-purge-b']) {
      const kept = ['deleted-29d', 'deleted-30d', 'live'];
      assert.deepEqual(await remaining('Items', workspaceId), kept, workspaceId);
      assert.deepEqual(await remaining('Containers', workspaceId), kept, workspaceId);
    }
    assert.equal(await ItemMongoModel.countDocuments({ _id: localA }), 0, 'the local to-do');

    assert.deepEqual(await purgeDeleted(NOW), {
      before: daysAgo(30),
      items: 0,
      containers: 0,
      timedOutRuns: 0,
      orphanedDashboards: NO_ORPHANS,
    });
  });
});

describe('purgeDeleted: what deleted workspaces left of their dashboards', () => {
  it('removes a dashboard written after its workspace was deleted, and nothing of a live one', async () => {
    const m = await import('../models/index.js');
    const workspaces = await m.getWorkspaceRepository();
    const dashboards = await m.getDashboardRepository();
    const versions = await m.getDashboardVersionRepository();
    const views = await m.getViewRepository();
    const gone = await workspaces.create({ name: 'Gone', slug: 'purge-gone', ownerId: 'u-owner' });
    const live = await workspaces.create({ name: 'Live', slug: 'purge-live', ownerId: 'u-owner' });
    await workspaces.softDelete(gone.id);
    // A request that passed requireWorkspace before the deletion lands after its cascade ran.
    for (const workspaceId of [gone.id, live.id]) {
      const page = await dashboards.create(workspaceId, { ownerUserId: 'u-owner', title: 'Late' });
      await versions.append(workspaceId, {
        dashboardId: page.id,
        version: 1,
        patch: [],
        inverse: [],
        actorUserId: 'u-owner',
      });
      await views.create(workspaceId, {
        ownerUserId: 'u-owner',
        title: 'Late view',
        query: { source: 'items' },
        viz: { kind: 'list' },
      });
    }
    // A version whose dashboard is gone, in a workspace that no longer exists at all.
    await versions.append('w-never-existed', {
      dashboardId: 'd-gone',
      version: 1,
      patch: [],
      inverse: [],
      actorUserId: 'u-owner',
    });

    const { purgeDeleted } = await import('./purge.js');
    assert.deepEqual((await purgeDeleted(NOW)).orphanedDashboards, {
      dashboards: 1,
      versions: 2,
      views: 1,
    });
    assert.deepEqual(await dashboards.list(gone.id, {}), []);
    assert.deepEqual(await views.list(gone.id), []);
    assert.equal((await dashboards.list(live.id, {})).length, 1);
    assert.equal((await views.list(live.id)).length, 1);
    assert.equal(
      (await versions.list(live.id, (await dashboards.list(live.id, {}))[0]?.id ?? '', 5)).length,
      1,
    );
    assert.deepEqual((await purgeDeleted(NOW)).orphanedDashboards, NO_ORPHANS);
  });
});

describe('purgeDeleted: runs still running', () => {
  const MINUTE = 60 * 1000;
  const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE);

  it('ends runs running for more than 15 minutes as failed with timeout', async () => {
    const m = await import('../models/index.js');
    const runs = await m.getSyncRunRepository();
    const integrations = await m.getIntegrationRepository();
    const items = await m.getItemRepository();
    const connect = async (workspaceId: string): Promise<string> =>
      (
        await integrations.create(workspaceId, {
          connectedBy: 'u-owner',
          provider: 'jira',
          accountId: `${workspaceId}.example.invalid`,
          label: 'Jira',
          authMethod: 'api_token_basic',
          topicId: 'work',
        })
      ).id;
    const live = await connect('w-stale-live');
    const gone = await connect('w-stale-gone');
    const started = (
      workspaceId: string,
      integrationId: string,
      minutes: number,
      status: 'running' | 'queued',
    ): Promise<SyncRunData> =>
      runs.create(workspaceId, {
        integrationId,
        trigger: 'schedule',
        status,
        startedAt: minutesAgo(minutes),
      });
    const stale = await started('w-stale-live', live, 16, 'running');
    const fresh = await started('w-stale-live', live, 14, 'running');
    const waiting = await started('w-stale-live', live, 60, 'queued');
    const dead = await started('w-stale-gone', gone, 40, 'running');

    // The gone integration's run had revived a row after the disconnect deleted them.
    const issue = (integrationId: string, workspaceId: string): ItemUpsert => ({
      integrationId,
      kind: 'issue' as const,
      topicId: 'work' as const,
      title: 'Revived',
      status: 'open' as const,
      source: { ...source('revived-1'), accountId: `${workspaceId}.example.invalid` },
    });
    await items.bulkUpsert('w-stale-gone', [issue(gone, 'w-stale-gone')]);
    await items.bulkUpsert('w-stale-live', [issue(live, 'w-stale-live')]);
    await integrations.softDelete('w-stale-gone', gone);

    const { purgeDeleted } = await import('./purge.js');
    const result = await purgeDeleted(NOW);
    assert.equal(result.timedOutRuns, 2);

    const timeout = { code: 'timeout', message: 'The sync did not finish in time' };
    for (const [workspaceId, run] of [
      ['w-stale-live', stale],
      ['w-stale-gone', dead],
    ] as const) {
      const ended = await runs.findById(workspaceId, run.id);
      assert.deepEqual([ended?.status, ended?.error, ended?.finishedAt], ['failed', timeout, NOW]);
    }
    assert.equal((await runs.findById('w-stale-live', fresh.id))?.status, 'running');
    assert.equal((await runs.findById('w-stale-live', waiting.id))?.status, 'queued');

    const revived = async (workspaceId: string): Promise<Date | null | undefined> => {
      const doc = await ItemMongoModel.findOne({
        workspaceId,
        'source.externalId': 'revived-1',
      }).lean<{ deletedAt: Date | null }>();
      return doc?.deletedAt;
    };
    assert.deepEqual(await revived('w-stale-gone'), NOW, 'disconnected: deleted again');
    assert.equal(await revived('w-stale-live'), null, 'still connected: kept');

    assert.equal((await purgeDeleted(NOW)).timedOutRuns, 0, 'each run is ended once');
  });

  it('one run at a time: a re-delete that throws leaves every later run for the next purge', async (t) => {
    const m = await import('../models/index.js');
    const runs = await m.getSyncRunRepository();
    const integrations = await m.getIntegrationRepository();
    const items = await m.getItemRepository();
    const goneWith = async (workspaceId: string, minutes: number): Promise<SyncRunData> => {
      const accountId = `${workspaceId}.example.invalid`;
      const { id } = await integrations.create(workspaceId, {
        connectedBy: 'u-owner',
        provider: 'jira',
        accountId,
        label: 'Jira',
        authMethod: 'api_token_basic',
        topicId: 'work',
      });
      const run = await runs.create(workspaceId, {
        integrationId: id,
        trigger: 'schedule',
        status: 'running',
        startedAt: minutesAgo(minutes),
      });
      await items.bulkUpsert(workspaceId, [
        {
          integrationId: id,
          kind: 'issue',
          topicId: 'work',
          title: 'Revived',
          status: 'open',
          source: { ...source('revived-2'), accountId },
        },
      ]);
      await integrations.softDelete(workspaceId, id);
      return run;
    };
    const first = await goneWith('w-stale-first', 50);
    const second = await goneWith('w-stale-second', 30);
    const revived = async (workspaceId: string): Promise<Date | null | undefined> =>
      (
        await ItemMongoModel.findOne({ workspaceId, 'source.externalId': 'revived-2' }).lean<{
          deletedAt: Date | null;
        }>()
      )?.deletedAt;

    // The first run's re-delete fails (a database blip): the purge stops there.
    const updateMany = t.mock.method(ItemMongoModel, 'updateMany');
    updateMany.mock.mockImplementationOnce(() => {
      throw new Error('database blip');
    });
    const { purgeDeleted } = await import('./purge.js');
    await assert.rejects(purgeDeleted(NOW), /database blip/);
    assert.equal((await runs.findById('w-stale-first', first.id))?.status, 'failed');
    // The later run was not touched: still running, so the next purge reaps it and re-deletes.
    assert.equal((await runs.findById('w-stale-second', second.id))?.status, 'running');
    assert.equal(await revived('w-stale-second'), null);

    updateMany.mock.restore();
    assert.equal((await purgeDeleted(NOW)).timedOutRuns, 1);
    assert.equal((await runs.findById('w-stale-second', second.id))?.status, 'failed');
    assert.deepEqual(await revived('w-stale-second'), NOW, 'deleted again by the next purge');
  });
});
