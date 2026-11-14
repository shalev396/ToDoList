/**
 * "Sync now" and the sync-run history (BACKEND.md §4, DATA.md §3.9). Pure services: no Express.
 *
 * - A manual sync goes through enqueueSync (202 with the run id; the engine runs it).
 * - It is refused (409) for an integration that waits for its owner, like the dispatcher skips
 *   it: paused, expired, or failed auth (a reconnect: save the credential again); and in live
 *   mode, one without a credential.
 * - At most one manual sync per integration per LIMITS.manualSyncIntervalMs, counted from the
 *   newest `manual` SyncRun (one integration: 429 with the wait; "sync all": skipped).
 * - Runs are shown sanitized: counts, and an error as a code with its fixed message. Never the
 *   failed records, never stored text.
 * - PERMISSIONS-V2 (rulings 1 and 20): only an integration's owner syncs it or sees its runs,
 *   whatever their role; for anyone else it does not exist (404).
 */
import { z } from 'zod';

import { syncModeFor } from '../sync/syncMode.js';
import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import type { ErrorInfo } from '../models/definitions/common.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { SyncRunData } from '../models/definitions/SyncRun.js';
import { getCredentialRepository, getSyncRunRepository } from '../models/index.js';
import { SYNC_ERROR_MESSAGES } from '../sync/runSync.js';
import type { SyncRunView } from '../types/integrations.js';
import type { WorkspaceContext } from './accessFilter.js';
import { findOwnIntegration, listOwnIntegrations } from './integrationOwnership.js';
import { logger } from './logger.js';
import { enqueueSync } from './syncJobs.js';

export const SYNC_RUNS_DEFAULT_LIMIT = 20;
export const SYNC_RUNS_MAX_LIMIT = 100;

/** Runs looked at for the newest manual one: far more than 5 minutes can hold. */
const RECENT_RUNS = 20;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const COUNT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** `GET …/sync-runs?integrationId&limit`. */
export const SyncRunsQuery = z.strictObject({
  integrationId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SYNC_RUNS_MAX_LIMIT).optional(),
});

/** Why an integration can't be synced now. */
type Hold = 'demo' | 'paused' | 'expired' | 'reconnect' | 'no_credential';

const HOLD_MESSAGES: Readonly<Record<Hold, string>> = {
  demo: 'Demo data never syncs: its items are a sample',
  paused: 'This integration is paused: save its credential again to resume',
  expired: 'This connection has expired: save a new credential',
  reconnect: 'Reconnect required: save the credential again',
  no_credential: 'Save the credential first',
};

/** What waits for the owner, as the dispatcher sees it; live mode also needs a credential. */
async function holdOf(ctx: WorkspaceContext, integration: IntegrationData): Promise<Hold | null> {
  if (integration.demo) return 'demo';
  if (integration.status === 'paused') return 'paused';
  if (integration.status === 'expired') return 'expired';
  if (integration.lastError?.code === 'auth_failed') return 'reconnect';
  if (syncModeFor(integration) !== 'fixtures') {
    const credential = await (await getCredentialRepository()).findMeta(ctx.id, integration.id);
    if (credential === null) return 'no_credential';
  }
  return null;
}

/** How long until the integration may be synced manually again (0: now). */
async function cooldownLeft(workspaceId: string, integrationId: string): Promise<number> {
  const runs = await (
    await getSyncRunRepository()
  ).listForIntegration(workspaceId, integrationId, RECENT_RUNS);
  const newestManual = runs
    .filter((run) => run.trigger === 'manual')
    .reduce<number>((newest, run) => Math.max(newest, run.createdAt.getTime()), 0);
  if (newestManual === 0) return 0;
  return Math.max(0, newestManual + LIMITS.manualSyncIntervalMs - Date.now());
}

/**
 * A failure to start the run (on Lambda, the async invoke of the function itself) is not the
 * request's: 503, the detail in the log.
 */
async function enqueue(integrationId: string): Promise<string> {
  try {
    return (await enqueueSync(integrationId, 'manual')).runId;
  } catch (error) {
    logger.error('could not queue a manual sync', { integrationId, error });
    throw new AppError(503, 'Could not queue the sync. Try again later.');
  }
}

export type SyncRequestOutcome = { runId: string } | { retryAfterMs: number };

/**
 * "Sync now" for one of the member's own integrations (404 otherwise). 409 while it waits for
 * them; `{retryAfterMs}` while a manual sync of it is less than the interval old.
 */
export async function requestIntegrationSync(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<SyncRequestOutcome> {
  const integration = await findOwnIntegration(ctx, userId, integrationId);
  const hold = await holdOf(ctx, integration);
  if (hold !== null) throw new AppError(409, HOLD_MESSAGES[hold]);
  const wait = await cooldownLeft(ctx.id, integration.id);
  if (wait > 0) return { retryAfterMs: wait };
  return { runId: await enqueue(integration.id) };
}

/**
 * "Sync now" for every integration the member owns here and can sync. Those waiting for them or
 * synced manually less than the interval ago are skipped. 503 only when nothing could be queued
 * because the queue failed.
 */
export async function requestWorkspaceSync(
  ctx: WorkspaceContext,
  userId: string,
): Promise<{ runIds: string[] }> {
  const runIds: string[] = [];
  let queueFailures = 0;
  for (const integration of await listOwnIntegrations(ctx, userId)) {
    if ((await holdOf(ctx, integration)) !== null) continue;
    if ((await cooldownLeft(ctx.id, integration.id)) > 0) continue;
    try {
      runIds.push(await enqueue(integration.id));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      queueFailures += 1;
    }
  }
  if (runIds.length === 0 && queueFailures > 0) {
    throw new AppError(503, 'Could not queue the sync. Try again later.');
  }
  return { runIds };
}

// ─── History ────────────────────────────────────────────────────────────────

/** A code and its fixed message. A code the engine doesn't know keeps the generic message. */
function sanitizedError(error: ErrorInfo): { code: string; message: string } {
  if (!ERROR_CODE.test(error.code)) {
    return { code: 'internal', message: SYNC_ERROR_MESSAGES.internal };
  }
  const message = Object.hasOwn(SYNC_ERROR_MESSAGES, error.code)
    ? SYNC_ERROR_MESSAGES[error.code as keyof typeof SYNC_ERROR_MESSAGES]
    : SYNC_ERROR_MESSAGES.internal;
  return { code: error.code, message };
}

/** Field by field: counts are named numbers; the failed records never leave the server. */
export function toSyncRunView(run: SyncRunData): SyncRunView {
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(run.counts)) {
    if (COUNT_NAME.test(name) && Number.isFinite(value)) counts[name] = value;
  }
  return {
    id: run.id,
    integrationId: run.integrationId,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts,
    error: run.error === null ? null : sanitizedError(run.error),
  };
}

export interface ListSyncRunsInput {
  integrationId?: string | undefined;
  limit?: number | undefined;
}

/**
 * The newest runs of the member's own integrations (one of them with `integrationId`: 404 when it
 * isn't theirs), newest first.
 */
export async function listSyncRuns(
  ctx: WorkspaceContext,
  userId: string,
  input: ListSyncRunsInput,
): Promise<SyncRunView[]> {
  const limit = Math.min(input.limit ?? SYNC_RUNS_DEFAULT_LIMIT, SYNC_RUNS_MAX_LIMIT);
  const integrations =
    input.integrationId === undefined
      ? await listOwnIntegrations(ctx, userId)
      : [await findOwnIntegration(ctx, userId, input.integrationId)];
  const repository = await getSyncRunRepository();
  const runs: SyncRunData[] = [];
  for (const integration of integrations) {
    runs.push(...(await repository.listForIntegration(ctx.id, integration.id, limit)));
  }
  return runs
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map(toSyncRunView);
}

/**
 * One run, by id (the handle "sync now" gave), of one of the member's own integrations; 404
 * otherwise: another member's, another workspace's, or since disconnected.
 */
export async function getSyncRun(
  ctx: WorkspaceContext,
  userId: string,
  runId: string,
): Promise<SyncRunView> {
  const run = await (await getSyncRunRepository()).findById(ctx.id, runId);
  if (run === null) throw new AppError(404, 'Not found');
  await findOwnIntegration(ctx, userId, run.integrationId);
  return toSyncRunView(run);
}
