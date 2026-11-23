import { installConsoleRedaction } from './services/logger.js';

// First, before anything can log: every console.* call is redacted from here on.
installConsoleRedaction();

import serverlessHttp from 'serverless-http';
import type { Context } from 'aws-lambda';
import { createApp } from './app.js';
import { initDB } from './config/database.js';
import { AppError } from './errors/AppError.js';
import { purgeDeleted } from './jobs/purge.js';
import { runScheduledTick } from './jobs/scheduledTick.js';
import { seedStage } from './jobs/seed.js';
import { logger } from './services/logger.js';
import { resetStage, syncSchema } from './services/stageMaintenance.js';
import { parseSyncJob } from './services/syncJobs.js';
import { dispatchGcalSyncs } from './sync/gcalDispatcher.js';
import { runSyncJobWithin } from './sync/worker.js';
import {
  API_ACTIONS,
  GCAL_DISPATCH_ACTION,
  GCAL_RUN_ACTION,
  PURGE_ACTION,
  RESET_DB_ACTION,
  SEED_ACTION,
  SYNC_DB_ACTION,
  SYNC_DISPATCH_ACTION,
  SYNC_RUN_ACTION,
  type ApiAction,
} from '../infra/lib/constants.js';

/**
 * Lambda entry for the entire backend, the stack's only function. Bundled into the codebase layer
 * at /opt/nodejs/app/index.mjs and re-exported as `handler` by server/lambda/index.mjs.
 *
 * Three event shapes reach it:
 * - API Gateway HTTP API events → the Express app
 * - a background sync job, `{ "action": "sync-run" | "gcal-run", … }`: an async invocation of
 *   this function by itself (services/syncJobs.ts), run by sync/worker.ts. It throws when a retry
 *   may help, so Lambda's async invocation runs it again. A malformed job is dropped (400).
 * - a maintenance action, `{ "action": … }`:
 *   - `sync-db`       from `npm run deploy:backend` (every stage), in rounds: it stops before the
 *                    step that would leave less than 60 s of the function's time and answers
 *                    `done: false` with what is pending; the script asks again until `done: true`
 *   - `reset-db`      from `npm run reset:db` before the test suites (refused on prod)
 *   - `sync-dispatch` one background sync run per dispatchable integration, then the
 *                    after-dispatch passes (jobs/scheduledTick.ts)
 *   - `gcal-dispatch` one background Google Calendar push + pull per OAuth integration
 *   - `purge`         hard-delete rows soft-deleted more than 30 days ago, end dead sync runs
 *   - `seed`          demo data, dev only (refused elsewhere)
 *   `sync-dispatch` also runs hourly from the stack's one EventBridge rule, and its tick at
 *   PURGE_HOUR_UTC runs the purge too (once a day); the others run only when invoked directly. A refused action answers with its AppError's status code.
 * Only lambda:InvokeFunction reaches the jobs and the actions, never the HTTP API: API Gateway
 * events always carry `requestContext`, so HTTP traffic can never take those branches.
 */

await initDB();

// No binary types: every response is JSON (files are served by S3 through presigned URLs). If
// the app ever sends binary bodies, list their content types in a `binary` option here.
const http = serverlessHttp(createApp());

interface ActionResult {
  statusCode: number;
  body: string;
}

/** The `action` of a direct invoke; null for an HTTP event or an event without one. */
function directAction(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || 'requestContext' in event) return null;
  return (event as { action?: unknown }).action ?? null;
}

function isApiAction(action: unknown): action is ApiAction {
  return (API_ACTIONS as readonly unknown[]).includes(action);
}

const ACTIONS: Record<ApiAction, (context: Context) => Promise<unknown>> = {
  [SYNC_DB_ACTION]: (context) => syncSchema(remainingMsOf(context)),
  [RESET_DB_ACTION]: resetStage,
  [SYNC_DISPATCH_ACTION]: () => runScheduledTick(),
  [GCAL_DISPATCH_ACTION]: () => dispatchGcalSyncs(),
  [PURGE_ACTION]: () => purgeDeleted(),
  [SEED_ACTION]: () => seedStage(),
};

async function runAction(action: ApiAction, context: Context): Promise<ActionResult> {
  // No disconnect afterwards: the container is reused for HTTP requests.
  try {
    const result = await ACTIONS[action](context);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    if (error instanceof AppError) {
      console.warn('%s refused: %s', action, error.message);
      return { statusCode: error.statusCode, body: JSON.stringify({ error: error.message }) };
    }
    console.error('%s failed:', action, error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
}

/** The function's time left, in ms; null for a context without it (a test's, a local run). */
export function remainingMsOf(
  context: Partial<Pick<Context, 'getRemainingTimeInMillis'>>,
): number | null {
  const remaining = context.getRemainingTimeInMillis?.();
  return typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null;
}

/**
 * One background job, within the function's time left (travel after a sync stops in time). A
 * throw is deliberate: Lambda then retries the async invocation.
 */
async function runJob(event: unknown, context: Context): Promise<ActionResult> {
  const job = parseSyncJob(event);
  if (job === null) {
    // Never retried: the same payload would be malformed again.
    logger.warn('background job dropped: malformed');
    return { statusCode: 400, body: JSON.stringify({ error: 'Malformed job' }) };
  }
  await runSyncJobWithin(job, remainingMsOf(context));
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

export const handler = async (event: unknown, context: Context): Promise<unknown> => {
  const action = directAction(event);
  if (action === SYNC_RUN_ACTION || action === GCAL_RUN_ACTION) return runJob(event, context);
  if (isApiAction(action)) return runAction(action, context);
  return http(event as object, context);
};
