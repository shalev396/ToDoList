import type { Provider } from '../../types/domain.js';

/** Where a mirrored item or container comes from (`source` on Items and Containers, DATA.md §3.6). */
export interface SourceRef {
  provider: Provider;
  /** Account on the provider side (see Integrations.accountId); '' for local items. */
  accountId: string;
  externalId: string;
  key: string | null;
  url: string;
  updatedAtSource: Date | null;
  etag: string | null;
  /** SHA-1 of the mapped fields: when it is unchanged, a sync write only touches `lastSeenAt`. */
  hash: string | null;
}

/** The provider account half of the natural key: with an external id, it names a record. */
/**
 * One integration's copy of a provider account (PERMISSIONS-V2 ruling 8): two members who connect
 * the same account each keep their own copies, so the integration is part of the key.
 */
export type SourceAccount = Pick<SourceRef, 'provider' | 'accountId'> & { integrationId: string };

/** What a delete-only write (softDeleteBySource) did. */
export interface SourceDeleteResult {
  /** Live stored copies now deleted. */
  deleted: number;
  /** Stored copies that were deleted already: left as they were, `deletedAt` kept. */
  alreadyDeleted: number;
}

/** A redacted error: `Integrations.lastError` and `SyncRuns.error`. */
export interface ErrorInfo {
  code: string;
  message: string;
}

/** Options of a repository aggregate(): a server-side time limit, in milliseconds. */
export interface AggregateOptions {
  maxTimeMS?: number;
}

/** Options of a per-resource deletion sweep (Items and Containers `sweepUnseen`). */
export interface SweepOptions {
  /** The deletion time written (default now). */
  deletedAt?: Date;
  /**
   * External ids never swept: records the run failed to store. A failure is not a deletion, so
   * their stored copies keep `lastSeenAt` and stay live.
   */
  keepExternalIds?: readonly string[];
}

/**
 * What a natural-key bulk upsert did (DATA.md §4). `unchanged`: same `source.hash`, or a delete
 * signalled again for a copy already deleted.
 */
export interface BulkUpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}
