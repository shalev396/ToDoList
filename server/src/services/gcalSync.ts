/**
 * "Sync to Google Calendar": projecting the workspace's dated items onto its primary calendar
 * (plan Addendum A2) through the Calendar API, with the OAuth grant of the integration that
 * calendar is on (`authMethod: oauth`). Only that integration's owner pushes, only to that
 * calendar (409 `calendar_not_primary` for any other integration), and only while it is read &
 * write (the write gate of GoogleCalendarIntegration: 409 `integration_read_only` otherwise).
 *
 * A push runs in the request (GoogleCalendarIntegration#push): a SyncRun (trigger
 * `calendar_push`), the diff's ops through the Calendar API, then the commit (Calendar#commit:
 * links, audit, the run's counts). Ops left when PUSH_BUDGET_MS runs out wait for the next run.
 *
 * A dry run shows what would be created, updated and removed and writes nothing: allowed for a
 * read-only integration too.
 */
import { z } from 'zod';

import type { Caller } from '../classes/base/Caller.js';
import {
  Integration,
  isCalendarProvider,
  type CalendarDryRun,
} from '../classes/integration/index.js';
import { Calendar } from '../classes/calendar/Calendar.js';
import type { PlanNarrowing } from '../classes/calendar/PushPlan.js';
import { AppError } from '../errors/AppError.js';
import { TimeBudget, WRITE_BUDGET_MS } from '../classes/integration/calendar/TimeBudget.js';

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
 * A push to the workspace's primary calendar, on the member's own Google Calendar integration
 * (404 for another member's, ruling 1; 409 `calendar_not_primary` when the primary calendar is
 * not on it), of the dated items its owner may see (Calendar#plan). A confirmed push needs it to be
 * read & write (409 `integration_read_only`, before anything is planned or recorded).
 */
export async function gcalSync(
  caller: Caller,
  input: GcalSyncInput,
  now: Date = new Date(),
): Promise<GcalDryRun | GcalConfirmed> {
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
  // One budget for the whole request: the plan, the writes and the pull share it.
  const budget = TimeBudget.start(WRITE_BUDGET_MS);
  const plan = await (await Calendar.primaryFor(integration.toJSON())).plan(now, undefined, budget);
  if (plan.dailyCapReached) {
    throw new AppError(
      429,
      'The daily limit of new calendar events is used up. Try again tomorrow.',
    );
  }
  return {
    dryRun: false,
    runId: await integration.push(caller, {
      ops: plan.ops,
      now,
      calendarId: plan.calendarId,
      budget,
    }),
  };
}
