import type { AgentScope } from '../../types/domain.js';

/**
 * A key issued to an MCP agent (DATA.md §3.14). The raw key is shown once at creation; only its
 * SHA-256 hash is stored, and the hash is never mapped out of the repository.
 */
export interface AgentKeyData {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  /** "elk_" + 4 characters, for the key list only. */
  prefix: string;
  scopes: AgentScope[];
  /** A key made in the app, or a sign-in grant (OAuth) made by an MCP client. */
  kind: 'key' | 'oauth';
  /** Grants only: the OAuth client's id and display name. */
  clientId: string | null;
  clientName: string | null;
  /** Grants only: the MCP resource (audience) the tokens were issued for. */
  resource: string | null;
  /** A grant's current access token stops working here. */
  accessExpiresAt: Date | null;
  /** A grant's current refresh token stops working here. */
  refreshExpiresAt: Date | null;
  /** A key's expiry; for a grant the hard cap (365 days after sign-in). */
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentKeyInput {
  userId: string;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: AgentScope[];
  expiresAt?: Date | null;
}

/** A new grant. The hashes are SHA-256 of the raw tokens, which are never stored. */
export interface CreateGrantInput {
  userId: string;
  name: string;
  scopes: AgentScope[];
  clientId: string;
  clientName: string;
  resource: string;
  /** The current access token's hash. */
  keyHash: string;
  accessExpiresAt: Date;
  refreshHash: string;
  refreshExpiresAt: Date;
  expiresAt: Date;
  /** The authorization request that made the grant. */
  sourceRequestId: string;
}

/** The state a refresh moves a grant to. */
export interface GrantRotation {
  keyHash: string;
  accessExpiresAt: Date;
  refreshHash: string;
  refreshExpiresAt: Date;
  prevRefreshHash: string;
  prevRotatedAt: Date;
  /** When the last `agent_key.oauth_refresh` audit entry was written; unchanged when omitted. */
  refreshAuditedAt?: Date;
}

/** A grant found by a presented refresh token. */
export interface GrantByRefresh {
  key: AgentKeyData;
  /** Which refresh token of the grant was presented: the current one or the one before it. */
  match: 'current' | 'previous';
  prevRotatedAt: Date | null;
  /** The grant's current refresh hash: what a rotation expects. */
  currentRefreshHash: string;
  refreshAuditedAt: Date | null;
}

export interface IAgentKeyRepository {
  create(workspaceId: string, input: CreateAgentKeyInput): Promise<AgentKeyData>;
  /** The user's keys that are not revoked, newest first. */
  listForUser(workspaceId: string, userId: string): Promise<AgentKeyData[]>;
  /** One key of the workspace, revoked or not. */
  findById(workspaceId: string, id: string): Promise<AgentKeyData | null>;
  /** Every key of the workspace, revoked too, newest first; `userId` null = all users. */
  listForWorkspace(workspaceId: string, userId: string | null): Promise<AgentKeyData[]>;
  /** False when the key was not found or already revoked. */
  revoke(workspaceId: string, id: string): Promise<boolean>;
  /**
   * Revokes every key the user holds in the workspace: they left it, were removed, or deleted
   * their account. Returns how many.
   */
  revokeForUser(workspaceId: string, userId: string): Promise<number>;
  /** Records a use (`lastUsedAt`) without touching `updatedAt`. */
  touch(workspaceId: string, id: string, at: Date): Promise<void>;
  /** Usable keys and grants (not revoked, not past `expiresAt`): the per-user cap counts these. */
  countForUser(workspaceId: string, userId: string): Promise<number>;
  /** Global: the key behind a presented hash, revoked or expired too (the caller checks). */
  findByHash(keyHash: string): Promise<AgentKeyData | null>;
  createGrant(workspaceId: string, input: CreateGrantInput): Promise<AgentKeyData>;
  /** Global: the grant behind a presented refresh hash, its current or its previous one. */
  findByRefreshHash(hash: string): Promise<GrantByRefresh | null>;
  /**
   * Atomic: moves the grant to `next` only while its current refresh hash is still
   * `expectedRefreshHash` and it is not revoked. False when it no longer is (a concurrent refresh
   * won, or the grant was revoked).
   */
  rotateGrant(id: string, expectedRefreshHash: string, next: GrantRotation): Promise<boolean>;
  /** The grant an authorization request made, if any. */
  findBySourceRequest(requestId: string): Promise<AgentKeyData | null>;
}

export const AGENT_KEY_TABLE_NAME = 'AgentKeys';
