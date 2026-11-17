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
import { startLatencyProxy, type LatencyProxy } from './latencyProxy.js';
import { startMemoryMongo } from './memoryMongo.js';
import { installTestSeams, TEST_STAGE_ENV, type TestSeams } from './testSeams.js';

export interface TestDatabase {
  uri: string;
  /** The seams in place: the emails the app sent, the in-memory bucket. */
  seams: TestSeams;
  stop: () => Promise<void>;
}

export interface TestDatabaseOptions {
  /**
   * Reach mongod through a proxy that delays every round trip by this much (latencyProxy.ts), as
   * a database across a network answers, with the driver's command monitoring on (the client's
   * `commandStarted` events). Unset: a direct connection, unmonitored.
   */
  roundTripMs?: number;
}

/** `mongodb://host:port/db?…` with its host swapped for `address` and command monitoring on. */
function monitoredUri(uri: string, address: string): string {
  const url = new URL(uri);
  url.host = address;
  url.searchParams.set('monitorCommands', 'true');
  return url.toString();
}

export async function startTestDatabase(
  dbName: string,
  env: Record<string, string> = {},
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  const mongo = await startMemoryMongo(dbName);
  let proxy: LatencyProxy | null = null;
  let uri = mongo.uri;
  if (options.roundTripMs !== undefined) {
    proxy = await startLatencyProxy(new URL(mongo.uri).host, options.roundTripMs / 2);
    uri = monitoredUri(mongo.uri, proxy.address);
  }
  Object.assign(process.env, { ...TEST_STAGE_ENV, DATABASE_URL: uri, ...env });
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
    await proxy?.stop();
    await mongo.stop();
    throw error;
  }
  return {
    uri: mongo.uri,
    seams,
    stop: async (): Promise<void> => {
      const mongoose = (await import('mongoose')).default;
      await mongoose.disconnect();
      await proxy?.stop();
      await mongo.stop();
    },
  };
}
