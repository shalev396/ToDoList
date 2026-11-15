/**
 * Custom attributes (H4): definitions CRUD with roles and the plan limit, the built-in Importance
 * (renamable, never deletable), values in the item overlay for mirrored and local items, and the
 * migration that gives every workspace the built-in.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { WorkspaceContext } from '../../services/accessFilter.js';
import type * as Classes from './index.js';
import type * as Items from '../../testing/itemCalls.js';
import type { AttributeDef, NewAttribute, AttributePatch } from '../../types/attributes.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type * as Models from '../../models/index.js';
import { PLAN_LIMITS } from '../../types/limits.js';

let db: TestDatabase;
let Workspace: typeof Classes.Workspace;
let AttributeDefinitions: typeof Classes.AttributeDefinitions;
let items: typeof Items;
let models: typeof Models;

const EDITOR = { userId: 'u-editor' };
let count = 0;

before(async () => {
  db = await startTestDatabase('todolist_attributes_test');
  ({ Workspace, AttributeDefinitions } = await import('./index.js'));
  items = await import('../../testing/itemCalls.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function workspace(role: WorkspaceContext['role'] = 'editor'): Promise<WorkspaceContext> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Attrs', slug: `attrs-${String(count)}`, ownerId: 'u-owner' });
  return { id: created.id, role, settings: created.settings };
}

async function createAttribute(ws: WorkspaceContext, input: NewAttribute): Promise<AttributeDef> {
  const caller = callerOf(ws, EDITOR.userId);
  return (await Workspace.load(caller)).createAttribute(caller, input);
}

async function updateAttribute(
  ws: WorkspaceContext,
  key: string,
  patch: AttributePatch,
): Promise<AttributeDef> {
  const caller = callerOf(ws, EDITOR.userId);
  return (await Workspace.load(caller)).updateAttribute(caller, key, patch);
}

async function deleteAttribute(ws: WorkspaceContext, key: string): Promise<{ items: number }> {
  const caller = callerOf(ws, EDITOR.userId);
  return (await Workspace.load(caller)).deleteAttribute(caller, key);
}

function listAttributes(ws: WorkspaceContext): AttributeDef[] {
  return AttributeDefinitions.of(ws.settings).toJSON();
}

/** The context as the next request would see it: settings read again. */
async function fresh(ws: WorkspaceContext): Promise<WorkspaceContext> {
  const stored = await (await models.getWorkspaceRepository()).findById(ws.id);
  assert.ok(stored);
  return { ...ws, settings: stored.settings };
}

async function mirroredItem(ws: WorkspaceContext, externalId = 'M-1'): Promise<string> {
  // PERMISSIONS-V2: the editor's own integration, so its items are theirs to see.
  const integrationId = `i-${ws.id}`;
  const { IntegrationMongoModel } = await import('../../models/mongoose/Integration.js');
  if ((await IntegrationMongoModel.countDocuments({ _id: integrationId })) === 0) {
    const { seedIntegration } = await import('../../testing/integrationFixtures.js');
    await seedIntegration(ws.id, {
      id: integrationId,
      ownerUserId: EDITOR.userId,
      provider: 'jira',
      accountId: 'a',
    });
  }
  const repo = await models.getItemRepository();
  await repo.bulkUpsert(ws.id, [
    {
      integrationId,
      kind: 'issue',
      topicId: null,
      title: 'Mirrored',
      status: 'open',
      source: {
        provider: 'jira',
        accountId: 'a',
        externalId,
        key: externalId,
        url: 'https://jira.example/1',
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    },
  ]);
  const [row] = await repo.aggregate(ws.id, [{ $match: { 'source.externalId': externalId } }]);
  return String(row?.['_id']);
}

describe('definitions', () => {
  it('every new workspace has the built-in Importance, a rating, first', async () => {
    const ws = await workspace();
    const [first] = listAttributes(ws);
    assert.deepEqual(first, {
      key: 'importance',
      name: 'Importance',
      type: 'rating',
      builtIn: true,
    });
  });

  it('an editor adds, changes and deletes a custom attribute', async () => {
    const ws = await workspace();
    const created = await createAttribute(ws, {
      key: 'effort',
      name: 'Effort',
      type: 'select',
      options: ['S', 'M', 'L', 'M'],
    });
    assert.deepEqual(created, {
      key: 'effort',
      name: 'Effort',
      type: 'select',
      options: ['S', 'M', 'L'],
      builtIn: false,
    });
    const updated = await updateAttribute(await fresh(ws), 'effort', {
      name: 'Size',
      options: ['S', 'L'],
    });
    assert.equal(updated.name, 'Size');
    assert.deepEqual(updated.options, ['S', 'L']);
    const keys = listAttributes(await fresh(ws)).map((def) => def.key);
    assert.deepEqual(keys, ['importance', 'effort']);
    await deleteAttribute(await fresh(ws), 'effort');
    assert.deepEqual(
      listAttributes(await fresh(ws)).map((def) => def.key),
      ['importance'],
    );
  });

  it('a viewer cannot define, change or delete (403)', async () => {
    const ws = await workspace('viewer');
    await assert.rejects(createAttribute(ws, { key: 'x', name: 'X', type: 'text' }), {
      statusCode: 403,
    });
    await assert.rejects(updateAttribute(ws, 'importance', { name: 'Y' }), {
      statusCode: 403,
    });
    await assert.rejects(deleteAttribute(ws, 'importance'), { statusCode: 403 });
  });

  it('the built-in is renamable and never deletable (409 attribute_builtin)', async () => {
    const ws = await workspace();
    const renamed = await updateAttribute(ws, 'importance', { name: 'Urgency' });
    assert.equal(renamed.name, 'Urgency');
    assert.equal(renamed.builtIn, true);
    await assert.rejects(deleteAttribute(await fresh(ws), 'importance'), {
      statusCode: 409,
      code: 'attribute_builtin',
    });
  });

  it('a taken key is 409 attribute_exists', async () => {
    const ws = await workspace();
    await assert.rejects(createAttribute(ws, { key: 'importance', name: 'Dup', type: 'text' }), {
      statusCode: 409,
      code: 'attribute_exists',
    });
  });

  it('the plan limit caps them (409 attribute_limit), the built-in counted', async () => {
    const ws = await workspace();
    for (let index = 1; index < PLAN_LIMITS.attributesPerWorkspace; index += 1) {
      await createAttribute(ws, {
        key: `a${String(index)}`,
        name: `A${String(index)}`,
        type: 'text',
      });
    }
    await assert.rejects(createAttribute(ws, { key: 'over', name: 'Over', type: 'text' }), {
      statusCode: 409,
      code: 'attribute_limit',
    });
  });

  it('a number range must have max above min, defaults included (create and patch)', async () => {
    const { NewAttributeSchema } = await import('../../types/attributes.js');
    const make = (extra: object): boolean =>
      NewAttributeSchema.safeParse({ key: 'n', name: 'N', type: 'number', ...extra }).success;
    assert.equal(make({}), true);
    assert.equal(make({ min: 0, max: 50 }), true);
    assert.equal(make({ min: 100 }), false, 'min alone is 100 to the default 100');
    assert.equal(make({ max: 0 }), false, 'max alone is the default 0 to 0');
    assert.equal(make({ max: -5 }), false);
    assert.equal(make({ min: 5, max: 5 }), false);

    const ws = await workspace();
    await createAttribute(ws, { key: 'cost', name: 'Cost', type: 'number' });
    const ready = await fresh(ws);
    await assert.rejects(updateAttribute(ready, 'cost', { min: 100 }), {
      statusCode: 400,
    });
    await assert.rejects(updateAttribute(ready, 'cost', { max: 0 }), {
      statusCode: 400,
    });
    const ok = await updateAttribute(ready, 'cost', { min: 10, max: 500 });
    assert.deepEqual([ok.min, ok.max], [10, 500]);
    await assert.rejects(updateAttribute(await fresh(ws), 'cost', { max: 10 }), {
      statusCode: 400,
    });
  });

  it('refuses a missing or unknown attribute (404)', async () => {
    const ws = await workspace();
    await assert.rejects(updateAttribute(ws, 'nope', { name: 'N' }), {
      statusCode: 404,
    });
    await assert.rejects(deleteAttribute(ws, 'nope'), { statusCode: 404 });
  });
});

describe('a workspace the migration has not reached yet', () => {
  it('counts the built-in against the cap and can rename it, on the first write', async () => {
    const { WorkspaceMongoModel } = await import('../../models/mongoose/Workspace.js');
    const ws = await workspace();
    await WorkspaceMongoModel.collection.updateOne(
      { _id: ws.id as never },
      { $unset: { 'settings.attributes': '' } },
    );
    const stale = await fresh(ws);
    assert.deepEqual(
      listAttributes(stale).map((def) => def.key),
      ['importance'],
      'implied on read',
    );
    const renamed = await updateAttribute(stale, 'importance', {
      name: 'Urgency',
    });
    assert.equal(renamed.name, 'Urgency');

    await WorkspaceMongoModel.collection.updateOne(
      { _id: ws.id as never },
      { $unset: { 'settings.attributes': '' } },
    );
    for (let index = 1; index < PLAN_LIMITS.attributesPerWorkspace; index += 1) {
      await createAttribute(await fresh(ws), {
        key: `b${String(index)}`,
        name: `B${String(index)}`,
        type: 'text',
      });
    }
    await assert.rejects(
      createAttribute(await fresh(ws), {
        key: 'over',
        name: 'Over',
        type: 'text',
      }),
      { statusCode: 409, code: 'attribute_limit' },
    );
    const keys = listAttributes(await fresh(ws)).map((def) => def.key);
    assert.equal(keys.length, PLAN_LIMITS.attributesPerWorkspace);
    assert.equal(keys[0], 'importance');
  });
});

describe('values in the overlay', () => {
  it('sets Importance on a mirrored item and on a local one, and clears it with null', async () => {
    const ws = await workspace();
    const mirrored = await mirroredItem(ws);
    const local = await items.createItem(ws, 'u-editor', { title: 'Mine' });
    for (const id of [mirrored, local.item.id]) {
      const set = await items.updateOverlay(ws, 'u-editor', id, { attrs: { importance: 5 } });
      assert.equal(set.overlay.attrs['importance'], 5);
      const cleared = await items.updateOverlay(ws, 'u-editor', id, {
        attrs: { importance: null },
      });
      assert.deepEqual(cleared.overlay.attrs, {});
    }
  });

  it('checks values against the definition: type, range, options, unknown keys', async () => {
    const ws = await workspace();
    await createAttribute(ws, {
      key: 'effort',
      name: 'Effort',
      type: 'select',
      options: ['S', 'L'],
    });
    await createAttribute(ws, {
      key: 'due_review',
      name: 'Review',
      type: 'date',
    });
    const ready = await fresh(ws);
    const id = await mirroredItem(ready, 'M-2');
    const bad = (attrs: Record<string, never>): Promise<unknown> =>
      items.updateOverlay(ready, 'u-editor', id, { attrs });
    await assert.rejects(bad({ importance: 6 as never }), { statusCode: 400 });
    await assert.rejects(bad({ importance: 2.5 as never }), { statusCode: 400 });
    await assert.rejects(bad({ importance: 'high' as never }), { statusCode: 400 });
    await assert.rejects(bad({ effort: 'XL' as never }), { statusCode: 400 });
    await assert.rejects(bad({ nope: 1 as never }), { statusCode: 400 });
    await assert.rejects(bad({ due_review: 'tomorrow' as never }), { statusCode: 400 });
    const ok = await items.updateOverlay(ready, 'u-editor', id, {
      attrs: { effort: 'L', due_review: '2026-12-01T09:00:00Z', importance: 1 },
    });
    assert.deepEqual(ok.overlay.attrs, {
      effort: 'L',
      due_review: '2026-12-01T12:00:00.000Z',
      importance: 1,
    });
  });

  it('stores a date attribute as its day at noon UTC, from a day or an ISO date-time', async () => {
    const ws = await workspace();
    await createAttribute(ws, { key: 'review', name: 'Review', type: 'date' });
    const ready = await fresh(ws);
    const id = await mirroredItem(ready, 'M-5');
    for (const value of ['2026-12-01', '2026-12-01T00:00:00Z', '2026-12-01T21:30:00Z']) {
      const saved = await items.updateOverlay(ready, 'u-editor', id, { attrs: { review: value } });
      assert.equal(saved.overlay.attrs['review'], '2026-12-01T12:00:00.000Z', value);
    }
    await assert.rejects(
      items.updateOverlay(ready, 'u-editor', id, { attrs: { review: 'soon' } }),
      {
        statusCode: 400,
      },
    );
  });

  it('never writes to the provider: the mirrored item itself is unchanged', async () => {
    const ws = await workspace();
    const id = await mirroredItem(ws, 'M-3');
    const before = await items.getItem(ws, 'u-editor', id);
    const after = await items.updateOverlay(ws, 'u-editor', id, { attrs: { importance: 4 } });
    assert.equal(after.title, before.title);
    assert.equal(after.status, before.status);
    assert.equal(after.source.externalId, before.source.externalId);
  });

  it('deleting an attribute clears its values on items', async () => {
    const ws = await workspace();
    await createAttribute(ws, { key: 'stars', name: 'Stars', type: 'rating' });
    const ready = await fresh(ws);
    const id = await mirroredItem(ready, 'M-4');
    await items.updateOverlay(ready, 'u-editor', id, { attrs: { stars: 3, importance: 2 } });
    const removed = await deleteAttribute(ready, 'stars');
    assert.equal(removed.items, 1);
    const item = await items.getItem(await fresh(ws), 'u-editor', id);
    assert.deepEqual(item.overlay.attrs, { importance: 2 });
  });
});

describe('migration', () => {
  it('gives a workspace stored before attributes the built-in, once', async () => {
    const mongoose = (await import('mongoose')).default;
    const { MIGRATIONS } = await import('../../migrations/index.js');
    const migration = MIGRATIONS.find((entry) => entry.id.endsWith('add-importance-attribute'));
    assert.ok(migration);
    const raw = mongoose.connection.db;
    assert.ok(raw);
    const collection = raw.collection('Workspaces');
    await collection.insertMany([
      {
        _id: 'old-1' as never,
        name: 'Old',
        slug: 'old-1',
        ownerId: 'u',
        settings: { timezone: 'UTC' },
      },
      {
        _id: 'old-2' as never,
        name: 'Old2',
        slug: 'old-2',
        ownerId: 'u',
        settings: { attributes: [{ key: 'x', name: 'X', type: 'text', builtIn: false }] },
      },
      {
        _id: 'old-3' as never,
        name: 'Old3',
        slug: 'old-3',
        ownerId: 'u',
        settings: {
          attributes: [{ key: 'importance', name: 'Mine', type: 'rating', builtIn: true }],
        },
      },
    ]);
    const first = await migration.run(raw, new Date());
    assert.ok((first['workspaces'] ?? 0) >= 2);
    const second = await migration.run(raw, new Date());
    assert.equal(second['workspaces'], 0);
    const keys = async (id: string): Promise<string[]> => {
      const doc = await collection.findOne({ _id: id as never });
      return (doc?.['settings'] as { attributes: { key: string }[] }).attributes.map((a) => a.key);
    };
    assert.deepEqual(await keys('old-1'), ['importance']);
    assert.deepEqual(await keys('old-2'), ['importance', 'x']);
    const renamed = await collection.findOne({ _id: 'old-3' as never });
    assert.equal(
      (renamed?.['settings'] as { attributes: { name: string }[] }).attributes[0]?.name,
      'Mine',
    );
  });
});
