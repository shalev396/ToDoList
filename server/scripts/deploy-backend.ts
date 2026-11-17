import { DATABASE_URL_PARAMETER, stackName, SYNC_DB_ACTION } from '../infra/lib/constants.js';
import { runApiAction } from './api-action.js';
import { ensureAppSecret } from './app-secret.js';
import {
  cdkContext,
  findHostedZone,
  requireEnv,
  runCdk,
  runScript,
  stageFromArgs,
} from './stage.js';
import { activateCostAllocationTags } from './cost-allocation-tags.js';

/**
 * npm run deploy:backend -- <stage>
 *
 * The one backend deploy path, used locally and by CI, for a new or an existing stack alike:
 *   1. find the Route 53 hosted zone for DOMAIN_NAME
 *   2. make sure the app secret todolist-<stage>-app-secrets exists (created `{}` if missing,
 *      never written over; scripts/app-secret.ts)
 *   3. build + verify the two Lambda layers
 *   4. cdk deploy, passing DATABASE_URL as the NoEcho parameter. CDK creates the stack or updates
 *      it; a failed deploy rolls back, and a stack whose creation rolled back is recreated.
 *   5. sync the database schema: invoke the API function with {"action":"sync-db"}
 *   6. activate the Project and Stage cost allocation tags for billing (never fails the deploy)
 *
 * Inputs: DOMAIN_NAME and DATABASE_URL (shell or server/.env.<stage>) plus AWS credentials.
 */

const LABEL = 'deploy:backend';
const stage = stageFromArgs(LABEL);
const stack = stackName(stage);
const databaseUrl = requireEnv(LABEL, stage, 'DATABASE_URL');
const domainName = requireEnv(LABEL, stage, 'DOMAIN_NAME');

// 1. Hosted zone
const zone = await findHostedZone(domainName);
console.warn(`[${LABEL}] hosted zone ${zone.name} (${zone.id}) for ${domainName}`);

// 2. App secret
await ensureAppSecret(LABEL, stage);

// 3. Layers
runScript(LABEL, 'building layers', 'scripts/build-layers.ts');
runScript(LABEL, 'verifying layers', 'scripts/verify-layers.ts');

// 4. Deploy
runCdk(LABEL, `cdk deploy ${stack}`, [
  'deploy',
  stack,
  ...cdkContext(stage, zone),
  '--parameters',
  `${DATABASE_URL_PARAMETER}=${databaseUrl}`,
  '--require-approval',
  'never',
  '--ci',
]);

// 5. Database schema
const synced = await runApiAction(LABEL, stage, SYNC_DB_ACTION);
console.warn(`[${LABEL}] database schema synced: ${synced}`);

// 6. Cost allocation tags
await activateCostAllocationTags(LABEL);
