/** One dashboard write, for history and undo (DATA.md §3.12). Immutable. */
export interface DashboardVersionData {
  id: string;
  workspaceId: string;
  dashboardId: string;
  version: number;
  /** RFC 6902 operations. */
  patch: unknown[];
  /** RFC 6902 operations that undo `patch`. */
  inverse: unknown[];
  /** A full copy every 10th version, else null. */
  snapshot: Record<string, unknown> | null;
  actorUserId: string;
  actorAgentId: string | null;
  summary: string | null;
  at: Date;
}

export interface DashboardVersionEntry {
  dashboardId: string;
  version: number;
  patch: unknown[];
  inverse: unknown[];
  snapshot?: Record<string, unknown> | null;
  actorUserId: string;
  actorAgentId?: string | null;
  summary?: string | null;
  /** Default: now. */
  at?: Date;
}

export interface IDashboardVersionRepository {
  /**
   * Throws on a duplicate (dashboardId, version). That unique index (DATA.md §6) has no
   * `workspaceId`: callers must first resolve the parent dashboard with a workspace-scoped
   * `findById`.
   */
  append(workspaceId: string, entry: DashboardVersionEntry): Promise<DashboardVersionData>;
  /** Newest first. */
  list(workspaceId: string, dashboardId: string, limit: number): Promise<DashboardVersionData[]>;
  findByVersion(
    workspaceId: string,
    dashboardId: string,
    version: number,
  ): Promise<DashboardVersionData | null>;
  /**
   * Deletes every version except the newest `keepLatest` and those listed in `keepVersions`
   * (e.g. published ones). Returns how many were deleted.
   */
  pruneKeeping(
    workspaceId: string,
    dashboardId: string,
    keepLatest: number,
    keepVersions: readonly number[],
  ): Promise<number>;
}

export const DASHBOARD_VERSION_TABLE_NAME = 'DashboardVersions';
