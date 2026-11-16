/** Sync cursor of one integration × resource (DATA.md §3.8), e.g. resource "calendar:<id>". */
export interface SyncStateData {
  id: string;
  workspaceId: string;
  integrationId: string;
  resource: string;
  cursor: string | null;
  syncToken: string | null;
  etag: string | null;
  updatedSince: Date | null;
  lastFullSyncAt: Date | null;
  lastIncrementalAt: Date | null;
  backoffUntil: Date | null;
  consecutiveErrors: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SyncStatePatch {
  cursor?: string | null;
  syncToken?: string | null;
  etag?: string | null;
  updatedSince?: Date | null;
  lastFullSyncAt?: Date | null;
  lastIncrementalAt?: Date | null;
  backoffUntil?: Date | null;
  consecutiveErrors?: number;
}

/** One state's upsert: its integration, its resource, the fields that change. */
export interface SyncStateUpsert {
  integrationId: string;
  resource: string;
  patch: SyncStatePatch;
}

export interface ISyncStateRepository {
  get(workspaceId: string, integrationId: string, resource: string): Promise<SyncStateData | null>;
  /**
   * Creates the state on first use; only the fields given change. The unique index
   * (integrationId, resource) (DATA.md §6) has no `workspaceId`: callers must first resolve the
   * parent integration with a workspace-scoped `findById`.
   */
  upsert(
    workspaceId: string,
    integrationId: string,
    resource: string,
    patch: SyncStatePatch,
  ): Promise<SyncStateData>;
  /** Every state of these integrations (every resource, `__run__` included). Same caveat. */
  listForIntegrations(
    workspaceId: string,
    integrationIds: readonly string[],
  ): Promise<SyncStateData[]>;
  /** upsert() for each entry, in one write, in order (no state is answered). Same caveat. */
  upsertMany(workspaceId: string, entries: readonly SyncStateUpsert[]): Promise<void>;
  /**
   * Counts one failed run toward the failed runs in a row (`consecutiveErrors`), at most once per
   * run: the increment and the run id it counts are one atomic write, so a retry of the run's job
   * never counts it again, and a crash can never leave it marked but not counted. The state
   * remembers the latest COUNTED_RUNS_KEPT run ids. Returns the new count, or null when the run
   * was already counted. Same caveat as upsert: resolve the integration in its workspace first.
   */
  countFailedRun(
    workspaceId: string,
    integrationId: string,
    resource: string,
    runId: string,
  ): Promise<number | null>;
}

/** Run ids a state remembers as counted: far more than a run's job is retried within. */
export const COUNTED_RUNS_KEPT = 20;

export const SYNC_STATE_TABLE_NAME = 'SyncStates';
