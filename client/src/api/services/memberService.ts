import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  DeleteFormerMemberTodosResponseData,
  FormerMemberTodosResponseData,
  ListMembersResponseData,
  UpdateMemberRequestBody,
  UpdateMemberResponseData,
} from '@api-types/api-contracts';

function membersPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/members`;
}

export async function listMembers(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListMembersResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListMembersResponseData>>(
    membersPath(workspaceId),
    config,
  );
  return response.data;
}

export async function updateMember(
  workspaceId: string,
  userId: string,
  body: UpdateMemberRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<UpdateMemberResponseData>> {
  const response = await api.patch<ApiSuccessResponse<UpdateMemberResponseData>>(
    `${membersPath(workspaceId)}/${encodeURIComponent(userId)}`,
    body,
    config,
  );
  return response.data;
}

/** 204. */
export async function removeMember(
  workspaceId: string,
  userId: string,
  config?: ApiRequestConfig,
): Promise<void> {
  await api.delete(`${membersPath(workspaceId)}/${encodeURIComponent(userId)}`, config);
}

/** 204. The last owner gets 409 and deletes the workspace instead. */
export async function leaveWorkspace(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<void> {
  await api.delete(`${membersPath(workspaceId)}/me`, config);
}

function formerTodosPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/former-member-todos`;
}

/** Owners: how many private to-dos former members left (a count, never their content). */
export async function countFormerMemberTodos(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<FormerMemberTodosResponseData>> {
  const response = await api.get<ApiSuccessResponse<FormerMemberTodosResponseData>>(
    formerTodosPath(workspaceId),
    config,
  );
  return response.data;
}

/** Owners: deletes them, unread (soft; purged 30 days later). */
export async function deleteFormerMemberTodos(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<DeleteFormerMemberTodosResponseData>> {
  const response = await api.delete<ApiSuccessResponse<DeleteFormerMemberTodosResponseData>>(
    formerTodosPath(workspaceId),
    config,
  );
  return response.data;
}
