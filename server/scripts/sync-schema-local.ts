import { schemaSyncStage, SCHEMA_SYNC_LABEL } from './schema-sync-stage.js';
import { fail, requireEnv, stageFromArgs } from './stage.js';

/**
 * npm run sync:schema:local -- <dev|qa>
 *
 * Syncs the stage database's indexes and validators with THIS checkout's code, through
 * stageMaintenance's `syncIndexesAndValidators`: the same function the deployed function's sync-db
 * action runs first, so the validators match exactly. Never the data migrations, and nothing else.
 *
 * Why: the PR-to-qa checks (.github/workflows/_test-local.yml) run the branch's local API against
 * the qa database, after `reset:db` re-synced it through the DEPLOYED function, whose code is the
 * last merge's. A branch that adds an item kind (or any validator change) would be refused by the
 * old validators until it is deployed; this brings the stage's schema to the branch's first.
 *
 * Connects with DATABASE_URL (the shell's or CI's; server/.env.<stage> when it is not set).
 * Refused for prod. Prints collection names and counts only: never the URL or a value.
 */

const parsed = schemaSyncStage(process.argv[2]);
if (!parsed.ok) fail(SCHEMA_SYNC_LABEL, parsed.message);
const stage = stageFromArgs(SCHEMA_SYNC_LABEL);
requireEnv(SCHEMA_SYNC_LABEL, stage, 'DATABASE_URL');

const { syncIndexesAndValidators } = await import('../src/services/stageMaintenance.js');
try {
  const { provider, results } = await syncIndexesAndValidators();
  console.warn(
    `[${SCHEMA_SYNC_LABEL}] ${stage}: ${provider} indexes and validators synced with this checkout (${String(results.length)} collections)`,
  );
  for (const line of results) console.warn(`[${SCHEMA_SYNC_LABEL}]   ${line}`);
} catch (error) {
  // sync-db's own failure names collections and codes only; any other error (a driver's may name
  // the host it tried) by its name alone, never its message, stack or causes.
  const own = error instanceof Error && error.message.startsWith('sync-db:');
  const reason = own ? error.message : error instanceof Error ? error.name : 'unknown error';
  fail(SCHEMA_SYNC_LABEL, `${stage}: sync failed: ${reason}`);
}
