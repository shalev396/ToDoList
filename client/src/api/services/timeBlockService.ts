import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type { ApiSuccessResponse } from '@api-types/api-contracts';
import type {
  CreateTimeBlockRequest,
  EditTimeBlockRequest,
  SkipOccurrenceRequest,
  TimeBlockResponseData,
} from '@api-types/timeBlocks.ts';

function blocksPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/time-blocks`;
}

function blockPath(workspaceId: string, blockId: string): string {
  return `${blocksPath(workspaceId)}/${encodeURIComponent(blockId)}`;
}

/** `POST …/time-blocks`: a time block or an area (201; 200 for a repeated idempotency key). */
export async function createTimeBlock(
  workspaceId: string,
  body: CreateTimeBlockRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<TimeBlockResponseData>>(
    blocksPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

/** `PATCH …/time-blocks/:id`: this occurrence's times, or the whole series. */
export async function editTimeBlock(
  workspaceId: string,
  blockId: string,
  body: EditTimeBlockRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<TimeBlockResponseData>>(
    blockPath(workspaceId, blockId),
    body,
    config,
  );
  return response.data;
}

/** `POST …/time-blocks/:id/skip`: leaves one occurrence out. */
export async function skipOccurrence(
  workspaceId: string,
  blockId: string,
  body: SkipOccurrenceRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<TimeBlockResponseData>>(
    `${blockPath(workspaceId, blockId)}/skip`,
    body,
    config,
  );
  return response.data;
}
