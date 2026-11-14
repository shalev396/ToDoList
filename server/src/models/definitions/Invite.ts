import type { InviteStatus, Role } from '../../types/domain.js';

/**
 * An invitation to a workspace (DATA.md §3.3). The link carries the raw token once; only its
 * SHA-256 hash is stored, and the hash is never mapped out of the repository.
 */
export interface InviteData {
  id: string;
  workspaceId: string;
  /** Lowercased. */
  email: string;
  role: Role;
  expiresAt: Date;
  status: InviteStatus;
  invitedBy: string;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInviteInput {
  email: string;
  role: Role;
  tokenHash: string;
  expiresAt: Date;
  invitedBy: string;
}

export interface IInviteRepository {
  create(workspaceId: string, input: CreateInviteInput): Promise<InviteData>;
  /** Every invite of the workspace, newest first. */
  listForWorkspace(workspaceId: string): Promise<InviteData[]>;
  /** Accepts a pending, unexpired invite once; null when it is not (any more) acceptable. */
  markAccepted(workspaceId: string, id: string, userId: string): Promise<InviteData | null>;
  /** Revokes a pending invite. False when there was none. */
  revoke(workspaceId: string, id: string): Promise<boolean>;
  /** Global: the invite behind a link, whatever its status (the caller checks it). */
  findByTokenHash(tokenHash: string): Promise<InviteData | null>;
  /** Global: pending, unexpired invites for an email (any case), newest first. */
  listPendingForEmail(email: string): Promise<InviteData[]>;
}

export const INVITE_TABLE_NAME = 'Invites';
