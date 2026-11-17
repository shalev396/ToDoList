import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  GetViewResponseData,
  ListViewsResponseData,
} from '@api-types/api-contracts';

/** Saved views: a named query + viz that blocks reference (server/src/routes/private/views.ts). */
function viewsPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/views`;
}

/** By title. */
export async function listViews(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListViewsResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListViewsResponseData>>(
    viewsPath(workspaceId),
    config,
  );
  return response.data;
}

export async function getView(
  workspaceId: string,
  viewId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<GetViewResponseData>> {
  const response = await api.get<ApiSuccessResponse<GetViewResponseData>>(
    `${viewsPath(workspaceId)}/${encodeURIComponent(viewId)}`,
    config,
  );
  return response.data;
}
