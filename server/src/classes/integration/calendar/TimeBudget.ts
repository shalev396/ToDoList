/**
 * How long one request may spend at Google (a push with its plan and pull, a clean-up), as an
 * immutable value object made once per request and handed through all of it: API Gateway stops a
 * request at 29 s. A provider call starts only while at least STEP_CEILING_MS (the longest one
 * call may take: the calendar client's timeout) is left, so the last call still ends inside the
 * budget, and what is left waits for the next run (or the next call).
 *
 * With WRITE_BUDGET_MS = 20 s, calls start during the first 12 s and end by 20 s: a disconnect's
 * clean-up then leaves room for the grant's revoke and the rest of the request.
 */

/** The budget of one push (its plan included) or one clean-up. */
export const WRITE_BUDGET_MS = 20_000;

/** The longest one Calendar API call may take (calendarApi.ts's timeout). */
export const STEP_CEILING_MS = 8_000;

export class TimeBudget {
  readonly #deadline: number;
  readonly #now: () => number;

  private constructor(deadline: number, now: () => number) {
    this.#deadline = deadline;
    this.#now = now;
    Object.freeze(this);
  }

  /** A budget of `ms` from now. */
  static start(ms: number, now: () => number = Date.now): TimeBudget {
    return new TimeBudget(now() + ms, now);
  }

  /** The deadline, in epoch ms. */
  get deadline(): number {
    return this.#deadline;
  }

  /** What is left, in ms (never below 0). */
  get remainingMs(): number {
    return Math.max(0, this.#deadline - this.#now());
  }

  get exhausted(): boolean {
    return this.remainingMs === 0;
  }

  /** Whether a step that may take `ceilingMs` can start and still end inside the budget. */
  canStart(ceilingMs: number = STEP_CEILING_MS): boolean {
    return this.#deadline - this.#now() >= ceilingMs;
  }
}
