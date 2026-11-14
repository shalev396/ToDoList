/**
 * Test-only MongoDB: a throwaway mongod (mongodb-memory-server) on a random port with a temp data
 * directory, so tests never touch a real database. When a MongoDB server binary is installed
 * locally it is reused (MONGOMS_SYSTEM_BINARY) instead of downloading one; CI downloads it.
 */
import { existsSync } from 'node:fs';

const WINDOWS_MONGOD = 'C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe';

/**
 * How long mongod may take to start (the library's default is 10 s). `npm run test:unit` starts
 * one per database test file, all at once, and on a busy machine some need longer than 10 s.
 */
const LAUNCH_TIMEOUT_MS = 60_000;

export interface MemoryMongo {
  uri: string;
  stop: () => Promise<void>;
}

export async function startMemoryMongo(dbName = 'todolist_test'): Promise<MemoryMongo> {
  if ((process.env['MONGOMS_SYSTEM_BINARY'] ?? '') === '' && existsSync(WINDOWS_MONGOD)) {
    process.env['MONGOMS_SYSTEM_BINARY'] = WINDOWS_MONGOD;
  }
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const server = await MongoMemoryServer.create({ instance: { launchTimeout: LAUNCH_TIMEOUT_MS } });
  return {
    uri: server.getUri(dbName),
    stop: async (): Promise<void> => {
      await server.stop();
    },
  };
}
