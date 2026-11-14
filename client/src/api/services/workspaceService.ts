import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  CreateWorkspaceRequestBody,
  CreateWorkspaceResponseData,
  ListWorkspacesResponseData,
  SetDefaultWorkspaceRequestBody,
  SetDefaultWorkspaceResponseData,
  UpdateWorkspaceRequestBody,
  UpdateWorkspaceResponseData,
} from '@api-types/api-contracts';

/** Workspaces are "workspaces" in the API (server/src/routes/private/workspaces.ts). */
const base = '/private/workspaces';

export async function listWorkspaces(
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListWorkspacesResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListWorkspacesResponseData>>(base, config);
  return response.data;
}

export async function createWorkspace(
  body: CreateWorkspaceRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<CreateWorkspaceResponseData>> {
  const response = await api.post<ApiSuccessResponse<CreateWorkspaceResponseData>>(
    base,
    body,
    config,
  );
  return response.data;
}

export async function updateWorkspace(
  workspaceId: string,
  body: UpdateWorkspaceRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<UpdateWorkspaceResponseData>> {
  const response = await api.patch<ApiSuccessResponse<UpdateWorkspaceResponseData>>(
    `${base}/${encodeURIComponent(workspaceId)}`,
    body,
    config,
  );
  return response.data;
}

/** 204: the workspace and everything in it are gone. */
export async function deleteWorkspace(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<void> {
  await api.delete(`${base}/${encodeURIComponent(workspaceId)}`, config);
}

export async function setDefaultWorkspace(
  body: SetDefaultWorkspaceRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<SetDefaultWorkspaceResponseData>> {
  const response = await api.put<ApiSuccessResponse<SetDefaultWorkspaceResponseData>>(
    '/private/me/default-workspace',
    body,
    config,
  );
  return response.data;
}
