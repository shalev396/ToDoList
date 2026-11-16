import type {
  AuthMethod,
  IntegrationMode,
  IntegrationStatus,
  Provider,
  PublicIntegrationStatus,
} from '../../types/domain.js';
import type { ErrorInfo } from './common.js';

/** A connection to one provider account (DATA.md §3.4). Never holds a secret: see Credentials. */
export interface IntegrationData {
  id: string;
  workspaceId: string;
  connectedBy: string;
  /**
   * The member it belongs to (PERMISSIONS-V2): only they see its details and manage it. Set from
   * `connectedBy` when created; existing integrations got it from `connectedBy` (migration 17).
   */
  ownerUserId: string;
  provider: Provider;
  /** Stable account key on the provider side: Jira site host, ClickUp team id, GitHub login… */
  accountId: string;
  label: string;
  authMethod: AuthMethod;
  /** The topic its records get when no topic rule matches; null = Unsorted. */
  topicId: string | null;
  mode: IntegrationMode;
  /** Non-secret settings only: base URL, filters, calendar or list ids. */
  config: Record<string, unknown>;
  credentialId: string | null;
  /** Internal status. Outside the server, only toIntegrationStatus() is ever shown. */
  status: IntegrationStatus;
  expiresAt: Date | null;
  lastSyncAt: Date | null;
  lastError: ErrorInfo | null;
  color: string | null;
  /**
   * Demo data (seed/seedWorkspace.ts, dev and qa only): a FAKE credential and recorded fixture
   * items. It never syncs, is never tested against its provider and is never written to.
   */
  demo: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntegrationInput {
  connectedBy: string;
  /** The member it belongs to: the one connecting it (the default). */
  ownerUserId?: string;
  provider: Provider;
  accountId: string;
  label: string;
  authMethod: AuthMethod;
  topicId: string | null;
  mode?: IntegrationMode;
  config?: Record<string, unknown>;
  credentialId?: string | null;
  status?: IntegrationStatus;
  /** Why it starts in `error`, e.g. `credential_missing` (it has no credential yet). */
  lastError?: ErrorInfo | null;
  expiresAt?: Date | null;
  color?: string | null;
  /** Demo data (seedWorkspace): fixed at creation. Default false. */
  demo?: boolean;
}

/** What may change after creation. Provider and account identify the integration and stay fixed. */
export interface IntegrationPatch {
  label?: string;
  topicId?: string | null;
  mode?: IntegrationMode;
  config?: Record<string, unknown>;
  credentialId?: string | null;
  status?: IntegrationStatus;
  expiresAt?: Date | null;
  lastSyncAt?: Date | null;
  lastError?: ErrorInfo | null;
  color?: string | null;
}

/**
 * Statuses that wait for the user: a pause, or an expired credential. Syncs never run for them
 * and never overwrite them.
 */
export const HELD_INTEGRATION_STATUSES: readonly IntegrationStatus[] = ['paused', 'expired'];

/** What a successful connection test learned (recordConnectionTest). */
export interface ConnectionTestPatch {
  /** The account's own label: replaces `from` (the provider default) only while it is stored. */
  label?: { from: string; to: string };
  /** GitHub: whether the token can read Projects boards, for `config.boards.enabled`. */
  boardsEnabled?: boolean;
}

/** The sync engine's final write on an integration (recordSyncResult). */
export interface SyncResultPatch {
  /** Written only while the integration is not `paused` or `expired`. */
  status?: IntegrationStatus;
  lastSyncAt?: Date;
  lastError: ErrorInfo | null;
}

export interface IIntegrationRepository {
  create(workspaceId: string, input: CreateIntegrationInput): Promise<IntegrationData>;
  /**
   * create() for each input, in one write, in order, each created a millisecond after the one
   * before it (from `at`, default now), so they list by creation in that order. A duplicate account
   * stops the write there (E11000, as create's), the inputs before it written.
   */
  createMany(
    workspaceId: string,
    inputs: readonly CreateIntegrationInput[],
    at?: Date,
  ): Promise<IntegrationData[]>;
  /** Soft-deleted integrations are not found. */
  findById(workspaceId: string, id: string): Promise<IntegrationData | null>;
  /** A soft-deleted one too (see `deletedAt`): a disconnect that stopped part-way resumes. */
  findIncludingDeleted(workspaceId: string, id: string): Promise<IntegrationData | null>;
  /** Not soft-deleted, oldest first: every member's. */
  list(workspaceId: string): Promise<IntegrationData[]>;
  /** One member's, not soft-deleted, oldest first. */
  listForOwner(workspaceId: string, ownerUserId: string): Promise<IntegrationData[]>;
  /** One member's, soft-deleted ones too (a disconnect that stopped part-way), oldest first. */
  listForOwnerIncludingDeleted(
    workspaceId: string,
    ownerUserId: string,
  ): Promise<IntegrationData[]>;
  /** These ids in the workspace, soft-deleted ones too (an audit entry names a deleted one). */
  listByIdsIncludingDeleted(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<IntegrationData[]>;
  update(workspaceId: string, id: string, patch: IntegrationPatch): Promise<IntegrationData | null>;
  /** update() for each integration, in one write, in order (no integration is answered). */
  updateMany(
    workspaceId: string,
    updates: readonly { id: string; patch: IntegrationPatch }[],
  ): Promise<void>;
  /**
   * The one change of account: a `pending:` placeholder (PENDING_ACCOUNT_PREFIX) becomes the real
   * account, once, when the first connection test succeeds. Null when the integration is missing,
   * deleted or already has its account; an account already connected here throws E11000.
   */
  replacePendingAccount(
    workspaceId: string,
    id: string,
    accountId: string,
  ): Promise<IntegrationData | null>;
  /**
   * After a successful connection test, each field in its own conditional update (never the whole
   * config), so a label or config saved while the test ran is kept:
   * - `label`: set to `to` only while the stored label is still `from`;
   * - `boardsEnabled`: `config.boards.enabled` alone, on a live GitHub integration whose
   *   `config.boards` is an object (or missing: created as `{enabled}`). A malformed one is left.
   * Soft-deleted integrations are left alone.
   */
  recordConnectionTest(workspaceId: string, id: string, patch: ConnectionTestPatch): Promise<void>;
  /**
   * The end of a sync run: `lastSyncAt` and `lastError` as given, and `status` only while the
   * integration is not `paused` or `expired`, so a pause or an expiry recorded while the run was
   * in flight wins (a conditional update). Soft-deleted integrations are left alone (null).
   */
  recordSyncResult(
    workspaceId: string,
    id: string,
    result: SyncResultPatch,
  ): Promise<IntegrationData | null>;
  /** recordSyncResult() for each integration, in one write, in order (no integration is answered). */
  recordSyncResults(
    workspaceId: string,
    results: readonly { id: string; result: SyncResultPatch }[],
  ): Promise<void>;
  /** Sets `deletedAt`. False when there was nothing to delete. */
  softDelete(workspaceId: string, id: string): Promise<boolean>;
  /** A topic was deleted: integrations defaulting to it, deleted ones too, default to none. */
  unsetTopic(workspaceId: string, topicId: string): Promise<number>;
  /**
   * Sets `deletedAt` on every integration of the workspace (workspace deletion), marked as deleted
   * with it (listOwnersForWorkspaceDeletion). Returns how many.
   */
  softDeleteForWorkspace(workspaceId: string): Promise<number>;
  /**
   * The members whose integrations a workspace deletion removes: owners of the live ones and of
   * those softDeleteForWorkspace deleted, so a deletion that resumes still knows them. Distinct.
   */
  listOwnersForWorkspaceDeletion(workspaceId: string): Promise<string[]>;
  /** Connected (not soft-deleted) integrations, whatever their status: the per-workspace cap counts these. */
  countActive(workspaceId: string): Promise<number>;
  /** One member's connected (not soft-deleted) integrations: the per-member cap counts these. */
  countActiveForOwner(workspaceId: string, ownerUserId: string): Promise<number>;
  /** Global: the sync worker, the credential vault and the public hooks only know the id. */
  findByIdForWorker(id: string): Promise<IntegrationData | null>;
  /**
   * Global, and a soft-deleted one too: the sync worker ending the queued run of an integration
   * disconnected meanwhile, which it knows by id only.
   */
  findIncludingDeletedForWorker(id: string): Promise<IntegrationData | null>;
  /**
   * Global: what the sync dispatcher schedules. Not soft-deleted, not demo data, `active`,
   * `expiring` or `error` (so failed syncs are retried), and `lastError` is not `auth_failed`.
   * `expired`, `paused` and failed auth wait for the user (a reconnect).
   */
  listActiveForDispatch(): Promise<IntegrationData[]>;
}

export const INTEGRATION_TABLE_NAME = 'Integrations';

/**
 * `accountId` of an integration whose account is known only once a connection test reads it
 * (ClickUp, Linear, Google): `pending:<uuid>` until then.
 */
export const PENDING_ACCOUNT_PREFIX = 'pending:';

/**
 * Everything the API and UI may show of an integration (DATA.md §0, §7), and only to its owner
 * (PERMISSIONS-V2 ruling 1). `authMethod` (never a secret) tells the UI how the owner reconnects:
 * Google sign-in or a form. `mode` says whether TodoList may change anything at the provider
 * (`read`, the default of every new connection) or may create and push there (`read_write`, the
 * owner's switch). MCP shows the same minus `authMethod` and `mode`
 * (mcp/tools/integrations/views.ts). Whether it is shared is its own call (GET …/sharing).
 */
export interface IntegrationStatusView {
  id: string;
  provider: Provider;
  authMethod: AuthMethod;
  accountLabel: string;
  status: PublicIntegrationStatus;
  mode: IntegrationMode;
  /** Whether its owner may switch it to read & write (never demo data: Integration#checkMode). */
  canSwitchMode: boolean;
  expiresAt: Date | null;
  lastSyncAt: Date | null;
  /**
   * A Google Calendar integration: how many events TodoList pushed with it are still live (so an
   * earlier workspace calendar's leftovers can be removed). Absent for other providers.
   */
  pushedEvents?: number;
}

const PUBLIC_STATUS: Readonly<Record<IntegrationStatus, PublicIntegrationStatus>> = {
  active: 'connected',
  expiring: 'connected',
  expired: 'expired',
  error: 'error',
  paused: 'error',
};

/**
 * The status fields of the stored data. The rest of the view (`canSwitchMode`) is the
 * integration's own rule: Integration#toView adds it.
 */
export function toIntegrationStatus(
  data: IntegrationData,
): Omit<IntegrationStatusView, 'canSwitchMode'> {
  return {
    id: data.id,
    provider: data.provider,
    authMethod: data.authMethod,
    accountLabel: data.label,
    status: PUBLIC_STATUS[data.status],
    mode: data.mode,
    expiresAt: data.expiresAt,
    lastSyncAt: data.lastSyncAt,
  };
}

const EXPIRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * True while fewer than 14 days are left before `expiresAt` (internal status `expiring`). False
 * without an expiry, and false once it has passed: that is `expired`.
 */
export function isExpiring(expiresAt: Date | null, now: Date): boolean {
  if (expiresAt === null) return false;
  const left = expiresAt.getTime() - now.getTime();
  return left > 0 && left < EXPIRING_WINDOW_MS;
}
