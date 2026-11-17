import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type { ApiSuccessResponse } from '@api-types/api-contracts';
import type { ItemStatus } from '@api-types/domain';

function itemPath(workspaceId: string, itemId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`;
}

/** `POST …/items/:id/complete` (editor, local items): `done` → done, else open. */
export async function completeItem(
  workspaceId: string,
  itemId: string,
  done: boolean,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse> {
  const response = await api.post<ApiSuccessResponse>(
    `${itemPath(workspaceId, itemId)}/complete`,
    { done },
    config,
  );
  return response.data;
}

/** `PATCH …/items/:id` (editor, local items): the kanban's drop sets the status. */
export async function setItemStatus(
  workspaceId: string,
  itemId: string,
  status: ItemStatus,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse> {
  const response = await api.patch<ApiSuccessResponse>(
    itemPath(workspaceId, itemId),
    { status },
    config,
  );
  return response.data;
}
