/**
 * "Sync now" and the sync-run history (BACKEND.md §4, DATA.md §3.9). Thin functions over the
 * classes (Integration, SyncRun): no Express, no database.
 *
 * - A manual sync goes through SyncRun.request (202 with the run id; the engine runs it).
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
import { SyncRun } from '../classes/sync/SyncRun.js';
import type { SyncRunView } from '../types/integrations.js';

export const SYNC_RUNS_DEFAULT_LIMIT = 20;
export const SYNC_RUNS_MAX_LIMIT = 100;

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

// ─── History (SyncRun#toView: counts as named numbers, an error as a code and its fixed
// message, never the failed records) ─────────────────────────────────────────

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
  return (await SyncRun.list(caller, integrations, limit)).map((run) => run.toView());
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
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  const run = await SyncRun.get(caller, runId);
  await Integration.findOwn(caller, run.integrationId);
  return run.toView();
}
