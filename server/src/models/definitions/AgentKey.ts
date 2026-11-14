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
  /** Keys that are not revoked: the per-user cap counts these. */
  countForUser(workspaceId: string, userId: string): Promise<number>;
  /** Global: the key behind a presented hash, revoked or expired too (the caller checks). */
  findByHash(keyHash: string): Promise<AgentKeyData | null>;
}

export const AGENT_KEY_TABLE_NAME = 'AgentKeys';
