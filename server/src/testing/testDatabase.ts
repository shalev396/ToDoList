/**
 * Test-only database for model tests: a throwaway mongod (memoryMongo.ts), the environment pointed
 * at it (the dev stage, TEST_STAGE_ENV, unless a test overrides a value), the test seams in place
 * (testSeams.ts) and a connection through initDB().
 *
 * A server never builds indexes as models load (sync-db does); this connection does, so a model
 * test sees its unique and partial indexes without running sync-db first.
 *
 * config/environment.ts reads process.env once, at import: call this before importing anything
 * that reads it, and import those modules dynamically afterwards.
 */
import { startMemoryMongo } from './memoryMongo.js';
import { installTestSeams, TEST_STAGE_ENV, type TestSeams } from './testSeams.js';

export interface TestDatabase {
  uri: string;
  /** The seams in place: the emails the app sent, the in-memory bucket. */
  seams: TestSeams;
  stop: () => Promise<void>;
}

export async function startTestDatabase(
  dbName: string,
  env: Record<string, string> = {},
): Promise<TestDatabase> {
  const mongo = await startMemoryMongo(dbName);
  Object.assign(process.env, { ...TEST_STAGE_ENV, DATABASE_URL: mongo.uri, ...env });
  let seams: TestSeams;
  try {
    seams = await installTestSeams();
    const { initDB } = await import('../config/database.js');
    await initDB();
    const mongoose = (await import('mongoose')).default;
    // Indexes as models load (see the header), and for any model loaded before this point.
    mongoose.connection.set('autoIndex', true);
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).createIndexes()));
  } catch (error) {
    // A mongod left running keeps the test process alive: stop it, then fail.
    await mongo.stop();
    throw error;
  }
  return {
    uri: mongo.uri,
    seams,
    stop: async (): Promise<void> => {
      const mongoose = (await import('mongoose')).default;
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}
