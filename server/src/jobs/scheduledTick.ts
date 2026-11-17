/**
 * The scheduled tick: what the stack's hourly EventBridge rule runs through the `sync-dispatch`
 * action. It dispatches every integration's sync (the "sync all" button), then runs the
 * after-dispatch passes in order. A pass that throws is logged and recorded as failed; the other
 * passes and the tick itself are not affected.
 */
import { logger } from '../services/logger.js';
import { dispatchAllSyncs, type DispatchResult } from '../sync/dispatcher.js';

export interface AfterDispatchPass {
  /** Unique; the key of its counts in the tick's result. */
  readonly name: string;
  run(now: Date): Promise<Record<string, number>>;
}

/** Run after every scheduled dispatch, in order. Empty until the travel plan adds its horizon pass. */
export const AFTER_DISPATCH_PASSES: readonly AfterDispatchPass[] = [];

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

  const result: ScheduledTickResult = { dispatch: await dispatch(), passes: {} };
  for (const pass of passes) {
    try {
      result.passes[pass.name] = await pass.run(now);
    } catch (error) {
      logger.error('scheduled tick: pass failed', { pass: pass.name, error });
      result.passes[pass.name] = { failed: true };
    }
  }
  return result;
}
