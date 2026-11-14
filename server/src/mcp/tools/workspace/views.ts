/**
 * Output shapes shared by the workspace tools, mapped field by field from the services' data (as
 * the REST controllers do), so nothing added to a model later reaches an agent by accident.
 * Dates are ISO strings: structured content is JSON.
 */
import { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import type { InviteData } from '../../../models/index.js';
import { listMembers, type MemberWithUser } from '../../../services/workspaces.js';
import type { WorkspaceContext } from '../../../services/accessFilter.js';
import { providersByMember } from '../../../services/integrations.js';
import { INVITE_STATUSES, PROVIDERS, ROLES, type Provider } from '../../../types/domain.js';

export const MemberView = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.enum(ROLES),
  joinedAt: z.string().describe('ISO 8601'),
  providers: z
    .array(z.enum(PROVIDERS))
    .describe('Providers of the integrations this member owns here; never their accounts'),
});
export type MemberView = z.infer<typeof MemberView>;

export function toMemberView(
  { membership, name, email }: MemberWithUser,
  providers: ReadonlyMap<string, Provider[]>,
): MemberView {
  return {
    userId: membership.userId,
    name,
    email,
    role: membership.role,
    joinedAt: membership.createdAt.toISOString(),
    providers: providers.get(membership.userId) ?? [],
  };
}

/** An invite's details. Never its link and never a hash of it. */
export const InviteView = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  status: z.enum(INVITE_STATUSES),
  expiresAt: z.string().describe('ISO 8601'),
  createdAt: z.string().describe('ISO 8601'),
});
export type InviteView = z.infer<typeof InviteView>;

export function toInviteView(invite: InviteData): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}

/** A member input field: the user id from workspace_list_members. */
export const MemberUserId = z
  .string()
  .min(1)
  .max(100)
  .describe('The member’s userId, from workspace_list_members');

/** An active member of this workspace, or 404: an id from elsewhere is simply not found. */
export async function findMemberView(ws: WorkspaceContext, userId: string): Promise<MemberView> {
  const member = (await listMembers(ws)).find((m) => m.membership.userId === userId);
  if (member === undefined) throw new AppError(404, 'Member not found');
  return toMemberView(member, await providersByMember(ws.id));
}
