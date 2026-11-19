/**
 * The daily travel pass (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Generation and
 * lifecycle"; plan Ruling 12), run by the hourly tick after the sync dispatch: each member with
 * travel gets their 14-day horizon made again once a day (in their workspace's zone), so days
 * coming into range get their legs. It stops starting regenerations once its budget can't fit
 * another; the members it doesn't reach run on the next tick.
 *
 * The budget: the function's timeout is 5 minutes (server/infra compute.ts, SYNC_JOB_TIMEOUT) and
 * the dispatch before it only queues one async invoke per integration (seconds), so two minutes
 * for this pass leave well over the 20 s of slack the tick needs.
 */
import { TimeBudget } from '../classes/integration/calendar/TimeBudget.js';
import { TravelPlanner } from '../classes/travel/index.js';
import type { AfterDispatchPass } from './scheduledTick.js';

/** How long one tick's travel pass may start regenerations for. */
export const TRAVEL_PASS_BUDGET_MS = 120_000;

export class TravelHorizonPass implements AfterDispatchPass {
  readonly name = 'travel-pass';

  /** `{ done, left }`: members made again today by this run, and those left for the next. */
  run(now: Date): Promise<Record<string, number>> {
    return TravelPlanner.runDailyPass(now, TimeBudget.start(TRAVEL_PASS_BUDGET_MS));
  }
}
