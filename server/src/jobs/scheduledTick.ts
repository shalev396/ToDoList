/**
 * The scheduled tick: what the stack's hourly EventBridge rule runs through the `sync-dispatch`
 * action. It dispatches every integration's sync (the "sync all" button), then runs the
 * after-dispatch passes in order. A pass that throws is logged and recorded as failed; the other
 * passes and the tick itself are not affected. A dispatch that throws is logged, the passes still
 * run (travel must not stop because a sync could not be queued), and then the tick throws its
 * error.
 */
import { logger } from '../services/logger.js';
import { dispatchAllSyncs, type DispatchResult } from '../sync/dispatcher.js';
import { TravelHorizonPass } from './TravelHorizonPass.js';

export interface AfterDispatchPass {
  /** Unique; the key of its counts in the tick's result. */
  readonly name: string;
  run(now: Date): Promise<Record<string, number>>;
}

/** Run after every scheduled dispatch, in order. */
export const AFTER_DISPATCH_PASSES: readonly AfterDispatchPass[] = [new TravelHorizonPass()];

export interface ScheduledTickResult {
  dispatch: DispatchResult;
  passes: Record<string, Record<string, number> | { failed: true }>;
}

export async function runScheduledTick(
  options: {
    now?: Date;
    dispatch?: () => Promise<DispatchResult>;
    passes?: readonly AfterDispatchPass[];
  } = {},
): Promise<ScheduledTickResult> {
  const now = options.now ?? new Date();
  const dispatch =
    options.dispatch ?? ((): Promise<DispatchResult> => dispatchAllSyncs('schedule'));
  const passes = options.passes ?? AFTER_DISPATCH_PASSES;

  let dispatched: { ok: true; result: DispatchResult } | { ok: false; error: unknown };
  try {
    dispatched = { ok: true, result: await dispatch() };
  } catch (error) {
    logger.error('scheduled tick: dispatch failed', { error });
    dispatched = { ok: false, error };
  }
  const results: ScheduledTickResult['passes'] = {};
  for (const pass of passes) {
    try {
      results[pass.name] = await pass.run(now);
    } catch (error) {
      logger.error('scheduled tick: pass failed', { pass: pass.name, error });
      results[pass.name] = { failed: true };
    }
  }
  if (!dispatched.ok) throw dispatched.error;
  return { dispatch: dispatched.result, passes: results };
}
