import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type { ApiSuccessResponse, RuntimeResponseData } from '@api-types/api-contracts';

/** Stage facts: the stage, and whether onboarding offers demo data. */
export async function getRuntime(
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<RuntimeResponseData>> {
  const response = await api.get<ApiSuccessResponse<RuntimeResponseData>>(
    '/public/runtime',
    config,
  );
  return response.data;
}
