/**
 * The purge's sweep and the orphan migration decide "this workspace is gone" from reads, and then
 * delete. Every such read goes to the PRIMARY (a lagging secondary could hide a new workspace),
 * asks for the ids it needs and nothing more, and a failed read deletes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_primary_reads_test');
});

after(async () => {
  await db.stop();
});

interface Seen {
  model: string;
  mode: string | undefined;
  projection: unknown;
  distinct: string | undefined;
}

/** Runs `body` with every mongoose query recorded; `failOn` makes that model's queries throw. */
async function spied(
  body: () => Promise<void>,
  failOn?: string,
): Promise<{ seen: Seen[]; error: unknown }> {
  const proto = mongoose.Query.prototype as unknown as {
    exec: (this: mongoose.Query<unknown, unknown>) => Promise<unknown>;
  };
  const original = proto.exec;
  const seen: Seen[] = [];
  proto.exec = function (this: mongoose.Query<unknown, unknown>): Promise<unknown> {
    const options = this.getOptions() as { readPreference?: { mode?: string } | string };
    const preference = options.readPreference;
    seen.push({
      model: this.model.modelName,
      mode: typeof preference === 'string' ? preference : preference?.mode,
      projection: this.projection(),
      distinct: (this as unknown as { _distinct?: string })._distinct,
    });
    if (this.model.modelName === failOn) return Promise.reject(new Error('read failed'));
    return original.call(this);
  };
  let error: unknown;
  try {
    await body();
  } catch (caught) {
    error = caught;
  } finally {
    proto.exec = original;
  }
  return { seen, error };
}

describe('the sweep reads the primary, ids only', () => {
  it('liveAmong: Workspaces, from the primary, projecting _id only', async () => {
    const { Workspace } = await import('../../classes/workspace/Workspace.js');
    const { seen, error } = await spied(async () => {
      await Workspace.liveAmong(['w-1']);
    });
    assert.equal(error, undefined);
    const reads = seen.filter((read) => read.model === 'Workspace');
    assert.deepEqual(
      reads.map(({ mode, projection }) => ({ mode, projection })),
      [{ mode: 'primary', projection: { _id: 1 } }],
    );
  });

  it('removeOrphans: every id list is read from the primary, and so is the Workspaces lookup', async () => {
    const { Dashboard } = await import('../../classes/dashboard/Dashboard.js');
    await mongoose.connection.collection('Dashboards').insertOne({
      _id: 'dash-orphan' as never,
      workspaceId: 'w-gone',
      deletedAt: null,
    });
    const { seen } = await spied(async () => {
      await Dashboard.removeOrphans();
    });
    const distincts = seen.filter((read) => read.distinct === 'workspaceId');
    assert.deepEqual(distincts.map((read) => read.model).sort(), [
      'Dashboard',
      'DashboardVersion',
      'View',
    ]);
    for (const read of distincts) assert.equal(read.mode, 'primary', read.model);
    const lookup = seen.filter((read) => read.model === 'Workspace');
    assert.deepEqual(
      lookup.map(({ mode, projection }) => ({ mode, projection })),
      [{ mode: 'primary', projection: { _id: 1 } }],
    );
  });

  it('a failed workspace lookup rejects the sweep and deletes nothing', async () => {
    const { Dashboard } = await import('../../classes/dashboard/Dashboard.js');
    const dashboards = mongoose.connection.collection('Dashboards');
    await dashboards.insertOne({
      _id: 'dash-kept' as never,
      workspaceId: 'w-unknown',
      deletedAt: null,
    });
    const { error } = await spied(async () => {
      await Dashboard.removeOrphans();
    }, 'Workspace');
    assert.ok(error instanceof Error && error.message === 'read failed');
    assert.equal(await dashboards.countDocuments({ _id: 'dash-kept' as never }), 1);
  });
});

describe('the orphan migration reads the primary, ids only', () => {
  it('every distinct and the Workspaces lookup name the primary; the lookup projects _id', async () => {
    const { orphanedDashboards } = await import('../../migrations/orphanedDashboards.js');
    const raw = mongoose.connection.db;
    assert.ok(raw);
    await raw.collection('Dashboards').insertOne({ _id: 'dash-m' as never, workspaceId: 'w-m' });
    const calls: { collection: string; op: string; options: unknown }[] = [];
    const watching = new Proxy(raw, {
      get(target, property, receiver): unknown {
        if (property !== 'collection') return Reflect.get(target, property, receiver) as unknown;
        return (name: string): unknown => {
          const collection = target.collection(name);
          return new Proxy(collection, {
            get(inner, method): unknown {
              const value = Reflect.get(inner, method, inner) as unknown;
              if (method !== 'distinct' && method !== 'find') return value;
              return (...args: unknown[]): unknown => {
                const options = method === 'distinct' ? args[2] : args[1];
                calls.push({ collection: name, op: method, options });
                return (value as (...a: unknown[]) => unknown).apply(inner, args);
              };
            },
          });
        };
      },
    });
    await orphanedDashboards.run(watching, new Date());
    const distincts = calls.filter((call) => call.op === 'distinct');
    assert.equal(distincts.length, 3);
    for (const call of distincts) assert.deepEqual(call.options, { readPreference: 'primary' });
    const lookups = calls.filter((call) => call.collection === 'Workspaces');
    assert.deepEqual(
      lookups.map((call) => call.options),
      [{ projection: { _id: 1 }, readPreference: 'primary' }],
    );
  });
});
