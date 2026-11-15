/**
 * The audit log (DATA.md §3.10): one entry per audited action, append-only. This class is its
 * only writer: an entry names who acted (the actor's user and agent key, and where the request
 * came from), what was done (`action`, a stable name callers keep), what it was done to (an
 * AuditTarget), and `meta`: names, codes and counts, never a secret or a value the request sent.
 * Entries are never changed; they leave through the 365-day TTL.
 */
import { AppError } from '../errors/AppError.js';
import type {
  AuditLogData,
  AuditLogFilter,
  AuditLogRecentQuery,
} from '../models/definitions/AuditLog.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import { getAuditLogRepository, getIntegrationRepository } from '../models/index.js';
import { Actor, type ActorRef } from './base/Actor.js';
import { AuditTarget } from './base/AuditTarget.js';
import type { Auditable } from './base/contracts.js';
import { WorkspaceEntity } from './base/WorkspaceEntity.js';

/** Where an entry goes and who acted: a Caller is one; so is a workspace with an actor (a job). */
export interface AuditScope {
  readonly workspaceId: string;
  readonly actor: ActorRef;
}

/** One page of the log, newest first: the filters, where to start (a cursor), how many. */
export interface AuditPageQuery {
  actorAgentId?: string | undefined;
  action?: string | undefined;
  since?: Date | undefined;
  /** The nextCursor of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

/** What a page tells of an integration an entry is about: whose it is, and its provider. */
export type AuditedIntegration = Pick<IntegrationData, 'id' | 'provider' | 'ownerUserId'>;

/** AuditPage's maker, handed to this module by the class itself: only AuditLog.page makes one. */
let newAuditPage: (
  entries: readonly AuditLog[],
  nextCursor: string | null,
  integrations: ReadonlyMap<string, AuditedIntegration>,
) => AuditPage;

/**
 * One page of the audit log, as a value: its entries (newest first), the cursor of the next page
 * (null at the end), and the integrations its entries are about (deleted ones too), so a reader
 * can apply who may see what of them. Immutable (the entries are entities, frozen inside; the
 * list and each integration are frozen); only AuditLog.page makes one.
 */
export class AuditPage {
  static {
    newAuditPage = (entries, nextCursor, integrations): AuditPage =>
      new AuditPage(entries, nextCursor, integrations);
  }

  readonly #entries: readonly AuditLog[];
  readonly #nextCursor: string | null;
  readonly #integrations: ReadonlyMap<string, Readonly<AuditedIntegration>>;

  private constructor(
    entries: readonly AuditLog[],
    nextCursor: string | null,
    integrations: ReadonlyMap<string, AuditedIntegration>,
  ) {
    this.#entries = Object.freeze([...entries]);
    this.#nextCursor = nextCursor;
    this.#integrations = new Map(
      [...integrations].map(([id, integration]) => [id, Object.freeze({ ...integration })]),
    );
    Object.freeze(this);
  }

  get entries(): readonly AuditLog[] {
    return this.#entries;
  }

  get nextCursor(): string | null {
    return this.#nextCursor;
  }

  /** The integration this entry is an event of, when it is one and still known. */
  integrationOf(entry: AuditLog): Readonly<AuditedIntegration> | undefined {
    const id = entry.integrationId;
    return id === null ? undefined : this.#integrations.get(id);
  }
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

  /** An opaque page position: the entry's time and id. */
  static #encodeCursor(entry: AuditLog): string {
    return Buffer.from(
      JSON.stringify({ at: entry.at.toISOString(), id: entry.id }),
      'utf8',
    ).toString('base64url');
  }

  static #decodeCursor(cursor: string): { at: Date; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      const { at, id } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
        at?: unknown;
        id?: unknown;
      };
      const when = typeof at === 'string' ? new Date(at) : null;
      if (when === null || Number.isNaN(when.getTime()) || typeof id !== 'string') {
        throw new Error('shape');
      }
      return { at: when, id };
    } catch {
      throw new AppError(400, 'cursor: invalid; pass the nextCursor of the previous page');
    }
  }

  /**
   * One page of the log, newest first, filtered by agent key, action and start time, from the
   * cursor of the previous page (400 when it is not one). With it come the integrations its
   * entries are about, deleted ones too.
   */
  static async page(workspaceId: string, query: AuditPageQuery): Promise<AuditPage> {
    const rows = await AuditLog.list(
      workspaceId,
      {
        ...(query.actorAgentId === undefined ? {} : { actorAgentId: query.actorAgentId }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.cursor === undefined ? {} : { before: AuditLog.#decodeCursor(query.cursor) }),
      },
      query.limit + 1,
    );
    const entries = rows.slice(0, query.limit);
    const last = entries[entries.length - 1];
    const ids = [
      ...new Set(
        entries.flatMap((entry) => {
          const id = entry.integrationId;
          return id === null ? [] : [id];
        }),
      ),
    ];
    const integrations = new Map(
      (await (await getIntegrationRepository()).listByIdsIncludingDeleted(workspaceId, ids)).map(
        (integration): [string, AuditedIntegration] => [
          integration.id,
          {
            id: integration.id,
            provider: integration.provider,
            ownerUserId: integration.ownerUserId,
          },
        ],
      ),
    );
    const nextCursor =
      rows.length > query.limit && last !== undefined ? AuditLog.#encodeCursor(last) : null;
    return newAuditPage(entries, nextCursor, integrations);
  }

  get action(): string {
    return this.data.action;
  }

  /**
   * The integration this entry is an event of: its target, or for the items a calendar push wrote
   * or deleted (`gcal.*`, target an item) the integration in its meta. Null for anything else.
   */
  get integrationId(): string | null {
    if (this.data.targetType === 'integration') return this.data.targetId;
    const id = this.data.meta['integrationId'];
    return this.data.targetType === 'item' && typeof id === 'string' ? id : null;
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
