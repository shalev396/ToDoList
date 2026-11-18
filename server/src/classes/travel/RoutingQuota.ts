/**
 * The daily budget of OpenRouteService calls of one workspace (the free key every member shares;
 * spec "Shared free quota"): at most ROUTING_CALLS_PER_DAY a day, reserved BEFORE a call is made,
 * atomically, so parallel regenerations cannot pass it together; past it, legs use the remembered
 * length or the straight line. It also keeps the day's lengths by trip and where its ends are, so a
 * trip asked again that day is not fetched twice, and one whose place was corrected is fetched
 * again. One document per workspace and day, removed two days later (TTL).
 */
import { getRoutingQuotaRepository } from '../../models/index.js';
import { ROUTING_CALLS_PER_DAY } from '../../types/travel.js';
import type { RoutingBudget } from './routing/RouteProvider.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class RoutingQuota implements RoutingBudget {
  readonly #workspaceId: string;
  readonly #day: string;

  private constructor(workspaceId: string, day: string) {
    this.#workspaceId = workspaceId;
    this.#day = day;
  }

  /** The workspace's budget on `day` (`YYYY-MM-DD`). */
  static for(workspaceId: string, day: string): RoutingQuota {
    if (!DAY_PATTERN.test(day)) throw new Error('RoutingQuota: day must be YYYY-MM-DD');
    return new RoutingQuota(workspaceId, day);
  }

  async cachedSeconds(key: string): Promise<number | null> {
    return (await getRoutingQuotaRepository()).cachedSeconds(this.#workspaceId, this.#day, key);
  }

  async rememberSeconds(key: string, seconds: number): Promise<void> {
    await (
      await getRoutingQuotaRepository()
    ).rememberSeconds(this.#workspaceId, this.#day, key, seconds);
  }

  /** Takes one call from the day's budget; false once ROUTING_CALLS_PER_DAY are taken. */
  async reserve(): Promise<boolean> {
    return (await getRoutingQuotaRepository()).reserve(
      this.#workspaceId,
      this.#day,
      ROUTING_CALLS_PER_DAY,
    );
  }
}
