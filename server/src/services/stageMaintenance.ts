import { environment } from '../config/environment.js';
import { closeDB, migrateDB, resetDatabase, syncDB } from '../config/database.js';
import { clearAllCognitoUsers } from '../utils/cognitoReset.js';
import { clearUserUploadedAssets } from '../utils/s3Util.js';
import type { DatabaseProvider } from '../types/env.d.ts';

/**
 * Stage maintenance run by the direct-invoke actions in lambda.ts (`npm run deploy:backend` and
 * `npm run reset:db`), and by `npm run sync:schema:local` (`syncIndexesAndValidators`, from a
 * checkout). Never reachable over HTTP.
 */

export interface SyncSchemaResult {
  provider: DatabaseProvider;
  results: string[];
}

export interface ResetStageResult {
  provider: DatabaseProvider;
  message: string;
}

/** sync-db: indexes and validators, then the pending data migrations (migrations/index.ts). */
export async function syncSchema(): Promise<SyncSchemaResult> {
  const results = await syncDB();
  const migrations = await migrateDB();
  return { provider: environment.databaseProvider, results: [...results, ...migrations] };
}

/**
 * The first half of sync-db alone (`syncDB`: indexes and validators, never the data migrations),
 * with the code that calls it, then the connection closed: `npm run sync:schema:local`
 * (scripts/sync-schema-local.ts) brings a stage's schema to a branch's code before the branch's
 * checks run against it. The same function the deployed sync-db runs, so the validators match.
 */
export async function syncIndexesAndValidators(): Promise<SyncSchemaResult> {
  try {
    return { provider: environment.databaseProvider, results: await syncDB() };
  } finally {
    await closeDB();
  }
}

/**
 * Drops and re-creates the schema, deletes every user upload under media/ and every Cognito user.
 * Refused on prod.
 */
export async function resetStage(): Promise<ResetStageResult> {
  if (!environment.allowsStageReset) {
    throw new Error(`reset-db is not allowed on the ${environment.env} stage`);
  }
  await resetDatabase();
  await syncDB();
  await clearUserUploadedAssets();
  await clearAllCognitoUsers();
  return {
    provider: environment.databaseProvider,
    message: 'Database, S3 user uploads, and Cognito user pool reset complete',
  };
}
