import { type RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import type { InviteData } from '../models/index.js';
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
import { emailInvite, inviteUrl, joinUrl } from '../services/inviteDelivery.js';
import { logger } from '../services/logger.js';
import {
  AcceptJoinLinkBody,
  CreateInviteBody,
  SetJoinLinkBody,
} from '../services/workspaceSchemas.js';
import {
  acceptInvite,
  acceptJoinLink,
  createInvite,
  getJoinLink,
  type JoinLinkState,
  resetJoinLink,
  setJoinLink,
  listInvites,
  listPendingInvitesForUser,
  revokeInvite,
} from '../services/workspaces.js';
import { requireUser } from '../services/users.js';
import type { AuthenticatedRequest, WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** Field by field: the token hash never leaves the repository, and nothing else slips in. */
function toInviteView(invite: InviteData): InviteView {
  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    acceptedBy: invite.acceptedBy,
    acceptedAt: invite.acceptedAt,
    createdAt: invite.createdAt,
  };
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const { workspace } = req as WorkspaceRequest;
  const data: ListInvitesResponseData = (await listInvites(workspace)).map(toInviteView);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateInviteBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const { message, language, ...invitation } = body;
  const { invite, rawToken } = await createInvite(workspace, user.id, invitation);
  const url = inviteUrl(rawToken);
  await emailInvite(workspace, user.id, invite, url, { message, language });
  // The raw token's only appearance. `inviteUrl` is not a deny-listed key, and the token is drawn
  // so that it never looks like a provider token: the guard passes it without an allowance.
  const data: CreateInviteResponseData = { invite: toInviteView(invite), inviteUrl: url };
  res.success(data, 201);
};

const revoke: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  await revokeInvite(workspace, user.id, routeParam(req, 'id'));
  res.status(204).end();
};

const listMine: RequestHandler = async (req, res): Promise<void> => {
  const user = await requireUser((req as AuthenticatedRequest).user.id);
  const pending = user.email === null ? [] : await listPendingInvitesForUser(user.email);
  const data: ListMyInvitesResponseData = pending.map(({ invite, workspaceName }) => ({
    id: invite.id,
    workspaceId: invite.workspaceId,
    workspaceName,
    role: invite.role,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  }));
  res.success(data);
};

const accept: RequestHandler = async (req, res): Promise<void> => {
  try {
    const user = await requireUser((req as AuthenticatedRequest).user.id);
    const data: AcceptInviteResponseData = await acceptInvite(
      { id: user.id, email: user.email },
      routeParam(req, 'token'),
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
  const { workspace } = req as WorkspaceRequest;
  const data: GetJoinLinkResponseData = toJoinLinkView(await getJoinLink(workspace));
  res.success(data);
};

const setJoin: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(SetJoinLinkBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  res.success(toJoinLinkView(await setJoinLink(workspace, user.id, body)));
};

const resetJoin: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  res.success(toJoinLinkView(await resetJoinLink(workspace, user.id)));
};

const acceptJoin: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(AcceptJoinLinkBody, req.body);
  const user = await requireUser((req as AuthenticatedRequest).user.id);
  const data: AcceptJoinLinkResponseData = await acceptJoinLink(
    { id: user.id, email: user.email },
    body.token,
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
