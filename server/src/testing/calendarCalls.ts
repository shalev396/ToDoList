/**
 * The calendar push's old entry points, one line each over the classes, for the suites written
 * against them (the call shapes and the assertions stay the same): `loadPlan` is
 * Calendar.primaryFor + Calendar#plan (as plain data), `applyCommit` is PushCommit.apply.
 *
 * Import it dynamically, after the test database is up, like the modules it stands for.
 */
import { Calendar } from '../classes/calendar/Calendar.js';
import { PushCommit, type CommitCounts } from '../classes/calendar/PushCommit.js';
import type { LoadedPlan, PlanNarrowing } from '../classes/calendar/PushPlan.js';
import type { TimeBudget } from '../classes/integration/calendar/TimeBudget.js';
import type { IntegrationData } from '../models/definitions/Integration.js';

export { DAILY_CREATE_CAP } from '../classes/calendar/Calendar.js';
export { toPushItem, type CommitCounts } from '../classes/calendar/PushCommit.js';

export async function loadPlan(
  integration: IntegrationData,
  now: Date,
  narrowing?: PlanNarrowing,
  budget?: TimeBudget,
): Promise<LoadedPlan> {
  return (await (await Calendar.primaryFor(integration)).plan(now, narrowing, budget)).toJSON();
}

export function applyCommit(
  integration: IntegrationData,
  input: unknown,
  now?: Date,
  pushedTo?: string,
): Promise<CommitCounts> {
  return PushCommit.apply(integration, input, now, pushedTo);
}
