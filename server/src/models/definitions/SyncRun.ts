import type { SyncRunStatus, SyncTrigger } from '../../types/domain.js';
import type { ErrorInfo } from './common.js';

/**
 * A provider record a sync skipped (an item-level failure, BACKEND.md §12): its provider id and a
 * code, e.g. `missing_url`. Never provider text.
 */
export interface SyncRunFailure {
  externalId: string;
  code: string;
}

/** One sync of one integration (DATA.md §3.9). Removed 30 days later (TTL on `expireAt`). */
export interface SyncRunData {
  id: string;
  workspaceId: string;
  integrationId: string;
  trigger: SyncTrigger;
  /** When the run was created (queued), unless set otherwise. */
  startedAt: Date;
  finishedAt: Date | null;
  status: SyncRunStatus;
  /** e.g. `{ fetched, inserted, updated, closed, deleted }`. */
  counts: Record<string, number>;
  error: ErrorInfo | null;
  /** The first records the run skipped (the engine keeps 50); `counts.failed` has the total. */
  failures: SyncRunFailure[];
  expireAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSyncRunInput {
  integrationId: string;
  trigger: SyncTrigger;
  /** Default `queued`. */
  status?: SyncRunStatus;
  startedAt?: Date;
}

export interface SyncRunPatch {
  status?: SyncRunStatus;
  startedAt?: Date;
  finishedAt?: Date | null;
  counts?: Record<string, number>;
  error?: ErrorInfo | null;
  failures?: SyncRunFailure[];
}

export interface ISyncRunRepository {
  create(workspaceId: string, input: CreateSyncRunInput): Promise<SyncRunData>;
  update(workspaceId: string, id: string, patch: SyncRunPatch): Promise<SyncRunData | null>;
  /**
   * update(), only while the run's status is one of `statuses` (one conditional write): ends a run
   * nobody finished meanwhile. Null when it has another status, or is not found.
   */
  updateIfStatus(
    workspaceId: string,
    id: string,
    statuses: readonly SyncRunStatus[],
    patch: SyncRunPatch,
  ): Promise<SyncRunData | null>;
  /**
   * GLOBAL, every workspace: the nightly purge job (jobs/purge.ts) only. Runs still `running` that
   * started before `before`, oldest first, at most `limit`.
   */
  listRunningStartedBefore(before: Date, limit: number): Promise<SyncRunData[]>;
  findById(workspaceId: string, id: string): Promise<SyncRunData | null>;
  /** Newest first. */
  listForIntegration(
    workspaceId: string,
    integrationId: string,
    limit: number,
  ): Promise<SyncRunData[]>;
}

export const SYNC_RUN_TABLE_NAME = 'SyncRuns';
