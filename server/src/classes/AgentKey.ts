/**
 * An agent key for MCP clients (DATA.md §3.14). The raw key is shown once, when it is created;
 * only its SHA-256 hash is stored, so the database alone can't act as an agent.
 *
 * A sign-in grant (kind 'oauth') is the same row made by an OAuth client: an hour-long access
 * token `elo_...` and a rotating refresh token `elr_...`, both stored as hashes only. A refresh
 * issues both anew; the refresh token it replaces still works for 30 seconds (a lost response),
 * and shown later than that it proves a leak, so the grant is revoked. A grant lives at most 365
 * days (`expiresAt`), and a refresh token 90 days from its last use.
 *
 * Any member creates keys for themselves, limited to the scopes their role permits
 * (ScopeSet.forRole: ROLE_SCOPES) and to LIMITS.agentKeysPerUser live keys (409). An owner lists and revokes
 * everyone's keys; anyone else sees and revokes their own (another's is a 404).
 */
import { randomBytes } from 'node:crypto';

import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import { NotFoundError } from '../errors/NotFoundError.js';
import { OAuthError } from '../errors/OAuthError.js';
import { resolvePrincipal, type AuthenticatedAgent } from '../mcp/auth/principal.js';
import type { AgentKeyData } from '../models/definitions/AgentKey.js';
import { getAgentKeyRepository } from '../models/index.js';
import type { AgentKeyView } from '../routes/private/agentKeys.js';
import { sha256Hex } from '../services/crypto/hashing.js';
import type { AgentScope } from '../types/domain.js';
import { Actor, type ActorOrigin } from './base/Actor.js';
import { AuditTarget } from './base/AuditTarget.js';
import type { Caller } from './base/Caller.js';
import type { Auditable, Expirable, Revocable } from './base/contracts.js';
import { ScopeSet } from './base/ScopeSet.js';
import { WorkspaceEntity } from './base/WorkspaceEntity.js';
import { WorkspacePolicy } from './policies/WorkspacePolicy.js';
import { AuditLog } from './AuditLog.js';

export const KEY_PREFIX = 'elk_';
const ACCESS_PREFIX = 'elo_';
const REFRESH_PREFIX = 'elr_';
export const DEFAULT_EXPIRY_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a bearer may present: `elk_` (a key) or `elo_` (an access token) + 32 random bytes in base64url. */
export const AGENT_BEARER_PATTERN = /^el[ko]_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_PATTERN = /^elr_[A-Za-z0-9_-]{43}$/;

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_MS = 90 * DAY_MS;
/** A grant's hard cap, however often it is refreshed. */
const GRANT_MAX_MS = 365 * DAY_MS;
/** A refresh token rotated away still works this long: the client may not have got the answer. */
const REFRESH_GRACE_MS = 30_000;
/** `agent_key.oauth_refresh` is audited at most this often per grant. */
const REFRESH_AUDIT_INTERVAL_MS = 60 * 60 * 1000;

/** A use is written to `lastUsedAt` at most once a minute per key, not on every call. */
const TOUCH_INTERVAL_MS = 60_000;

export function hashAgentKey(raw: string): string {
  return sha256Hex(raw);
}

/** What the token endpoint answers (RFC 6749 section 5.1, without `token_type`). */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives. */
  expiresIn: number;
  /** The granted scopes, space-separated. */
  scope: string;
}

export interface IssueGrantInput {
  workspaceId: string;
  userId: string;
  name: string;
  scopes: AgentScope[];
  clientId: string;
  clientName: string;
  resource: string;
  /** The authorization request that made the grant (`revokeBySource`). */
  sourceRequestId: string;
}

function newToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

function invalidGrant(): OAuthError {
  return new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
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

  /** A key made in the app, or a sign-in grant made by an OAuth client. */
  get kind(): 'key' | 'oauth' {
    return this.data.kind;
  }

  /** The OAuth client's name; a key has none. */
  get clientName(): string | null {
    return this.data.clientName;
  }

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
    if (!ScopeSet.forRole(caller.role).hasAll(input.scopes)) {
      throw new AppError(400, 'This role cannot grant some of these scopes', {
        code: 'scope_not_allowed',
      });
    }
    const keys = await getAgentKeyRepository();
    if ((await keys.countForUser(caller.workspaceId, caller.userId)) >= LIMITS.agentKeysPerUser) {
      throw new AppError(
        409,
        `You can hold at most ${String(LIMITS.agentKeysPerUser)} agent keys: revoke one first`,
        { code: 'agent_key_cap' },
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
   * The agent behind a raw key or access token, or null when it is malformed, unknown, revoked or expired, or
   * its user is no longer an active member of the key's workspace. Records the use (`lastUsedAt`).
   * `origin`: the request's address and user agent, for the audit log.
   */
  static async authenticate(
    raw: string,
    now: Date,
    origin: ActorOrigin,
  ): Promise<AuthenticatedAgent | null> {
    if (!AGENT_BEARER_PATTERN.test(raw)) return null;
    const keys = await getAgentKeyRepository();
    const data = await keys.findByHash(hashAgentKey(raw));
    if (data === null) return null;
    const key = new AgentKey(data);
    if (!key.isUsable(now)) return null;
    if (data.accessExpiresAt !== null && data.accessExpiresAt.getTime() <= now.getTime()) {
      return null;
    }
    const agent = await resolvePrincipal(data, origin);
    if (agent === null) return null;
    const lastUsed = key.lastUsedAt?.getTime() ?? null;
    if (lastUsed === null || now.getTime() - lastUsed >= TOUCH_INTERVAL_MS) {
      await keys.touch(key.workspaceId, key.id, now);
    }
    return agent;
  }

  // --- OAuth grants -----------------------------------------------------------

  /**
   * A sign-in grant for an OAuth client: the user approved it, `actor` is who approved. The raw
   * tokens leave only in the result; scopes are the caller's to have checked against the role.
   */
  static async issueGrant(
    input: IssueGrantInput,
    actor: Actor,
    now: Date = new Date(),
  ): Promise<IssuedTokens> {
    const accessToken = newToken(ACCESS_PREFIX);
    const refreshToken = newToken(REFRESH_PREFIX);
    const scopes = [...new Set(input.scopes)];
    const data = await (
      await getAgentKeyRepository()
    ).createGrant(input.workspaceId, {
      userId: input.userId,
      name: input.name,
      scopes,
      clientId: input.clientId,
      clientName: input.clientName,
      resource: input.resource,
      keyHash: hashAgentKey(accessToken),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
      refreshHash: hashAgentKey(refreshToken),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
      expiresAt: new Date(now.getTime() + GRANT_MAX_MS),
      sourceRequestId: input.sourceRequestId,
    });
    const grant = new AgentKey(data);
    await AuditLog.record(
      { workspaceId: grant.workspaceId, actor },
      'agent_key.oauth_grant',
      grant.auditTarget(),
      { clientName: input.clientName, scopes },
    );
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, scope: scopes.join(' ') };
  }

  /**
   * Trades a refresh token for new access and refresh tokens. `invalid_grant` when the token is
   * unknown, expired, revoked, or the client's is another. The token it replaced still works for
   * REFRESH_GRACE_MS; presented later it is a leak, and the grant is revoked.
   */
  static async refresh(
    rawRefresh: string,
    clientId: string,
    now: Date = new Date(),
  ): Promise<IssuedTokens> {
    if (!REFRESH_TOKEN_PATTERN.test(rawRefresh)) throw invalidGrant();
    const keys = await getAgentKeyRepository();
    const presented = hashAgentKey(rawRefresh);
    // A second look when a concurrent refresh won the rotation: the loser is then a retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const found = await keys.findByRefreshHash(presented);
      if (found === null) throw invalidGrant();
      const data = found.key;
      const grant = new AgentKey(data);
      const refreshExpiry = data.refreshExpiresAt?.getTime() ?? 0;
      if (
        data.kind !== 'oauth' ||
        data.clientId !== clientId ||
        !grant.isUsable(now) ||
        refreshExpiry <= now.getTime()
      ) {
        throw invalidGrant();
      }
      const actor = Actor.agent(data.userId, data.id);
      if (found.match === 'previous') {
        const rotatedAt = found.prevRotatedAt?.getTime() ?? 0;
        if (now.getTime() - rotatedAt > REFRESH_GRACE_MS) {
          await keys.revoke(data.workspaceId, data.id);
          await AuditLog.record(
            { workspaceId: data.workspaceId, actor },
            'agent_key.oauth_reuse',
            grant.auditTarget(),
            { clientName: data.clientName },
          );
          throw invalidGrant();
        }
      }
      const accessToken = newToken(ACCESS_PREFIX);
      const refreshToken = newToken(REFRESH_PREFIX);
      const capMs = data.expiresAt?.getTime() ?? now.getTime() + GRANT_MAX_MS;
      // The token a refresh replaces becomes `prev` (reuse detection). A retry of `prev` within the
      // grace window (a doubled refresh) instead keeps the superseded current token alive as the
      // alternate: whichever response the client kept, its refresh token works.
      const retried = found.match === 'previous';
      const audit =
        found.refreshAuditedAt === null ||
        now.getTime() - found.refreshAuditedAt.getTime() >= REFRESH_AUDIT_INTERVAL_MS;
      const rotated = await keys.rotateGrant(data.id, found.currentRefreshHash, {
        keyHash: hashAgentKey(accessToken),
        accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
        refreshHash: hashAgentKey(refreshToken),
        refreshExpiresAt: new Date(Math.min(now.getTime() + REFRESH_TTL_MS, capMs)),
        prevRefreshHash: presented,
        prevRotatedAt: retried ? (found.prevRotatedAt ?? now) : now,
        altRefreshHash: retried ? found.currentRefreshHash : null,
        ...(audit ? { refreshAuditedAt: now } : {}),
      });
      if (!rotated) continue;
      if (audit) {
        await AuditLog.record(
          { workspaceId: data.workspaceId, actor },
          'agent_key.oauth_refresh',
          grant.auditTarget(),
          { clientName: data.clientName },
        );
      }
      return {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TTL_SECONDS,
        scope: grant.scopes.join(' '),
      };
    }
    throw invalidGrant();
  }

  /** Ends the grant an authorization request made (its code was used twice); none is a no-op. */
  static async revokeBySource(requestId: string): Promise<void> {
    const keys = await getAgentKeyRepository();
    const data = await keys.findBySourceRequest(requestId);
    if (data === null) return;
    await keys.revoke(data.workspaceId, data.id);
    await AuditLog.record(
      { workspaceId: data.workspaceId, actor: Actor.agent(data.userId, data.id) },
      'agent_key.oauth_code_reuse',
      new AgentKey(data).auditTarget(),
      { clientName: data.clientName },
    );
  }

  /**
   * RFC 7009: ends the grant behind an access or refresh token of this client. An unknown or
   * malformed token, or another client's, is a silent no-op.
   */
  static async revokeByToken(rawToken: string, clientId: string): Promise<void> {
    const keys = await getAgentKeyRepository();
    const hash = hashAgentKey(rawToken);
    let data: AgentKeyData | null = null;
    if (REFRESH_TOKEN_PATTERN.test(rawToken)) {
      data = (await keys.findByRefreshHash(hash))?.key ?? null;
    } else if (AGENT_BEARER_PATTERN.test(rawToken)) {
      data = await keys.findByHash(hash);
    }
    if (data?.kind !== 'oauth' || data.clientId !== clientId) return;
    await keys.revoke(data.workspaceId, data.id);
    await AuditLog.record(
      { workspaceId: data.workspaceId, actor: Actor.agent(data.userId, data.id) },
      'agent_key.oauth_revoke',
      new AgentKey(data).auditTarget(),
      { clientName: data.clientName },
    );
  }
}
