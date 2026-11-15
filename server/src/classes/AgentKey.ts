/**
 * An agent key for MCP clients (DATA.md §3.14). The raw key is shown once, when it is created;
 * only its SHA-256 hash is stored, so the database alone can't act as an agent.
 *
 * Any member creates keys for themselves, limited to the scopes their role permits
 * (ROLE_SCOPES) and to LIMITS.agentKeysPerUser live keys (409). An owner lists and revokes
 * everyone's keys; anyone else sees and revokes their own (another's is a 404).
 */
import { randomBytes } from 'node:crypto';

import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import { NotFoundError } from '../errors/NotFoundError.js';
import { resolvePrincipal, type AuthenticatedAgent } from '../mcp/auth/principal.js';
import { ROLE_SCOPES } from '../mcp/auth/scopes.js';
import type { AgentKeyData } from '../models/definitions/AgentKey.js';
import { getAgentKeyRepository } from '../models/index.js';
import type { AgentKeyView } from '../routes/private/agentKeys.js';
import { sha256Hex } from '../services/crypto/hashing.js';
import type { AgentScope } from '../types/domain.js';
import type { ActorOrigin } from './base/Actor.js';
import { AuditTarget } from './base/AuditTarget.js';
import type { Caller } from './base/Caller.js';
import type { Auditable, Expirable, Revocable } from './base/contracts.js';
import { WorkspaceEntity } from './base/WorkspaceEntity.js';
import { WorkspacePolicy } from './policies/WorkspacePolicy.js';
import { AuditLog } from './AuditLog.js';

export const KEY_PREFIX = 'elk_';
export const DEFAULT_EXPIRY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `elk_` + 32 random bytes in base64url: the only shape of a key. */
const AGENT_KEY_PATTERN = /^elk_[A-Za-z0-9_-]{43}$/;

/** A use is written to `lastUsedAt` at most once a minute per key, not on every call. */
const TOUCH_INTERVAL_MS = 60_000;

export function hashAgentKey(raw: string): string {
  return sha256Hex(raw);
}

export interface CreateAgentKeyInput {
  name: string;
  scopes: AgentScope[];
  expiresInDays?: number | undefined;
}

export class AgentKey
  extends WorkspaceEntity<AgentKeyData>
  implements Auditable, Expirable, Revocable
{
  private constructor(data: AgentKeyData) {
    super(data);
  }

  get userId(): string {
    return this.data.userId;
  }

  get name(): string {
    return this.data.name;
  }

  /** "elk_" + 4 characters. */
  get prefix(): string {
    return this.data.prefix;
  }

  get scopes(): AgentScope[] {
    return [...this.data.scopes];
  }

  get expiresAt(): Date | null {
    return this.data.expiresAt;
  }

  get lastUsedAt(): Date | null {
    return this.data.lastUsedAt;
  }

  get revokedAt(): Date | null {
    return this.data.revokedAt;
  }

  /** A key; sign-in grants (kind 'oauth') come in a later task. */
  readonly kind: 'key' | 'oauth' = 'key';

  /** The OAuth client's name; a key has none. */
  readonly clientName: string | null = null;

  isExpired(now: Date): boolean {
    return this.data.expiresAt !== null && this.data.expiresAt.getTime() <= now.getTime();
  }

  isUsable(now: Date): boolean {
    return this.data.revokedAt === null && !this.isExpired(now);
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('agent_key', this.id);
  }

  /** The key without its secret; `userId` only for an owner's list. */
  private toView(withUser: boolean): AgentKeyView {
    return {
      id: this.id,
      ...(withUser ? { userId: this.userId } : {}),
      name: this.name,
      prefix: this.prefix,
      scopes: this.scopes,
      expiresAt: this.expiresAt,
      lastUsedAt: this.lastUsedAt,
      revokedAt: this.revokedAt,
      kind: this.kind,
      clientName: this.clientName,
    };
  }

  // ─── Members ─────────────────────────────────────────────────────────────

  /** An owner sees every key of the workspace, with `userId`; anyone else their own. */
  static async list(caller: Caller): Promise<AgentKeyView[]> {
    const isOwner = WorkspacePolicy.roleMay(caller.role, 'manage');
    const rows = await (
      await getAgentKeyRepository()
    ).listForWorkspace(caller.workspaceId, isOwner ? null : caller.userId);
    return rows.map((row) => new AgentKey(row).toView(isOwner));
  }

  /**
   * Any member: a key for themselves, with scopes their role permits (400 `scope_not_allowed`
   * otherwise). 409 at the cap of live keys per user. Returns the raw key, once.
   */
  static async create(
    caller: Caller,
    input: CreateAgentKeyInput,
  ): Promise<{ key: AgentKey; raw: string }> {
    const permitted = ROLE_SCOPES[caller.role.name];
    if (input.scopes.some((scope) => !permitted.includes(scope))) {
      throw new AppError(400, 'This role cannot grant some of these scopes', {
        code: 'scope_not_allowed',
      });
    }
    const keys = await getAgentKeyRepository();
    if ((await keys.countForUser(caller.workspaceId, caller.userId)) >= LIMITS.agentKeysPerUser) {
      throw new AppError(
        409,
        `You can hold at most ${String(LIMITS.agentKeysPerUser)} agent keys: revoke one first`,
      );
    }
    const raw = KEY_PREFIX + randomBytes(32).toString('base64url');
    const days = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
    const data = await keys.create(caller.workspaceId, {
      userId: caller.userId,
      name: input.name,
      keyHash: hashAgentKey(raw),
      prefix: raw.slice(0, KEY_PREFIX.length + 4),
      scopes: [...new Set(input.scopes)],
      expiresAt: new Date(Date.now() + days * DAY_MS),
    });
    const key = new AgentKey(data);
    await AuditLog.record(caller, 'agent_key.create', key.auditTarget(), {
      name: key.name,
      scopes: key.scopes,
    });
    return { key, raw };
  }

  /** The view of a key just created, as the create response shows it (with `userId`). */
  viewWithUser(): AgentKeyView {
    return this.toView(true);
  }

  /** Owner, or the key's own user: revokes it. Anyone else, and an unknown key, get 404. */
  static async revoke(caller: Caller, id: string): Promise<void> {
    const data = await (await getAgentKeyRepository()).findById(caller.workspaceId, id);
    if (data === null) throw new NotFoundError();
    await new AgentKey(data).revoke(caller);
  }

  async revoke(caller: Caller): Promise<void> {
    this.assertIn(caller);
    if (!WorkspacePolicy.roleMay(caller.role, 'manage') && this.userId !== caller.userId) {
      throw new NotFoundError();
    }
    if (!(await (await getAgentKeyRepository()).revoke(this.workspaceId, this.id))) {
      throw new NotFoundError();
    }
    await AuditLog.record(caller, 'agent_key.revoke', this.auditTarget(), { name: this.name });
  }

  // ─── MCP authentication ──────────────────────────────────────────────────

  /**
   * The agent behind a raw key, or null when the key is malformed, unknown, revoked or expired, or
   * its user is no longer an active member of the key's workspace. Records the use (`lastUsedAt`).
   * `origin`: the request's address and user agent, for the audit log.
   */
  static async authenticate(
    raw: string,
    now: Date,
    origin: ActorOrigin,
  ): Promise<AuthenticatedAgent | null> {
    if (!AGENT_KEY_PATTERN.test(raw)) return null;
    const keys = await getAgentKeyRepository();
    const data = await keys.findByHash(hashAgentKey(raw));
    if (data === null) return null;
    const key = new AgentKey(data);
    if (!key.isUsable(now)) return null;
    const agent = await resolvePrincipal(data, origin);
    if (agent === null) return null;
    const lastUsed = key.lastUsedAt?.getTime() ?? null;
    if (lastUsed === null || now.getTime() - lastUsed >= TOUCH_INTERVAL_MS) {
      await keys.touch(key.workspaceId, key.id, now);
    }
    return agent;
  }
}
