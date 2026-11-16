/**
 * The hourly budget of creates in providers (H5), for one user, provider and clock hour, across
 * workspaces (a RateLimiter). `reserve` takes a place BEFORE the provider is called, atomically,
 * so parallel requests cannot pass the limit together; `release` gives it back, once, and only
 * for a create that definitely did not happen (one that may have happened keeps its place).
 */
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import { getCreateQuotaRepository } from '../../models/index.js';
import type { RateLimiter } from './contracts.js';

const HOUR_MS = 60 * 60 * 1000;

export class CreateQuota implements RateLimiter {
  readonly #userId: string;
  readonly #provider: string;
  readonly #hourStart: Date;
  readonly #limit: number;
  #reserved = false;

  private constructor(userId: string, provider: string, hourStart: Date, limit: number) {
    this.#userId = userId;
    this.#provider = provider;
    this.#hourStart = hourStart;
    this.#limit = limit;
  }

  /** The budget of `userId`'s creates in `provider` in the clock hour of `now`. */
  static forHour(
    userId: string,
    provider: string,
    now: Date,
    limit: number = LIMITS.providerCreatesPerHour,
  ): CreateQuota {
    const hourStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    return new CreateQuota(userId, provider, hourStart, limit);
  }

  /** Takes a place; false at the limit. */
  async reserve(): Promise<boolean> {
    if (this.#reserved) return true;
    this.#reserved = await (
      await getCreateQuotaRepository()
    ).reserve(this.#userId, this.#provider, this.#hourStart, this.#limit);
    return this.#reserved;
  }

  /** Takes a place, or answers 429 `create_rate_limited` at the limit. */
  async reserveOrRefuse(): Promise<void> {
    if (await this.reserve()) return;
    throw new AppError(429, 'Too many items created in this provider this hour. Try again later.', {
      code: 'create_rate_limited',
    });
  }

  /** Gives the place back (once; never fails the caller). */
  async release(): Promise<void> {
    if (!this.#reserved) return;
    this.#reserved = false;
    await (await getCreateQuotaRepository())
      .release(this.#userId, this.#provider, this.#hourStart)
      .catch(() => undefined);
  }
}
