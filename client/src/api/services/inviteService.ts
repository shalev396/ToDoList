import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  AcceptInviteResponseData,
  AcceptJoinLinkResponseData,
  GetJoinLinkResponseData,
  ResetJoinLinkResponseData,
  SetJoinLinkRequestBody,
  SetJoinLinkResponseData,
  ApiSuccessResponse,
  CreateInviteRequestBody,
  CreateInviteResponseData,
  ListInvitesResponseData,
  ListMyInvitesResponseData,
} from '@api-types/api-contracts';

function invitesPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/invites`;
}

export async function listInvites(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListInvitesResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListInvitesResponseData>>(
    invitesPath(workspaceId),
    config,
  );
  return response.data;
}

/**
 * The response carries the invite link with its one-time token. Callers show it once and never log
 * it, cache it or put it in a toast.
 */
export async function createInvite(
  workspaceId: string,
  body: CreateInviteRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<CreateInviteResponseData>> {
  const response = await api.post<ApiSuccessResponse<CreateInviteResponseData>>(
    invitesPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

/** 204: the link stops working (410). */
export async function revokeInvite(
  workspaceId: string,
  inviteId: string,
  config?: ApiRequestConfig,
): Promise<void> {
  await api.delete(`${invitesPath(workspaceId)}/${encodeURIComponent(inviteId)}`, config);
}

/** Pending invites sent to my email. They carry no token: joining needs the emailed link. */
export async function listMyInvites(
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListMyInvitesResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListMyInvitesResponseData>>(
    '/private/me/invites',
    config,
  );
  return response.data;
}

export async function acceptInvite(
  token: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<AcceptInviteResponseData>> {
  const response = await api.post<ApiSuccessResponse<AcceptInviteResponseData>>(
    `/private/invites/${encodeURIComponent(token)}/accept`,
    null,
    config,
  );
  return response.data;
}

function joinLinkPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/join-link`;
}

/** Owner. The response carries the join link with its token: shown in the Share dialog only. */
export async function getJoinLink(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<GetJoinLinkResponseData>> {
  const response = await api.get<ApiSuccessResponse<GetJoinLinkResponseData>>(
    joinLinkPath(workspaceId),
    config,
  );
  return response.data;
}

export async function setJoinLink(
  workspaceId: string,
  body: SetJoinLinkRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<SetJoinLinkResponseData>> {
  const response = await api.put<ApiSuccessResponse<SetJoinLinkResponseData>>(
    joinLinkPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

export async function resetJoinLink(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ResetJoinLinkResponseData>> {
  const response = await api.post<ApiSuccessResponse<ResetJoinLinkResponseData>>(
    `${joinLinkPath(workspaceId)}/reset`,
    null,
    config,
  );
  return response.data;
}

/** The token goes in the body, so no request path carries it. */
export async function acceptJoinLink(
  token: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<AcceptJoinLinkResponseData>> {
  const response = await api.post<ApiSuccessResponse<AcceptJoinLinkResponseData>>(
    '/private/join-links/accept',
    { token },
    config,
  );
  return response.data;
}
