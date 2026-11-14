import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type { ApiSuccessResponse, ItemDetail } from '@api-types/api-contracts';
import type {
  CreateCopyRequestBody,
  CreateCopyResponseData,
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTargetsResponseData,
} from '@api-types/providerCreate.ts';

function wsPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** What `POST …/items` takes (routes/private/items.ts). */
export interface CreateItemBody {
  title: string;
  note?: string;
  dueAt?: string | null;
  allDay?: boolean;
  topicId?: string | null;
  priority?: number | null;
  idempotencyKey?: string;
}

/** `POST …/items`: a local to-do. */
export async function createItem(
  workspaceId: string,
  body: CreateItemBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<ItemDetail>>(
    `${wsPath(workspaceId)}/items`,
    body,
    config,
  );
  return response.data;
}

/** `GET …/provider-create/targets`: a chip per own integration that can create items. */
export async function getCreateTargets(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<CreateTargetsResponseData>>(
    `${wsPath(workspaceId)}/provider-create/targets`,
    config,
  );
  return response.data;
}

/** `GET …/integrations/:iid/create-options`: one funnel step's choices. */
export async function getCreateOptions(
  workspaceId: string,
  integrationId: string,
  query: CreateOptionsQuery,
  config?: ApiRequestConfig,
) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query) as [string, string | undefined][]) {
    if (value !== undefined) {
      params.set(name, value);
    }
  }
  const response = await api.get<ApiSuccessResponse<CreateOptionsResponseData>>(
    `${wsPath(workspaceId)}/integrations/${encodeURIComponent(integrationId)}/create-options?${params.toString()}`,
    config,
  );
  return response.data;
}

/** `POST …/items/:id/copies`: creates the to-do's copy in one provider. */
export async function createCopy(
  workspaceId: string,
  itemId: string,
  body: CreateCopyRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<CreateCopyResponseData>>(
    `${wsPath(workspaceId)}/items/${encodeURIComponent(itemId)}/copies`,
    body,
    config,
  );
  return response.data;
}
