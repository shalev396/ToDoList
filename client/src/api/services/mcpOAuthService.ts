import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  ApproveConsentRequestBody,
  ApproveConsentResponseData,
  DenyConsentResponseData,
  GetConsentResponseData,
} from '@api-types/api-contracts';

/** The agent sign-in consent API (server/src/routes/private/mcpOAuth.ts). */
function requestPath(requestId: string): string {
  return `/private/mcp-oauth/requests/${encodeURIComponent(requestId)}`;
}

export async function getConsent(requestId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<GetConsentResponseData>>(
    requestPath(requestId),
    config,
  );
  return response.data;
}

export async function approveConsent(
  requestId: string,
  body: ApproveConsentRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<ApproveConsentResponseData>>(
    `${requestPath(requestId)}/approve`,
    body,
    config,
  );
  return response.data;
}

export async function denyConsent(requestId: string, config?: ApiRequestConfig) {
  const response = await api.post<ApiSuccessResponse<DenyConsentResponseData>>(
    `${requestPath(requestId)}/deny`,
    undefined,
    config,
  );
  return response.data;
}
