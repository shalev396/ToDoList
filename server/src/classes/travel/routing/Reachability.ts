/**
 * Whether a route provider is worth asking now, kept in memory only (never stored): once it was
 * unreachable (no answer in time, a server error, a rate limit), it is not asked again for
 * `quietMs`, so an outage costs one wait instead of one per item write (each waits for its
 * regeneration). A warm Lambda container keeps it between requests; a cold one starts afresh.
 */
import { ProviderHttpError } from '../../../sync/errors.js';

/** How long an unreachable provider is left alone. */
export const UNREACHABLE_QUIET_MS = 60_000;

export class Reachability {
  readonly #quietMs: number;
  readonly #now: () => number;
  #downUntil = 0;

  constructor(quietMs: number = UNREACHABLE_QUIET_MS, now: () => number = Date.now) {
    this.#quietMs = quietMs;
    this.#now = now;
  }

  /** Whether the provider was found unreachable within the last `quietMs`. */
  get down(): boolean {
    return this.#now() < this.#downUntil;
  }

  /**
   * Notes how a call failed: unreachable (no answer, a 5xx, a 429) leaves the provider alone for
   * `quietMs`; any other failure (a route it can't find, a bad request) is the trip's, not the
   * provider's, and changes nothing. Whether it counted as unreachable.
   */
  failed(error: unknown): boolean {
    if (!Reachability.#unreachable(error)) return false;
    this.#downUntil = this.#now() + this.#quietMs;
    return true;
  }

  static #unreachable(error: unknown): boolean {
    if (!(error instanceof ProviderHttpError)) return true;
    return (
      error.code === 'network' ||
      error.code === 'rate_limited' ||
      error.code === 'server_error' ||
      error.status === null ||
      error.status >= 500
    );
  }
}
