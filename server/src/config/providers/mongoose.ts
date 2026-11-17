import mongoose from 'mongoose';
import { environment } from '../environment.js';
import { mongoPoolSize } from '../localSwitches.js';
import { COLLECTION_VALIDATORS } from '../../models/validators.js';

export async function connectMongo(): Promise<void> {
  const state = mongoose.connection.readyState;
  if (
    state === mongoose.ConnectionStates.connected ||
    state === mongoose.ConnectionStates.connecting
  ) {
    return;
  }

  await mongoose.connect(environment.databaseUrl, {
    // Atlas + Lambda: https://www.mongodb.com/docs/atlas/manage-connections-aws-lambda/ (a small
    // pool per execution environment); the local server takes a larger one (config/localSwitches.ts).
    maxPoolSize: mongoPoolSize(),
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    // Index builds belong to sync-db, not to Lambda cold starts (DATA.md §6).
    autoIndex: false,
  });
}

/** Imports every Mongoose model module, which registers its model. */
async function registerModels(): Promise<void> {
  await import('../../models/mongoose/User.js');
  await import('../../models/mongoose/Media.js');
  await import('../../models/mongoose/Workspace.js');
  await import('../../models/mongoose/Membership.js');
  await import('../../models/mongoose/Invite.js');
  await import('../../models/mongoose/Integration.js');
  await import('../../models/mongoose/Credential.js');
  await import('../../models/mongoose/Item.js');
  await import('../../models/mongoose/Container.js');
  await import('../../models/mongoose/SyncState.js');
  await import('../../models/mongoose/SyncRun.js');
  await import('../../models/mongoose/AuditLog.js');
  await import('../../models/mongoose/Dashboard.js');
  await import('../../models/mongoose/DashboardVersion.js');
  await import('../../models/mongoose/View.js');
  await import('../../models/mongoose/Topic.js');
  await import('../../models/mongoose/AgentKey.js');
  await import('../../models/mongoose/McpClient.js');
  await import('../../models/mongoose/McpAuthRequest.js');
  await import('../../models/mongoose/CalendarLink.js');
  await import('../../models/mongoose/ReplayNonce.js');
  await import('../../models/mongoose/CreateQuota.js');
  await import('../../models/mongoose/OAuthState.js');
}

/** A driver error's code name (e.g. "DuplicateKey"): never its message, which can quote values. */
function errorCode(error: unknown): string {
  const { codeName, name } = (error ?? {}) as { codeName?: unknown; name?: unknown };
  if (typeof codeName === 'string') return codeName;
  return typeof name === 'string' ? name : 'unknown error';
}

/**
 * sync-db for MongoDB. For every model: create its collection if missing, make its indexes match
 * the schema (`syncIndexes()` builds missing ones and drops ones the schema no longer declares)
 * and install its `$jsonSchema` validator, if it has one (models/validators.ts). Running it again
 * changes nothing. Returns one line per collection, e.g. `Items: indexes ok (8), validator ok`:
 * names and counts only, never a value.
 */
export async function syncMongo(): Promise<string[]> {
  await connectMongo();
  await registerModels();
  const db = mongoose.connection.db;
  if (db === undefined) throw new Error('sync-db: MongoDB is not connected');

  const models = Object.values(mongoose.models).sort((a, b) =>
    a.collection.collectionName.localeCompare(b.collection.collectionName),
  );
  const lines = new Map<string, string>();
  const failures: string[] = [];

  // Pass 1: indexes for EVERY model, so one broken collection never leaves the others unindexed.
  for (const model of models) {
    const name = model.collection.collectionName;
    try {
      await model.init();
      await model.createCollection();
      const dropped = await model.syncIndexes();
      const indexes = await model.collection.indexes();
      let line = `${name}: indexes ok (${String(indexes.filter((index) => index.name !== '_id_').length)})`;
      if (dropped.length > 0) line += `, dropped ${dropped.join(', ')}`;
      lines.set(name, line);
    } catch (error) {
      failures.push(`${name} (${errorCode(error)})`);
    }
  }

  // Pass 2: validators, for the collections whose indexes are in place.
  for (const model of models) {
    const name = model.collection.collectionName;
    const validator = COLLECTION_VALIDATORS[name];
    const line = lines.get(name);
    if (validator === undefined || line === undefined) continue;
    try {
      await db.command({
        collMod: name,
        validator,
        validationLevel: 'moderate',
        validationAction: 'error',
      });
      lines.set(name, `${line}, validator ok`);
    } catch (error) {
      lines.delete(name);
      failures.push(`${name} (${errorCode(error)})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`sync-db: failed for ${failures.join(', ')}`);
  }
  return models.map((model) => lines.get(model.collection.collectionName) ?? '');
}

export async function clearAllMongo(): Promise<void> {
  await connectMongo();
  await mongoose.connection.dropDatabase();
}

export function getMongoose(): typeof mongoose {
  return mongoose;
}
