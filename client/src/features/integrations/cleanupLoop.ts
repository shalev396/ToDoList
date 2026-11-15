import { cleanupProgressOf } from '../../api/errors.ts';
import type { CleanupProgress } from '@api-types/primaryCalendar.ts';

/** A safety stop: a clean-up never calls the server more often than this in one run. */
export const MAX_CLEANUP_CALLS = 200;

/** How a clean-up run ended: finished, stopped early (and can be continued), or failed. */
export type CleanupRun<T> =
  | {
      kind: 'done';
      value: T;
      /** What the earlier, incomplete calls of this run had already done. */
      totals: CleanupProgress;
    }
  | { kind: 'incomplete'; progress: CleanupProgress }
  | { kind: 'error'; failure: unknown };

export const NO_PROGRESS: CleanupProgress = {
  events: 0,
  calendars: 0,
  calendarsKept: 0,
  remaining: 0,
  skipped: 0,
  failed: 0,
};

/**
 * Whether a call that answered "incomplete" got anywhere: it removed or gave up on something, and
 * (after the first call) fewer steps are left than before. Each call's counts are its own.
 */
export function madeProgress(previous: CleanupProgress | null, next: CleanupProgress): boolean {
  if (next.events + next.calendars + next.failed <= 0) {
    return false;
  }
  return previous === null || next.remaining < previous.remaining;
}

/** The run so far: counts add up across calls; what is left and what was skipped are the latest. */
export function addProgress(total: CleanupProgress, next: CleanupProgress): CleanupProgress {
  return {
    events: total.events + next.events,
    calendars: total.calendars + next.calendars,
    calendarsKept: Math.max(total.calendarsKept, next.calendarsKept),
    remaining: next.remaining,
    skipped: Math.max(total.skipped, next.skipped),
    failed: total.failed + next.failed,
  };
}

/**
 * Calls `step` again by itself while each "cleanup_incomplete" answer made progress. It stops, with
 * the totals so far, on no progress, an error, `shouldContinue()` turning false (Cancel, unmount)
 * or {@link MAX_CLEANUP_CALLS}.
 */
export async function runCleanup<T>(
  step: () => Promise<T>,
  options: {
    shouldContinue: () => boolean;
    onProgress: (total: CleanupProgress) => void;
  },
): Promise<CleanupRun<T>> {
  let total = NO_PROGRESS;
  let previous: CleanupProgress | null = null;
  for (let calls = 1; ; calls += 1) {
    try {
      return { kind: 'done', value: await step(), totals: total };
    } catch (failure) {
      const progress = cleanupProgressOf(failure);
      if (progress === null) {
        return { kind: 'error', failure };
      }
      const moved = madeProgress(previous, progress);
      total = addProgress(total, progress);
      previous = progress;
      if (!moved || calls >= MAX_CLEANUP_CALLS || !options.shouldContinue()) {
        return { kind: 'incomplete', progress: total };
      }
      options.onProgress(total);
    }
  }
}
