import type { MembershipStatus, Role } from '../../types/domain.js';

/** A user's role in a workspace (DATA.md §3.3). One per (workspaceId, userId). */
export interface MembershipData {
  id: string;
  workspaceId: string;
  userId: string;
  role: Role;
  invitedBy: string | null;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMembershipInput {
  userId: string;
  role: Role;
  invitedBy?: string | null;
}

export interface MembershipPatch {
  role?: Role;
}

export interface IMembershipRepository {
  /**
   * Makes the user an active member: inserts a membership, or reactivates the user's revoked one
   * (there is one document per user and workspace). Throws on a duplicate active membership.
   */
  create(workspaceId: string, input: CreateMembershipInput): Promise<MembershipData>;
  /** The active membership, or null. */
  find(workspaceId: string, userId: string): Promise<MembershipData | null>;
  /** Active memberships, oldest first. */
  listMembers(workspaceId: string): Promise<MembershipData[]>;
  /** Changes an active membership. */
  update(
    workspaceId: string,
    userId: string,
    patch: MembershipPatch,
  ): Promise<MembershipData | null>;
  /** False when there was no active membership. */
  revoke(workspaceId: string, userId: string): Promise<boolean>;
  countActive(workspaceId: string): Promise<number>;
  /** Active owners: a workspace's last owner may not leave. */
  countOwners(workspaceId: string): Promise<number>;
  /** Global: the user's active memberships ("my workspaces"), oldest first. */
  findForUser(userId: string): Promise<MembershipData[]>;
}

export const MEMBERSHIP_TABLE_NAME = 'Memberships';
