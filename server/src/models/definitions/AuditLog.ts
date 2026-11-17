/**
 * One audited action (DATA.md §3.10). Append-only: there is no update or delete. `meta` is
 * redacted by the caller (MCP calls store `{argsHash, resultStatus}`, never raw arguments).
 */
export interface AuditLogData {
  id: string;
  workspaceId: string;
  /** A user id, or "system". */
  actorUserId: string;
  /** The agent key behind an MCP call; null for the UI and the system. */
  actorAgentId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: Record<string, unknown>;
  at: Date;
}

export interface AuditLogEntry {
  actorUserId: string;
  actorAgentId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
  /** Default: now. */
  at?: Date;
}

export interface AuditLogFilter {
  actorAgentId?: string;
  action?: string;
  since?: Date;
  /**
   * Paging: only entries that come after this one in the list order (older, or as old with a
   * lower id), so a page boundary inside a run of same-time entries loses nothing.
   */
  before?: { at: Date; id: string };
}

export interface AuditLogRecentQuery {
  action: string;
  actorAgentId?: string;
  /** Exact `meta.<key>` values, e.g. `{ idempotencyKey }`. Keys are plain names. */
  metaEquals: Record<string, string>;
  since: Date;
}

export interface IAuditLogRepository {
  append(workspaceId: string, entry: AuditLogEntry): Promise<AuditLogData>;
  /** append() for each entry, in one write, in order. */
  appendMany(workspaceId: string, entries: readonly AuditLogEntry[]): Promise<AuditLogData[]>;
  /** Newest first; entries at the same time by id, descending (a stable order to page by). */
  list(workspaceId: string, filter: AuditLogFilter, limit: number): Promise<AuditLogData[]>;
  /** The newest entry since `since` matching the action, agent and meta values; or null. */
  findRecent(workspaceId: string, query: AuditLogRecentQuery): Promise<AuditLogData | null>;
}

export const AUDIT_LOG_TABLE_NAME = 'AuditLogs';
