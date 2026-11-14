import { type RequestHandler } from 'express';
import type {
  DeleteFormerMemberTodosResponseData,
  FormerMemberTodosResponseData,
  ListMembersResponseData,
  MemberView,
  UpdateMemberResponseData,
} from '../routes/private/members.js';
import { UpdateMemberBody } from '../services/workspaceSchemas.js';
import {
  countFormerMembersTodos,
  deleteFormerMembersTodos,
  leaveWorkspace,
  listMembers,
  removeMember,
  updateMember,
  type MemberWithUser,
} from '../services/workspaces.js';
import { providersByMember } from '../services/integrations.js';
import { findUser } from '../services/users.js';
import type { Provider } from '../types/domain.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

function toMemberView(
  { membership, name, email }: MemberWithUser,
  providers: ReadonlyMap<string, Provider[]>,
): MemberView {
  return {
    userId: membership.userId,
    name,
    email,
    role: membership.role,
    invitedBy: membership.invitedBy,
    joinedAt: membership.createdAt,
    providers: providers.get(membership.userId) ?? [],
  };
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const { workspace } = req as WorkspaceRequest;
  const providers = await providersByMember(workspace.id);
  const data: ListMembersResponseData = (await listMembers(workspace)).map((member) =>
    toMemberView(member, providers),
  );
  res.success(data);
};

const leave: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user, caller } = req as WorkspaceRequest;
  await leaveWorkspace(workspace, user.id, caller.actor);
  res.status(204).end();
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateMemberBody, req.body);
  const { workspace, user, caller } = req as WorkspaceRequest;
  const memberId = routeParam(req, 'uid');
  const membership = await updateMember(workspace, user.id, memberId, body, null, caller.actor);
  const person = await findUser(memberId);
  const data: UpdateMemberResponseData = toMemberView(
    { membership, name: person?.name ?? null, email: person?.email ?? null },
    await providersByMember(workspace.id),
  );
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user, caller } = req as WorkspaceRequest;
  await removeMember(workspace, user.id, routeParam(req, 'uid'), null, caller.actor);
  res.status(204).end();
};

const formerTodos: RequestHandler = async (req, res): Promise<void> => {
  const { workspace } = req as WorkspaceRequest;
  const data: FormerMemberTodosResponseData = { count: await countFormerMembersTodos(workspace) };
  res.success(data);
};

const deleteFormerTodos: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user, caller } = req as WorkspaceRequest;
  const data: DeleteFormerMemberTodosResponseData = {
    deleted: await deleteFormerMembersTodos(workspace, user.id, caller.actor),
  };
  res.success(data);
};

export const MembersController = {
  list,
  leave,
  update,
  remove,
  formerTodos,
  deleteFormerTodos,
} as const;
