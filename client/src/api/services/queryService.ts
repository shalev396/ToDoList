import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  RunQueryRequestBody,
  RunQueryResponseData,
} from '@api-types/api-contracts';

/**
 * `POST /workspaces/:wid/query` (server/src/routes/private/query.ts): exactly one of
 * `{dashboardId, blockId}` (the draft for editors, the published copy for viewers),
 * `{savedQueryId}` or `{draft, blockType?, preview}`, plus `vars` (`{"$page.x": value}`).
 */
export async function runQuery(
  workspaceId: string,
  body: RunQueryRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<RunQueryResponseData>> {
  const response = await api.post<ApiSuccessResponse<RunQueryResponseData>>(
    `/private/workspaces/${encodeURIComponent(workspaceId)}/query`,
    body,
    config,
  );
  return response.data;
}
