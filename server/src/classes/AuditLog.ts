/**
 * The audit log (DATA.md §3.10): one entry per audited action, append-only. This class is its
 * only writer: an entry names who acted (the actor's user and agent key, and where the request
 * came from), what was done (`action`, a stable name callers keep), what it was done to (an
 * AuditTarget), and `meta`: names, codes and counts, never a secret or a value the request sent.
 * Entries are never changed; they leave through the 365-day TTL.
 */
import type {
  AuditLogData,
  AuditLogFilter,
  AuditLogRecentQuery,
} from '../models/definitions/AuditLog.js';
import { getAuditLogRepository } from '../models/index.js';
import { Actor, type ActorRef } from './base/Actor.js';
import { AuditTarget } from './base/AuditTarget.js';
import type { Auditable } from './base/contracts.js';
import { WorkspaceEntity } from './base/WorkspaceEntity.js';

/** Where an entry goes and who acted: a Caller is one; so is a workspace with an actor (a job). */
export interface AuditScope {
  readonly workspaceId: string;
  readonly actor: ActorRef;
}

export class AuditLog extends WorkspaceEntity<AuditLogData> {
  private constructor(data: AuditLogData) {
    super(data);
  }

  /**
   * Appends one entry. The actor's address and user agent fill `ip` and `userAgent` (null when
   * the actor came from no request: a job, the sync, a test).
   */
  static async record(
    scope: AuditScope,
    action: string,
    target: Auditable | AuditTarget,
    meta: Record<string, unknown> = {},
  ): Promise<AuditLog> {
    const actor = Actor.from(scope.actor);
    const about = target instanceof AuditTarget ? target : target.auditTarget();
    const stored = await (
      await getAuditLogRepository()
    ).append(scope.workspaceId, {
      actorUserId: actor.userId,
      actorAgentId: actor.agentId,
      action,
      targetType: about.type,
      targetId: about.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      meta,
    });
    return new AuditLog(stored);
  }

  /** Newest first; entries at the same time by id, descending (a stable order to page by). */
  static async list(
    workspaceId: string,
    filter: AuditLogFilter,
    limit: number,
  ): Promise<AuditLog[]> {
    const rows = await (await getAuditLogRepository()).list(workspaceId, filter, limit);
    return rows.map((row) => new AuditLog(row));
  }

  /** The newest entry since `query.since` with that action (and agent, and meta values); or null. */
  static async findRecent(
    workspaceId: string,
    query: AuditLogRecentQuery,
  ): Promise<AuditLog | null> {
    const row = await (await getAuditLogRepository()).findRecent(workspaceId, query);
    return row === null ? null : new AuditLog(row);
  }

  get action(): string {
    return this.data.action;
  }

  /** A user id, or "system". */
  get actorUserId(): string {
    return this.data.actorUserId;
  }

  /** The agent key behind an MCP call; null for the app and the system. */
  get actorAgentId(): string | null {
    return this.data.actorAgentId;
  }

  get targetType(): string | null {
    return this.data.targetType;
  }

  get targetId(): string | null {
    return this.data.targetId;
  }

  /** What the entry is about, when it names one. */
  get target(): AuditTarget | null {
    const { targetType, targetId } = this.data;
    return targetType === null || targetId === null ? null : AuditTarget.of(targetType, targetId);
  }

  get ip(): string | null {
    return this.data.ip;
  }

  get userAgent(): string | null {
    return this.data.userAgent;
  }

  get meta(): Readonly<Record<string, unknown>> {
    return this.data.meta;
  }

  get at(): Date {
    return this.data.at;
  }
}
