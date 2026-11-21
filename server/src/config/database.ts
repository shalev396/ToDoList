import { environment } from './environment.js';
import type { TimeBudget } from '../classes/integration/calendar/TimeBudget.js';
import type { MigrationOptions } from '../migrations/index.js';

let shutdownRegistered = false;

function registerGracefulShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  process.on('SIGTERM', () => {
    if (environment.databaseProvider === 'mongoose') {
      void import('mongoose')
        .then((m) => m.default.disconnect())
        .catch((error: unknown) => {
          console.error('Error disconnecting from MongoDB:', error);
        });
    } else {
      void import('./providers/sequelize.js')
        .then(({ getSequelize }) => getSequelize().close())
        .catch((error: unknown) => {
          console.error('Error disconnecting from PostgreSQL:', error);
        });
    }
  });
}

export async function initDB(): Promise<void> {
  if (environment.databaseProvider === 'mongoose') {
    const { connectMongo } = await import('./providers/mongoose.js');
    await connectMongo();
  } else {
    const { connectSequelize } = await import('./providers/sequelize.js');
    await connectSequelize();
    const { defineAssociations } = await import('../models/sequelize/associations.js');
    defineAssociations();
  }

  registerGracefulShutdown();
}

export async function syncDB(): Promise<string[]> {
  return (await syncDBWithin(null, 0)).lines;
}

/** syncDB within a time budget (sync-db in rounds): what is done, and what is still pending. */
export async function syncDBWithin(
  budget: TimeBudget | null,
  reserveMs: number,
): Promise<{ lines: string[]; pending: string[] }> {
  if (environment.databaseProvider === 'mongoose') {
    const { syncMongoWithin } = await import('./providers/mongoose.js');
    return await syncMongoWithin(budget, reserveMs);
  } else {
    const { syncSequelize } = await import('./providers/sequelize.js');
    return { lines: await syncSequelize(), pending: [] };
  }
}

/**
 * The data migrations (migrations/index.ts) not applied yet, run after sync-db (indexes and
 * validators first: a migration writes documents the new validators accept). MongoDB only. One
 * line per migration, names and counts only. Within a time budget, it stops before the migration
 * that would not end in time and answers the ids still pending.
 */
export async function migrateDB(
  now: Date = new Date(),
  budget: TimeBudget | null = null,
  reserveMs = 0,
  options: MigrationOptions = {},
): Promise<{ lines: string[]; pending: string[] }> {
  if (environment.databaseProvider !== 'mongoose') return { lines: [], pending: [] };
  const mongoose = (await import('mongoose')).default;
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('migrate: MongoDB is not connected');
  const { runMigrationsWithin } = await import('../migrations/index.js');
  return runMigrationsWithin(db, now, budget, reserveMs, options);
}

/** Closes the connection: the end of a one-off script (a server keeps it open). */
export async function closeDB(): Promise<void> {
  if (environment.databaseProvider === 'mongoose') {
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect();
  } else {
    const { getSequelize } = await import('./providers/sequelize.js');
    await getSequelize().close();
  }
}

export async function resetDatabase(): Promise<void> {
  if (environment.env !== 'qa' && environment.env !== 'dev') {
    throw new Error(
      `resetDatabase can only run on the 'dev' or 'qa' stage, not '${environment.env}'`,
    );
  }

  if (environment.databaseProvider === 'mongoose') {
    const { clearAllMongo } = await import('./providers/mongoose.js');
    await clearAllMongo();
  } else {
    const { clearAllSequelize } = await import('./providers/sequelize.js');
    await clearAllSequelize();
  }
}
