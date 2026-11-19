import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  FacetsResponseData,
  GetItemResponseData,
  ListSyncRunsResponseData,
  SyncAllResponseData,
  UpdateItemRequestBody,
  UpdateItemResponseData,
  UpdateOverlayRequestBody,
  UpdateOverlayResponseData,
} from '@api-types/api-contracts';

function wsPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}`;
}

function itemPath(workspaceId: string, itemId: string): string {
  return `${wsPath(workspaceId)}/items/${encodeURIComponent(itemId)}`;
}

/** `connectors`: only what those sources hold (a filter block's listening blocks' sources). */
export async function getFacets(
  workspaceId: string,
  config?: ApiRequestConfig,
  connectors?: readonly string[],
) {
  const query =
    connectors === undefined ? '' : `?connectors=${encodeURIComponent(connectors.join(','))}`;
  const response = await api.get<ApiSuccessResponse<FacetsResponseData>>(
    `${wsPath(workspaceId)}/facets${query}`,
    config,
  );
  return response.data;
}

export async function getItem(workspaceId: string, itemId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<GetItemResponseData>>(
    itemPath(workspaceId, itemId),
    config,
  );
  return response.data;
}

export async function updateItem(
  workspaceId: string,
  itemId: string,
  body: UpdateItemRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<UpdateItemResponseData>>(
    itemPath(workspaceId, itemId),
    body,
    config,
  );
  return response.data;
}

/** `DELETE …/items/:id` (204): a soft delete of a to-do or a time block (an area too). */
export async function deleteItem(workspaceId: string, itemId: string, config?: ApiRequestConfig) {
  await api.delete(itemPath(workspaceId, itemId), config);
}

export async function updateOverlay(
  workspaceId: string,
  itemId: string,
  body: UpdateOverlayRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<UpdateOverlayResponseData>>(
    `${itemPath(workspaceId, itemId)}/overlay`,
    body,
    config,
  );
  return response.data;
}

/** 202: queues every integration that can sync now. */
export async function syncNow(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.post<ApiSuccessResponse<SyncAllResponseData>>(
    `${wsPath(workspaceId)}/sync`,
    undefined,
    config,
  );
  return response.data;
}

export async function listSyncRuns(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<ListSyncRunsResponseData>>(
    `${wsPath(workspaceId)}/sync-runs?limit=20`,
    config,
  );
  return response.data;
}
