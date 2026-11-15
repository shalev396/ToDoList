import type { AttributeDef, AttributePatch } from '../../types/attributes.js';

export type WeekStart = 'sun' | 'mon';

/** e.g. `{ match: "shalev396/*", topicId: <the Personal topic's id> }`. */
export interface TopicRule {
  match: string;
  topicId: string;
}

export interface WorkspaceSettings {
  timezone: string;
  weekStart: WeekStart;
  /** Container match key glob → topic; the first match wins (classes/workspace/TopicRules.ts). */
  topicRules: TopicRule[];
  /**
   * Whether agent keys with builder:publish may publish dashboards (builder_publish). Off unless an
   * owner turns it on; absent means off.
   */
  allowAgentPublish?: boolean;
  /**
   * Custom attribute definitions (H4), the built-in Importance first. Repositories always answer
   * the list (a workspace stored before attributes gets the built-in); change it only through the
   * attribute methods of IWorkspaceRepository.
   */
  attributes?: AttributeDef[];
}

/** A workspace (DATA.md §3.2). */
export interface WorkspaceData {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  settings: WorkspaceSettings;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  ownerId: string;
  /** Missing settings get the defaults: Asia/Jerusalem, Sunday, no rules. */
  settings?: Partial<WorkspaceSettings>;
}

export interface WorkspacePatch {
  name?: string;
  slug?: string;
  /** Only the settings given change. */
  settings?: Partial<WorkspaceSettings>;
}

/**
 * The workspace's join link ("anyone with the link", A2): one per workspace, so a workspace holds
 * at most one. Only the token's SHA-256 is searchable; the token itself is sealed (the stage key)
 * so the owner can copy the link again. Never part of WorkspaceData: a view cannot leak it.
 */
/** A sealed token (services/crypto/envelope.ts EncBlob), typed here without importing it. */
export interface SealedToken {
  alg: string;
  keyProvider: string;
  kmsKeyArn: string | null;
  keyVersion: number;
  wrappedDataKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  aad: string;
}

export interface JoinLinkData {
  /** Never owner. */
  role: 'editor' | 'viewer';
  tokenHash: string;
  /** The raw token, sealed. */
  enc: SealedToken;
  updatedAt: Date;
}

/** Here `id` is the workspace id itself. */
export interface IWorkspaceRepository {
  create(input: CreateWorkspaceInput): Promise<WorkspaceData>;
  /** Soft-deleted workspaces are not found. */
  findById(id: string): Promise<WorkspaceData | null>;
  /** Whoever holds the slug, soft-deleted or not: the unique index covers both. */
  findBySlug(slug: string): Promise<WorkspaceData | null>;
  /** Not soft-deleted, in no particular order. */
  listByIds(ids: readonly string[]): Promise<WorkspaceData[]>;
  update(id: string, patch: WorkspacePatch): Promise<WorkspaceData | null>;
  /**
   * Appends one topic rule in a single conditional write, unless a rule with the same match
   * (compared literally, in any case) exists or the list already holds `max` rules. Concurrent
   * appends and settings updates never lose each other's changes. True when it was added.
   */
  appendTopicRule(id: string, rule: TopicRule, max: number): Promise<boolean>;
  /** A topic was deleted: the rules that file into it go, in one write. Returns how many. */
  pullTopicRules(id: string, topicId: string): Promise<number>;
  /**
   * Appends one attribute in a single conditional write, unless the key exists or the list holds
   * `max` already.
   */
  appendAttribute(id: string, def: AttributeDef, max: number): Promise<'added' | 'exists' | 'full'>;
  /** Patches one attribute (never its key, type or built-in flag). Null when it is not found. */
  updateAttribute(id: string, key: string, patch: AttributePatch): Promise<AttributeDef | null>;
  /** Removes a custom attribute definition (the built-in stays). False when not removed. */
  removeAttribute(id: string, key: string): Promise<boolean>;
  /** The join link of a live workspace; null when it has none (restricted). */
  getJoinLink(id: string): Promise<JoinLinkData | null>;
  /** Sets or (null) removes the join link. False when the workspace is not found. */
  setJoinLink(id: string, link: JoinLinkData | null): Promise<boolean>;
  /** Global: the live workspace a join token's hash belongs to. */
  findByJoinTokenHash(tokenHash: string): Promise<WorkspaceData | null>;
  /** Sets `deletedAt`. False when there was nothing to delete. */
  softDelete(id: string): Promise<boolean>;
}

export const WORKSPACE_TABLE_NAME = 'Workspaces';
