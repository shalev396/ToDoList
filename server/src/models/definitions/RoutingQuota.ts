/**
 * The daily budget of OpenRouteService calls of one workspace (the free key every member shares),
 * with the lengths fetched that day so a trip asked again is not fetched twice. One document per
 * workspace and day (`_id`: `<workspaceId>|<YYYY-MM-DD>`), removed two days after its day (TTL).
 * A call is reserved BEFORE it is made, atomically, so parallel regenerations cannot pass the
 * limit together.
 */
export interface IRoutingQuotaRepository {
  /** True when a call was reserved (the day's count was under `limit`); false at the limit. */
  reserve(workspaceId: string, day: string, limit: number): Promise<boolean>;
  /** The length fetched that day for this trip (`from|to|mode`), in seconds; null if none. */
  cachedSeconds(workspaceId: string, day: string, tripKey: string): Promise<number | null>;
  rememberSeconds(
    workspaceId: string,
    day: string,
    tripKey: string,
    seconds: number,
  ): Promise<void>;
  /** The workspace was deleted: its days' documents. Returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

export const ROUTING_QUOTA_TABLE_NAME = 'RoutingQuotas';
