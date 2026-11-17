/**
 * The hourly budget of creates in providers (H5): one counter per user, provider and clock hour,
 * across workspaces. Reserved BEFORE the provider is called, atomically, so parallel requests
 * cannot pass the limit together. Removed after its hour (TTL).
 */
export interface ICreateQuotaRepository {
  /** True when a create was reserved (the count was under `limit`); false at the limit. */
  reserve(userId: string, provider: string, hourStart: Date, limit: number): Promise<boolean>;
  /** Gives one reservation back (a create that definitely did not happen). */
  release(userId: string, provider: string, hourStart: Date): Promise<void>;
}

export const CREATE_QUOTA_TABLE_NAME = 'CreateQuotas';
