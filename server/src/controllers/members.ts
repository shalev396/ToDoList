import { type RequestHandler } from 'express';
import type {
  DeleteFormerMemberTodosResponseData,
  FormerMemberTodosResponseData,
  ListMembersResponseData,
  MemberView,
  UpdateMemberResponseData,
} from '../routes/private/members.js';
import { UpdateMemberBody } from '../services/workspaceSchemas.js';
import { Integration } from '../classes/integration/index.js';
import { Member } from '../classes/workspace/index.js';
import type { Provider } from '../types/domain.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

function toMemberView(member: Member, providers: ReadonlyMap<string, Provider[]>): MemberView {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role.name,
    invitedBy: member.invitedBy,
    joinedAt: member.joinedAt,
    providers: providers.get(member.userId) ?? [],
  };
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, caller } = req as WorkspaceRequest;
  const providers = await Integration.providersByMember(workspace.id);
  const data: ListMembersResponseData = (await Member.list(caller)).map((member) =>
    toMemberView(member, providers),
  );
  res.success(data);
};

const leave: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await Member.leave(caller);
  res.status(204).end();
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateMemberBody, req.body);
  const { workspace, caller } = req as WorkspaceRequest;
  const member = await Member.update(caller, routeParam(req, 'uid'), body);
  const data: UpdateMemberResponseData = toMemberView(
    member,
    await Integration.providersByMember(workspace.id),
  );
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await Member.remove(caller, routeParam(req, 'uid'));
  res.status(204).end();
};

const formerTodos: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: FormerMemberTodosResponseData = { count: await Member.countFormerTodos(caller) };
  res.success(data);
};

const deleteFormerTodos: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: DeleteFormerMemberTodosResponseData = {
    deleted: await Member.deleteFormerTodos(caller),
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
