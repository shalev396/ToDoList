/**
 * How long one request may spend writing at Google (a push, a clean-up), as an immutable value
 * object: API Gateway stops a request at 29 s, so the work stops at the budget and what is left
 * waits for the next run (or the next call).
 */

/** The budget of one push or clean-up. */
export const WRITE_BUDGET_MS = 20_000;

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

  /** The deadline, in epoch ms (what applyOps takes). */
  get deadline(): number {
    return this.#deadline;
  }

  get exhausted(): boolean {
    return this.#now() >= this.#deadline;
  }
}
