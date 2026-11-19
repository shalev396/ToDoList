import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  CreateAttributeRequestBody,
  CreateAttributeResponseData,
  DeleteAttributeResponseData,
  ListAttributesResponseData,
  SubjectMatchCountsRequestBody,
  SubjectMatchCountsResponseData,
  UpdateAttributeRequestBody,
  UpdateAttributeResponseData,
} from '@api-types/api-contracts';

function attributesPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/attributes`;
}

/** The workspace's custom attributes, the built-in Importance first. */
export async function listAttributes(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<ListAttributesResponseData>>(
    attributesPath(workspaceId),
    config,
  );
  return response.data;
}

export async function createAttribute(
  workspaceId: string,
  body: CreateAttributeRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<CreateAttributeResponseData>>(
    attributesPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

export async function updateAttribute(
  workspaceId: string,
  key: string,
  body: UpdateAttributeRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<UpdateAttributeResponseData>>(
    `${attributesPath(workspaceId)}/${encodeURIComponent(key)}`,
    body,
    config,
  );
  return response.data;
}

export async function deleteAttribute(workspaceId: string, key: string, config?: ApiRequestConfig) {
  const response = await api.delete<ApiSuccessResponse<DeleteAttributeResponseData>>(
    `${attributesPath(workspaceId)}/${encodeURIComponent(key)}`,
    config,
  );
  return response.data;
}

/** How many of the caller's items each subject (in order) would take; `capped` past the scan limit. */
export async function matchCounts(
  workspaceId: string,
  body: SubjectMatchCountsRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<SubjectMatchCountsResponseData>>(
    `${attributesPath(workspaceId)}/subject/match-counts`,
    body,
    config,
  );
  return response.data;
}
