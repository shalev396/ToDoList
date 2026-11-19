import { environment } from '../config/environment.js';
import { closeDB, migrateDB, resetDatabase, syncDB, syncDBWithin } from '../config/database.js';
import { TimeBudget } from '../classes/integration/calendar/TimeBudget.js';
import { clearAllCognitoUsers } from '../utils/cognitoReset.js';
import { clearUserUploadedAssets } from '../utils/s3Util.js';
import type { DatabaseProvider } from '../types/env.d.ts';

/**
 * Stage maintenance run by the direct-invoke actions in lambda.ts (`npm run deploy:backend` and
 * `npm run reset:db`), and by `npm run sync:schema:local` (`syncIndexesAndValidators`, from a
 * checkout). Never reachable over HTTP.
 */

/**
 * sync-db starts a step (a collection's indexes or validator, a migration) only while this much
 * of the function's time is left: the longest one may take, so the run ends before Lambda kills
 * it and the deploy script asks again (scripts/sync-db-rounds.ts).
 */
export const SYNC_DB_RESERVE_MS = 60_000;

export interface SyncSchemaResult {
  provider: DatabaseProvider;
  results: string[];
  /** false when the time ran out first: ask again. */
  done: boolean;
  /** What is still to do (collection names, migration ids); empty when done. */
  pending: string[];
}

export interface ResetStageResult {
  provider: DatabaseProvider;
  message: string;
}

/**
 * sync-db: indexes and validators, then the pending data migrations (migrations/index.ts). With
 * `remainingMs` (the function's time left), it stops before the step that would leave less than
 * SYNC_DB_RESERVE_MS and answers `done: false` with what is pending; each migration is recorded
 * as it ends and every step is idempotent, so the next round loses nothing. Names and counts only.
 */
export async function syncSchema(
  remainingMs: number | null = null,
  now: () => number = Date.now,
): Promise<SyncSchemaResult> {
  const budget = remainingMs === null ? null : TimeBudget.start(remainingMs, now);
  const indexes = await syncDBWithin(budget, SYNC_DB_RESERVE_MS);
  const provider = environment.databaseProvider;
  if (indexes.pending.length > 0) {
    // The migrations wait: they write documents the new validators accept.
    return { provider, results: indexes.lines, done: false, pending: indexes.pending };
  }
  const migrations = await migrateDB(new Date(), budget, SYNC_DB_RESERVE_MS);
  return {
    provider,
    results: [...indexes.lines, ...migrations.lines],
    done: migrations.pending.length === 0,
    pending: migrations.pending,
  };
}

/**
 * The first half of sync-db alone (`syncDB`: indexes and validators, never the data migrations),
 * with the code that calls it, then the connection closed: `npm run sync:schema:local`
 * (scripts/sync-schema-local.ts) brings a stage's schema to a branch's code before the branch's
 * checks run against it. The same function the deployed sync-db runs, so the validators match.
 */
export async function syncIndexesAndValidators(): Promise<SyncSchemaResult> {
  try {
    return {
      provider: environment.databaseProvider,
      results: await syncDB(),
      done: true,
      pending: [],
    };
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
