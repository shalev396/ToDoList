import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';

let db: TestDatabase;
let connection: Connection;
let syncDB: () => Promise<string[]>;

before(async () => {
  db = await startTestDatabase('todolist_sync_test');
  ({ syncDB } = await import('../database.js'));
  connection = (await import('mongoose')).default.connection;
});

after(async () => {
  await db.stop();
});

/** A raw Items document that passes the validator. */
function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: `raw-${String(Math.random()).slice(2)}`,
    workspaceId: 'w-raw',
    kind: 'todo',
    topicId: null,
    title: 'Raw insert',
    status: 'open',
    source: { provider: 'local', accountId: '', externalId: 'x', url: '/w/w-raw/items/x' },
    ...overrides,
  };
}

/** MongoDB's DocumentValidationFailure. */
function isValidationFailure(error: unknown): boolean {
  return (error as { code?: unknown }).code === 121;
}

describe('syncMongo (sync-db on MongoDB)', () => {
  let first: string[] = [];

  it('creates collections, indexes and validators, and a second run is the same no-op', async () => {
    first = await syncDB();
    const second = await syncDB();
    assert.deepEqual(second, first);
    // Items: + a to-do's provider copies (H5), idempotent local create (T2.5a fix round 1), the per-resource sweep index
    // (T3.2 fix round 1) and a travel leg's key (travel). Containers: + the per-resource sweep index.
    assert.ok(first.includes('Items: indexes ok (12), validator ok'), first.join('\n'));
    assert.ok(first.includes('Containers: indexes ok (3), validator ok'), first.join('\n'));
    assert.ok(first.includes('Credentials: indexes ok (3), validator ok'), first.join('\n'));
    assert.ok(first.includes('Workspaces: indexes ok (3)'), first.join('\n'));
    assert.ok(first.includes('Invites: indexes ok (3)'), first.join('\n'));
    // The workspace collections (the travel ones the newest) plus Users and Media, one line each.
    // The state hash (unique) and the 10-minute TTL.
    assert.ok(first.includes('OAuthStates: indexes ok (2)'), first.join('\n'));
    assert.ok(first.includes('Topics: indexes ok (1)'), first.join('\n'));
    // MCP sign-in adds McpClients and McpAuthRequests (TTL indexes; the request's code hash).
    assert.ok(first.includes('McpClients: indexes ok (1)'), first.join('\n'));
    assert.ok(first.includes('McpAuthRequests: indexes ok (2)'), first.join('\n'));
    // Travel adds a member's places (one Home), rules and profile, and the routing quota's days.
    assert.ok(first.includes('Places: indexes ok (2), validator ok'), first.join('\n'));
    assert.ok(first.includes('TravelRules: indexes ok (1), validator ok'), first.join('\n'));
    assert.ok(first.includes('TravelProfiles: indexes ok (2), validator ok'), first.join('\n'));
    assert.ok(first.includes('RoutingQuotas: indexes ok (1)'), first.join('\n'));
    assert.equal(first.length, 27, first.join('\n'));
  });

  it('reports collection names and counts only, never a value', () => {
    for (const line of first) {
      assert.match(line, /^[A-Za-z]+: indexes ok \(\d+\)(, validator ok)?$/);
      assert.ok(!line.includes(db.uri));
    }
  });

  it('builds the schema indexes in the database', async () => {
    const indexes = await connection.collection('Items').indexes();
    assert.equal(indexes.filter((index) => index.name !== '_id_').length, 12);
    assert.ok(
      indexes.some((index) => index.name === 'integrationId_1_syncResource_1_lastSeenAt_1'),
      'the per-resource sweep index',
    );
  });

  it('drops an index the schema no longer declares and says so', async () => {
    await connection.collection('Views').createIndex({ ownerUserId: 1 }, { name: 'stale_index' });
    const lines = await syncDB();
    assert.ok(lines.includes('Views: indexes ok (1), dropped stale_index'), lines.join('\n'));
  });

  it('swaps the old items text index for the one that searches title overrides (Phase 4a)', async () => {
    const items = connection.collection('Items');
    const textIndex = (await items.indexes()).find(
      (index) => index.name?.endsWith('_text') === true,
    );
    assert.ok(textIndex?.name !== undefined);
    // A database from before: its text index without the override title.
    await items.dropIndex(textIndex.name);
    await items.createIndex(
      { title: 'text', bodyPreview: 'text' },
      { weights: { title: 5, bodyPreview: 1 }, default_language: 'none' },
    );
    const lines = await syncDB();
    assert.ok(
      lines.includes('Items: indexes ok (12), dropped title_text_bodyPreview_text, validator ok'),
      lines.join('\n'),
    );
    const now = (await items.indexes()).find((index) => index.name?.endsWith('_text') === true);
    assert.deepEqual(now?.weights, { title: 5, bodyPreview: 1, 'overlay.overrides.title': 5 });
  });

  it('the Items validator rejects a raw insert with kind "bogus", and takes block and travel', async () => {
    const items = connection.collection('Items');
    await assert.rejects(items.insertOne(rawItem({ kind: 'bogus' })), isValidationFailure);
    await assert.rejects(
      items.insertOne(rawItem({ source: { provider: 'local' } })),
      isValidationFailure,
    );
    await items.insertOne(rawItem());
    // TodoList's own reserved time: the validator sync-db installs takes the new kinds.
    const source = (externalId: string): Record<string, unknown> => ({
      provider: 'local',
      accountId: '',
      externalId,
      url: `/w/w-raw/items/${externalId}`,
    });
    await items.insertOne(
      rawItem({ kind: 'block', props: { layer: 'area' }, source: source('b') }),
    );
    await items.insertOne(rawItem({ kind: 'travel', visibility: 'private', source: source('t') }));
  });

  it('the Containers and Credentials validators reject documents without source or enc parts', async () => {
    const noSource: Record<string, unknown> = {
      _id: 'c-raw',
      workspaceId: 'w-raw',
      type: 'project',
    };
    const containers = connection.collection('Containers');
    await assert.rejects(containers.insertOne(noSource), isValidationFailure);
    await assert.rejects(containers.insertOne(rawItem({ type: 'shelf' })), isValidationFailure);

    const partialEnc: Record<string, unknown> = {
      _id: 'cred-raw',
      workspaceId: 'w-raw',
      integrationId: 'i-raw',
      enc: { ciphertext: 'FAKE-ciphertext' },
    };
    await assert.rejects(
      connection.collection('Credentials').insertOne(partialEnc),
      isValidationFailure,
    );
  });

  it('builds indexes automatically on the local server only (autoIndex)', () => {
    assert.equal(connection.get('autoIndex'), true);
  });

  it('finishes every index before validators, and one error lists each failed collection', async () => {
    await connection.collection('Workspaces').dropIndexes();
    const realDb = connection.db;
    assert.ok(realDb !== undefined);
    const original = realDb.command.bind(realDb);
    const command = mock.method(realDb, 'command', (doc: Record<string, unknown>) => {
      if (doc['collMod'] === 'Containers' || doc['collMod'] === 'Items') {
        return Promise.reject(
          Object.assign(new Error('secret value'), { codeName: 'Unauthorized' }),
        );
      }
      return original(doc);
    });
    try {
      await assert.rejects(syncDB(), (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /Containers \(Unauthorized\)/);
        assert.match(message, /Items \(Unauthorized\)/);
        assert.ok(!message.includes('secret value'));
        return true;
      });
    } finally {
      command.mock.restore();
    }
    const indexes = await connection.collection('Workspaces').indexes();
    assert.equal(indexes.filter((index) => index.name !== '_id_').length, 3);
  });
});
