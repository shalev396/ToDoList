import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startMemoryMongo, type MemoryMongo } from '../../testing/memoryMongo.js';

// Every server: index builds belong to sync-db, not to Lambda cold starts (DATA.md §6). Connected
// without the test harness, which builds indexes as models load (testing/testDatabase.ts).
let mongo: MemoryMongo;

before(async () => {
  mongo = await startMemoryMongo('todolist_autoindex_test');
  Object.assign(process.env, { ENV: 'prod', DATABASE_URL: mongo.uri });
  const { initDB } = await import('../database.js');
  await initDB();
});

after(async () => {
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect();
  await mongo.stop();
});

describe('connectMongo', () => {
  it('turns autoIndex off', async () => {
    const { connection } = (await import('mongoose')).default;
    assert.equal(connection.get('autoIndex'), false);
  });
});
