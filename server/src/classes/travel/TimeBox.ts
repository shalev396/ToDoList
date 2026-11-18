/**
 * The time one regeneration may spend calling out (a geocode, a route), over its TimeBudget: an
 * item write waits for its regeneration (API Gateway stops a request at 30 s), and the hourly tick
 * runs every member's within the function's 5 minutes. A call starts only while at least
 * TRAVEL_STEP_MIN_MS is left, and its answer is waited for no longer than what is left: past that
 * it counts as no answer, and the regeneration goes on without it (a fallback length, no new
 * place). The call itself is cut off by its client's own timeout (travelHttp.ts).
 */
import type { TimeBudget } from '../integration/calendar/TimeBudget.js';

/** The least time left for a call to start. */
export const TRAVEL_STEP_MIN_MS = 1_000;

/** A call's answer, or none because the budget ran out first (or had no room to start it). */
export type Boxed<T> = { inTime: true; value: T } | { inTime: false };

export class TimeBox {
  readonly #budget: TimeBudget;

  constructor(budget: TimeBudget) {
    this.#budget = budget;
  }

  /** Whether a call may start now. */
  get open(): boolean {
    return this.#budget.canStart(TRAVEL_STEP_MIN_MS);
  }

  /** `call`'s answer within what is left of the budget; its failure is the caller's to catch. */
  async run<T>(call: () => Promise<T>): Promise<Boxed<T>> {
    if (!this.open) return { inTime: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Boxed<T>>((resolve) => {
      timer = setTimeout(() => {
        resolve({ inTime: false });
      }, this.#budget.remainingMs);
    });
    try {
      return await Promise.race([
        call().then((value): Boxed<T> => ({ inTime: true, value })),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
