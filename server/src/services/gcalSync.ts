/**
 * "Sync to Google Calendar": the one sanctioned provider write besides "Also create in",
 * projecting dashboard items onto the member's own calendar through the Calendar API with the
 * account's own OAuth grant (`authMethod: oauth`). A write happens only when a user configures a
 * push and confirms it, and only for a read & write integration (the write gate of
 * GoogleCalendarIntegration: 409 `integration_read_only` otherwise).
 *
 * A push runs in the request (GoogleCalendarIntegration#push): a `SyncRuns` row (trigger
 * `calendar_push`), the diff's ops through the Calendar API, then the commit (gcal/commit.ts:
 * links, audit, the run's counts). Ops left when PUSH_BUDGET_MS runs out wait for the next run.
 *
 * A dry run shows what would be created, updated and removed and writes nothing: allowed for a
 * read-only integration too.
 */
import { z } from 'zod';

import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import {
  Integration,
  isCalendarProvider,
  type CalendarDryRun,
} from '../classes/integration/index.js';
import { AppError } from '../errors/AppError.js';
import { loadPlan, type PlanNarrowing } from '../gcal/plan.js';
import type { WorkspaceContext } from './accessFilter.js';

export const GcalSyncBody = z.strictObject({
  integrationId: z.string().min(1).max(100),
  confirm: z.boolean().optional(),
});

export type GcalDryRun = CalendarDryRun;

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
 * of their own items only (loadPlan, ruling 12). A confirmed push needs it to be read & write
 * (409 `integration_read_only`, before anything is planned or recorded).
 */
export async function gcalSync(
  ctx: WorkspaceContext,
  userId: string,
  input: GcalSyncInput,
  now: Date = new Date(),
): Promise<GcalDryRun | GcalConfirmed> {
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  const integration = await Integration.findOwn(caller, input.integrationId);
  // Its way of connecting must be able to write (the OAuth grant, never the demo's service account).
  if (!isCalendarProvider(integration) || !integration.canCreate) {
    throw new AppError(400, 'This is not a Google Calendar integration that can be written to');
  }
  if (integration.status === 'paused' || integration.status === 'expired') {
    throw new AppError(409, 'This integration waits for its owner: save its credential again');
  }
  const confirm = input.confirm === true;
  if (confirm && input.narrowing !== undefined) {
    throw new AppError(400, 'A filter or range applies to a dry run only');
  }
  if (!confirm) return integration.dryRun(caller, input.narrowing, now);
  integration.assertWritable(caller);
  const plan = await loadPlan(integration.toJSON(), now);
  if (plan.cfg.maxCreates === 0 && plan.skipped.some((entry) => entry.reason === 'daily_cap')) {
    throw new AppError(
      429,
      'The daily limit of new calendar events is used up. Try again tomorrow.',
    );
  }
  return { dryRun: false, runId: await integration.push(caller, { ops: plan.ops, now }) };
}
