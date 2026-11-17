import { type RequestHandler } from 'express';
import { Actor } from '../classes/base/Actor.js';
import { AppError } from '../errors/AppError.js';
import { Invite, Workspace, type JoinLinkState } from '../classes/workspace/index.js';
import type {
  AcceptInviteResponseData,
  AcceptJoinLinkResponseData,
  GetJoinLinkResponseData,
  JoinLinkView,
  CreateInviteResponseData,
  InviteView,
  ListInvitesResponseData,
  ListMyInvitesResponseData,
} from '../routes/private/invites.js';
import { inviteUrl, joinUrl } from '../services/inviteDelivery.js';
import { logger } from '../services/logger.js';
import {
  AcceptJoinLinkBody,
  CreateInviteBody,
  SetJoinLinkBody,
} from '../services/workspaceSchemas.js';
import { requireUser } from '../services/users.js';
import type { AuthenticatedRequest, WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** Field by field: the token hash never leaves the repository, and nothing else slips in. */
function toInviteView(invite: Invite): InviteView {
  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    email: invite.email,
    role: invite.role.name,
    status: invite.status,
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    acceptedBy: invite.acceptedBy,
    acceptedAt: invite.acceptedAt,
    createdAt: invite.createdAt,
  };
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: ListInvitesResponseData = (await Invite.list(caller)).map(toInviteView);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateInviteBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const { message, language, ...invitation } = body;
  const { invite, rawToken } = await Invite.create(caller, invitation);
  const url = inviteUrl(rawToken);
  await invite.deliver(caller, url, { message, language });
  // The raw token's only appearance. `inviteUrl` is not a deny-listed key, and the token is drawn
  // so that it never looks like a provider token: the guard passes it without an allowance.
  const data: CreateInviteResponseData = { invite: toInviteView(invite), inviteUrl: url };
  res.success(data, 201);
};

const revoke: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await (await Invite.pending(caller, routeParam(req, 'id'))).revoke(caller);
  res.status(204).end();
};

const listMine: RequestHandler = async (req, res): Promise<void> => {
  const user = await requireUser((req as AuthenticatedRequest).user.id);
  const pending = user.email === null ? [] : await Invite.pendingFor(user.email);
  const data: ListMyInvitesResponseData = pending.map(({ invite, workspaceName }) => ({
    id: invite.id,
    workspaceId: invite.workspaceId,
    workspaceName,
    role: invite.role.name,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  }));
  res.success(data);
};

const accept: RequestHandler = async (req, res): Promise<void> => {
  try {
    const user = await requireUser((req as AuthenticatedRequest).user.id);
    const data: AcceptInviteResponseData = await Invite.accept(
      routeParam(req, 'token'),
      { id: user.id, email: user.email },
      Actor.user(user.id, Actor.originOf(req)),
    );
    res.success(data);
  } catch (error) {
    // 4xx: the error handler answers {message} and logs nothing.
    if (error instanceof AppError && error.statusCode < 500) throw error;
    // Anything else is answered here: the error handler would log the request path, and this
    // path carries the raw invite token.
    logger.error('POST /api/private/invites/:token/accept failed', error);
    res.error('Internal server error', 500);
  }
};

function toJoinLinkView(state: JoinLinkState): JoinLinkView {
  return {
    enabled: state.enabled,
    role: state.role,
    joinUrl: state.token === null ? null : joinUrl(state.token),
  };
}

const getJoin: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: GetJoinLinkResponseData = toJoinLinkView(
    await (await Workspace.load(caller)).getJoinLink(caller),
  );
  res.success(data);
};

const setJoin: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(SetJoinLinkBody, req.body);
  const { caller } = req as WorkspaceRequest;
  res.success(toJoinLinkView(await (await Workspace.load(caller)).setJoinLink(caller, body)));
};

const resetJoin: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  res.success(toJoinLinkView(await (await Workspace.load(caller)).resetJoinLink(caller)));
};

const acceptJoin: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(AcceptJoinLinkBody, req.body);
  const user = await requireUser((req as AuthenticatedRequest).user.id);
  const data: AcceptJoinLinkResponseData = await Workspace.acceptJoinLink(
    body.token,
    { id: user.id, email: user.email },
    Actor.user(user.id, Actor.originOf(req)),
  );
  res.success(data);
};

export const InvitesController = {
  list,
  create,
  revoke,
  listMine,
  accept,
  getJoinLink: getJoin,
  setJoinLink: setJoin,
  resetJoinLink: resetJoin,
  acceptJoinLink: acceptJoin,
} as const;
