/**
 * The dispatched Google Calendar sync for OAuth integrations (TODO B7): the same push and two-way
 * pull as the manual `gcal-sync` (GoogleCalendarIntegration#push), for every eligible integration
 * at once (the `gcal-dispatch` action; no schedule invokes it for now), so Google-side edits and
 * deletes are picked up without waiting for a push. A read-only integration is never pushed: it
 * is not eligible.
 *
 * The per-day create cap (4,000) and `maxOpsPerRun` apply as in the manual path (both live in
 * loadPlan). Each `gcal-run` job carries the integration id only (services/syncJobs.ts).
 */
import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import { Integration, isCalendarProvider } from '../classes/integration/index.js';
import { AppError } from '../errors/AppError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import { logger } from '../services/logger.js';
import { loadPlan, readGcalConfig } from './plan.js';

/**
 * Whether the dispatch may sync this integration: a live, read & write Google Calendar OAuth
 * integration with a credential and a push target, not paused, expired or failed on auth.
 */
export function isGcalScheduleEligible(integration: IntegrationData): boolean {
  return (
    integration.deletedAt === null &&
    integration.provider === 'google_calendar' &&
    integration.authMethod === 'oauth' &&
    integration.mode === 'read_write' &&
    integration.credentialId !== null &&
    (integration.status === 'active' ||
      integration.status === 'expiring' ||
      integration.status === 'error') &&
    integration.lastError?.code !== 'auth_failed' &&
    readGcalConfig(integration).targetCalendarId !== null
  );
}

/** Every integration the dispatch would sync now. */
export async function listGcalScheduleTargets(): Promise<IntegrationData[]> {
  return (await Integration.listForDispatch())
    .map((integration) => integration.toJSON())
    .filter(isGcalScheduleEligible);
}

export type ScheduledGcalOutcome =
  | { ran: true; runId: string }
  | { ran: false; reason: 'not_eligible' | 'refused' | 'failed' };

/** One scheduled run: re-checks eligibility (the integration may have changed since queued). */
export async function runScheduledGcalSync(
  integrationId: string,
  now: Date = new Date(),
): Promise<ScheduledGcalOutcome> {
  const integration = await Integration.forWorker(integrationId);
  if (
    integration === null ||
    !isCalendarProvider(integration) ||
    !isGcalScheduleEligible(integration.toJSON())
  ) {
    return { ran: false, reason: 'not_eligible' };
  }
  try {
    // The ops are capped by maxOpsPerRun and the day's remaining creates (loadPlan); with the cap
    // used up only updates and removals go out, and the pull still runs.
    const plan = await loadPlan(integration.toJSON(), now);
    // The push is its owner's, on schedule: it runs as them, under the same write gate.
    const caller = await Caller.enter(integration.workspaceId, Actor.user(integration.ownerUserId));
    if (caller === null) {
      throw new AppError(409, 'The member who connected this integration is gone');
    }
    return { ran: true, runId: await integration.push(caller, { ops: plan.ops, now }) };
  } catch (error) {
    if (error instanceof AppError) {
      // 409 (reconnect needed, read-only, or the member is gone) and 502 (Google silent): the push
      // recorded it on its run; the next schedule tries again.
      logger.warn('A scheduled calendar sync did not run', {
        integrationId,
        statusCode: error.statusCode,
      });
      return { ran: false, reason: error.statusCode === 502 ? 'failed' : 'refused' };
    }
    throw error;
  }
}
