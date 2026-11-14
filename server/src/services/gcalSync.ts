/**
 * "Sync to Google Calendar": the one sanctioned provider write, projecting dashboard items onto
 * the member's own calendar through the Calendar API with the account's own OAuth grant
 * (`authMethod: oauth`). A write happens only when a user configures a push and confirms it.
 *
 * A push runs here, in the request: a `SyncRuns` row (trigger `calendar_push`), the diff's ops
 * through the Calendar API (gcal/oauthCalendar.ts), then the commit (gcal/commit.ts: links, audit,
 * the run's counts). Ops left when PUSH_BUDGET_MS runs out wait for the next run.
 *
 * A dry run shows what would be created, updated and removed and writes nothing.
 */
import { z } from 'zod';

import { AppError } from '../errors/AppError.js';
import { applyCommit } from '../gcal/commit.js';
import { PAST_WINDOW_DAYS, type PlanEntry, type SkippedItem, type WireOp } from '../gcal/diff.js';
import {
  pullOwnEventsWithOAuth,
  pushOpsWithOAuth,
  type OpResult,
  type PulledCalendar,
} from '../gcal/oauthCalendar.js';
import { loadPlan, readGcalConfig, type PlanNarrowing } from '../gcal/plan.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import {
  getIntegrationRepository,
  getSyncRunRepository,
  getSyncStateRepository,
} from '../models/index.js';
import { ProviderHttpError } from '../sync/http.js';
import { logger } from './logger.js';
import type { WorkspaceContext } from './accessFilter.js';
import { findOwnIntegration } from './integrationOwnership.js';

export const GcalSyncBody = z.strictObject({
  integrationId: z.string().min(1).max(100),
  confirm: z.boolean().optional(),
});

export interface GcalDryRun {
  dryRun: true;
  counts: { create: number; update: number; remove: number };
  entries: PlanEntry[];
  skipped: SkippedItem[];
}

export interface GcalConfirmed {
  dryRun: false;
  runId: string;
}

export interface GcalSyncInput {
  integrationId: string;
  confirm?: boolean | undefined;
  /** Narrows a dry run to some items (the MCP tool); a confirmed run never takes it. */
  narrowing?: PlanNarrowing | undefined;
}

/**
 * A push to the member's own Google Calendar integration (404 for another member's, ruling 1),
 * of their own items only (loadPlan, ruling 12).
 */
export async function gcalSync(
  ctx: WorkspaceContext,
  userId: string,
  input: GcalSyncInput,
  now: Date = new Date(),
): Promise<GcalDryRun | GcalConfirmed> {
  const integration = await findOwnIntegration(ctx, userId, input.integrationId);
  if (integration.provider !== 'google_calendar' || integration.authMethod !== 'oauth') {
    throw new AppError(400, 'This is not a Google Calendar integration that can be written to');
  }
  if (integration.status === 'paused' || integration.status === 'expired') {
    throw new AppError(409, 'This integration waits for its owner: save its credential again');
  }
  const confirm = input.confirm === true;
  if (confirm && input.narrowing !== undefined) {
    throw new AppError(400, 'A filter or range applies to a dry run only');
  }
  const plan = await loadPlan(integration, now, input.narrowing);
  if (!confirm) {
    return { dryRun: true, counts: plan.counts, entries: plan.entries, skipped: plan.skipped };
  }
  if (plan.cfg.maxCreates === 0 && plan.skipped.some((entry) => entry.reason === 'daily_cap')) {
    throw new AppError(
      429,
      'The daily limit of new calendar events is used up. Try again tomorrow.',
    );
  }
  return { dryRun: false, runId: await pushWithOAuth(integration, plan.ops, now) };
}

/** How long one OAuth push may write; the rest waits for the next run (API Gateway stops at 30 s). */
export const PUSH_BUDGET_MS = 20_000;

async function pullAfterPush(integration: IntegrationData, now: Date): Promise<PulledCalendar[]> {
  const target = readGcalConfig(integration).targetCalendarId;
  if (target === null) return [];
  try {
    const state = await (
      await getSyncStateRepository()
    ).get(integration.workspaceId, integration.id, `gcal:${target}`);
    const timeMin = new Date(now.getTime() - PAST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    return await pullOwnEventsWithOAuth(
      integration,
      [{ id: target, syncToken: state?.syncToken ?? null }],
      timeMin,
    );
  } catch (error) {
    logger.warn('A Google Calendar pull failed', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return [];
  }
}

/** An OAuth push, start to commit. Returns the run's id. 409 to reconnect, 502 when Google is silent. */
export async function pushWithOAuth(
  integration: IntegrationData,
  ops: readonly WireOp[],
  now: Date,
): Promise<string> {
  const { workspaceId } = integration;
  const runs = await getSyncRunRepository();
  const run = await runs.create(workspaceId, {
    integrationId: integration.id,
    trigger: 'calendar_push',
    status: 'running',
    startedAt: now,
  });
  let opResults: OpResult[];
  try {
    opResults = await pushOpsWithOAuth(integration, ops, Date.now() + PUSH_BUDGET_MS);
  } catch (error) {
    const authFailed = error instanceof ProviderHttpError && error.code === 'auth_failed';
    await runs.updateIfStatus(workspaceId, run.id, ['running'], {
      status: 'failed',
      finishedAt: new Date(),
      error: authFailed
        ? { code: 'auth_failed', message: 'Reconnect required' }
        : { code: 'calendar_unreachable', message: 'Google Calendar did not answer' },
    });
    if (authFailed) {
      // As a sync would: the integration waits for its owner to reconnect.
      await (
        await getIntegrationRepository()
      ).recordSyncResult(workspaceId, integration.id, {
        status: 'error',
        lastError: { code: 'auth_failed', message: 'Reconnect required' },
      });
      throw new AppError(409, 'Google refused the connection: reconnect Google Calendar');
    }
    logger.warn('A Google Calendar push failed', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, 'Google Calendar did not answer. Try again in a moment.');
  }
  // The pull that follows the writes (their etags are the links' by then, so our echoes are
  // skipped): Google-side edits and deletes of what we pushed. A failed pull never fails the push;
  // the token is kept and the next run lists again.
  const calendars = await pullAfterPush(integration, now);
  await applyCommit(integration, { runId: run.id, opResults, calendars }, new Date());
  return run.id;
}
