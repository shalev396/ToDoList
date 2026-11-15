/**
 * The dispatched Google Calendar sync for OAuth integrations (TODO B7): the same push and two-way
 * pull as the manual `gcal-sync` (GoogleCalendarIntegration#push), for every eligible integration
 * at once (the `gcal-dispatch` action; no schedule invokes it for now), so Google-side edits and
 * deletes are picked up without waiting for a push. Only the integration the workspace's primary
 * calendar is on is pushed, and only while that primary calendar is active: a read-only
 * integration (the primary calendar suspended) is not eligible.
 *
 * The per-day create cap (4,000) and `maxOpsPerRun` apply as in the manual path (both live in
 * loadPlan). Each `gcal-run` job carries the integration id only (services/syncJobs.ts).
 */
import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import { Integration, isCalendarProvider } from '../classes/integration/index.js';
import { Workspace } from '../classes/workspace/index.js';
import { AppError } from '../errors/AppError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import { logger } from '../services/logger.js';
import { loadPlan } from './plan.js';

/**
 * Whether the dispatch may sync this integration, as stored: a live, read & write Google Calendar
 * OAuth integration with a credential, not paused, expired or failed on auth. That it is the
 * workspace's primary calendar is checked apart (isGcalScheduleTarget).
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
    integration.lastError?.code !== 'auth_failed'
  );
}

/** Eligible, and the integration the workspace's active primary calendar is on. */
async function isGcalScheduleTarget(integration: IntegrationData): Promise<boolean> {
  if (!isGcalScheduleEligible(integration)) return false;
  const status = await Workspace.primaryCalendarStatusOf(integration.workspaceId);
  return status.isActive && status.primary?.isOn(integration.id) === true;
}

/** Every integration the dispatch would sync now. */
export async function listGcalScheduleTargets(): Promise<IntegrationData[]> {
  const targets: IntegrationData[] = [];
  for (const integration of await Integration.listForDispatch()) {
    const data = integration.toJSON();
    if (await isGcalScheduleTarget(data)) targets.push(data);
  }
  return targets;
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
    !(await isGcalScheduleTarget(integration.toJSON()))
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
    return {
      ran: true,
      runId: await integration.push(caller, {
        ops: plan.ops,
        now,
        calendarId: plan.cfg.calendarId,
      }),
    };
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
