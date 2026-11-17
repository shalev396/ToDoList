import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  CreateTopicRequestBody,
  CreateTopicResponseData,
  DeleteTopicResponseData,
  ListTopicsResponseData,
  UpdateTopicRequestBody,
  UpdateTopicResponseData,
} from '@api-types/api-contracts';

function topicsPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/topics`;
}

/** The workspace's topics (its pages), in sidebar order. */
export async function listTopics(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListTopicsResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListTopicsResponseData>>(
    topicsPath(workspaceId),
    config,
  );
  return response.data;
}

/** "+ Add page": the topic and its first page. */
export async function createTopic(
  workspaceId: string,
  body: CreateTopicRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<CreateTopicResponseData>> {
  const response = await api.post<ApiSuccessResponse<CreateTopicResponseData>>(
    topicsPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

export async function updateTopic(
  workspaceId: string,
  topicId: string,
  body: UpdateTopicRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<UpdateTopicResponseData>> {
  const response = await api.patch<ApiSuccessResponse<UpdateTopicResponseData>>(
    `${topicsPath(workspaceId)}/${encodeURIComponent(topicId)}`,
    body,
    config,
  );
  return response.data;
}

/** Its pages go; its items stay, Unsorted. */
export async function deleteTopic(
  workspaceId: string,
  topicId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<DeleteTopicResponseData>> {
  const response = await api.delete<ApiSuccessResponse<DeleteTopicResponseData>>(
    `${topicsPath(workspaceId)}/${encodeURIComponent(topicId)}`,
    config,
  );
  return response.data;
}
