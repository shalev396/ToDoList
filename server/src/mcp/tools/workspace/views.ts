/**
 * Output shapes shared by the workspace tools, mapped field by field from the services' data (as
 * the REST controllers do), so nothing added to a model later reaches an agent by accident.
 * Dates are ISO strings: structured content is JSON.
 */
import { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import type { Caller } from '../../../classes/base/Caller.js';
import { Integration } from '../../../classes/integration/index.js';
import { Member, type Invite } from '../../../classes/workspace/index.js';
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
  member: Member,
  providers: ReadonlyMap<string, Provider[]>,
): MemberView {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role.name,
    joinedAt: member.joinedAt.toISOString(),
    providers: providers.get(member.userId) ?? [],
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

export function toInviteView(invite: Invite): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role.name,
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
export async function findMemberView(caller: Caller, userId: string): Promise<MemberView> {
  const member = (await Member.list(caller)).find((m) => m.userId === userId);
  if (member === undefined) throw new AppError(404, 'Member not found');
  return toMemberView(member, await Integration.providersByMember(caller.workspaceId));
}
