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

import { Actor } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import { Integration, type SyncRequestOutcome } from '../classes/integration/index.js';
import { NotFoundError } from '../errors/NotFoundError.js';
import type { ErrorInfo } from '../models/definitions/common.js';
import type { SyncRunData } from '../models/definitions/SyncRun.js';
import { getSyncRunRepository } from '../models/index.js';
import { SYNC_ERROR_MESSAGES } from '../sync/runSync.js';
import type { SyncRunView } from '../types/integrations.js';

export const SYNC_RUNS_DEFAULT_LIMIT = 20;
export const SYNC_RUNS_MAX_LIMIT = 100;

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const COUNT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** `GET …/sync-runs?integrationId&limit`. */
export const SyncRunsQuery = z.strictObject({
  integrationId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SYNC_RUNS_MAX_LIMIT).optional(),
});

export type { SyncRequestOutcome } from '../classes/integration/index.js';

/**
 * "Sync now" for one of the member's own integrations (404 otherwise): Integration#requestSync.
 * 409 while it waits for them; `{retryAfterMs}` while a manual sync of it is less than the interval
 * old.
 */
export async function requestIntegrationSync(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<SyncRequestOutcome> {
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  return (await Integration.findOwn(caller, integrationId)).requestSync(caller);
}

/**
 * "Sync now" for every integration the member owns here and can sync (Integration.requestSyncAll).
 * Those waiting for them or synced manually less than the interval ago are skipped. 503 only when
 * nothing could be queued because the queue failed.
 */
export async function requestWorkspaceSync(
  ctx: WorkspaceContext,
  userId: string,
): Promise<{ runIds: string[] }> {
  return Integration.requestSyncAll(Caller.fromContext(ctx, Actor.user(userId)));
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
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  const integrations =
    input.integrationId === undefined
      ? await Integration.listOwn(caller)
      : [await Integration.findOwn(caller, input.integrationId)];
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
  if (run === null) throw new NotFoundError();
  await Integration.findOwn(Caller.fromContext(ctx, Actor.user(userId)), run.integrationId);
  return toSyncRunView(run);
}
