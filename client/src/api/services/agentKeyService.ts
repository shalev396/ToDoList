import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  CreateAgentKeyRequestBody,
  CreateAgentKeyResponseData,
  ListAgentKeysResponseData,
} from '@api-types/api-contracts';

/** Agent keys (server/src/routes/private/agentKeys.ts). The raw key is in the create answer only. */
function keysPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/agent-keys`;
}

export async function listAgentKeys(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<ListAgentKeysResponseData>>(
    keysPath(workspaceId),
    config,
  );
  return response.data;
}

/** 201 with the raw `key`: hold it in component state only, never in a cache. */
export async function createAgentKey(
  workspaceId: string,
  body: CreateAgentKeyRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<CreateAgentKeyResponseData>>(
    keysPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

export async function revokeAgentKey(
  workspaceId: string,
  keyId: string,
  config?: ApiRequestConfig,
) {
  await api.delete(`${keysPath(workspaceId)}/${encodeURIComponent(keyId)}`, config);
}
