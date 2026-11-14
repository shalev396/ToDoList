import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  ConsumeConnectLinkResponseData,
  CreateIntegrationRequestBody,
  GcalSyncRequestBody,
  GcalSyncResponseData,
  CreateIntegrationResponseData,
  GetIntegrationConfigResponseData,
  IntegrationSharingResponseData,
  ListGoogleCalendarsResponseData,
  ListIntegrationsResponseData,
  SaveCredentialRequestBody,
  StartGoogleCalendarOAuthRequestBody,
  StartGoogleCalendarOAuthResponseData,
  StartProviderOAuthRequestBody,
  StartProviderOAuthResponseData,
  ListOAuthProvidersResponseData,
  ListOAuthResourcesResponseData,
  StopSharingResponseData,
  SyncIntegrationResponseData,
  TestIntegrationResponseData,
  UpdateIntegrationRequestBody,
  UpdateIntegrationResponseData,
} from '@api-types/api-contracts';
import type { OAuthSignInProvider } from '@api-types/integrations';

/** Integrations (server/src/routes/private/integrations.ts). Never a secret in a response. */
function wsPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}`;
}

function integrationPath(workspaceId: string, integrationId: string): string {
  return `${wsPath(workspaceId)}/integrations/${encodeURIComponent(integrationId)}`;
}

export async function listIntegrations(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<ListIntegrationsResponseData>>(
    `${wsPath(workspaceId)}/integrations`,
    config,
  );
  return response.data;
}

export async function createIntegration(
  workspaceId: string,
  body: CreateIntegrationRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<CreateIntegrationResponseData>>(
    `${wsPath(workspaceId)}/integrations`,
    body,
    config,
  );
  return response.data;
}

/**
 * `PUT …/credential`: 204. The body is the secret, so this is called directly (never through a
 * mutation hook, whose variables the mutation cache would keep) and the error is never logged.
 */
export async function saveCredential(
  workspaceId: string,
  integrationId: string,
  body: SaveCredentialRequestBody,
) {
  await api.put(`${integrationPath(workspaceId, integrationId)}/credential`, body, {
    suppressErrorToast: true,
  });
}

export async function testIntegration(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<TestIntegrationResponseData>>(
    `${integrationPath(workspaceId, integrationId)}/test`,
    undefined,
    config,
  );
  return response.data;
}

export async function updateIntegration(
  workspaceId: string,
  integrationId: string,
  body: UpdateIntegrationRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<UpdateIntegrationResponseData>>(
    integrationPath(workspaceId, integrationId),
    body,
    config,
  );
  return response.data;
}

export async function deleteIntegration(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  await api.delete(integrationPath(workspaceId, integrationId), config);
}

/** Which of my own integrations are shared: a connector on some block (ids only). */
export async function getIntegrationSharing(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<IntegrationSharingResponseData>>(
    `${wsPath(workspaceId)}/integrations/sharing`,
    config,
  );
  return response.data;
}

/** "Stop sharing": the integration's connector comes off every block of the workspace. */
export async function stopSharingIntegration(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<StopSharingResponseData>>(
    `${integrationPath(workspaceId, integrationId)}/stop-sharing`,
    undefined,
    config,
  );
  return response.data;
}

export async function syncIntegration(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<SyncIntegrationResponseData>>(
    `${integrationPath(workspaceId, integrationId)}/sync`,
    undefined,
    config,
  );
  return response.data;
}

export async function consumeConnectLink(
  workspaceId: string,
  link: string,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<ConsumeConnectLinkResponseData>>(
    `${wsPath(workspaceId)}/connect-links/consume`,
    { link },
    config,
  );
  return response.data;
}

/** `POST …/gcal-sync`: a dry run (200, counts) or, with `confirm`, 202 `{runId}`. */
export async function gcalSync(
  workspaceId: string,
  body: GcalSyncRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<GcalSyncResponseData>>(
    `${wsPath(workspaceId)}/gcal-sync`,
    body,
    config,
  );
  return response.data;
}

/**
 * `POST …/integrations/google-calendar/oauth/start`: the Google URL to send the browser to. The
 * answer also sets an HttpOnly cookie that ties the flow to this browser, so the call is made with
 * credentials (it matters when the API is on another origin, as in local development).
 */
export async function startGoogleCalendarOAuth(
  workspaceId: string,
  body: StartGoogleCalendarOAuthRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<StartGoogleCalendarOAuthResponseData>>(
    `${wsPath(workspaceId)}/integrations/google-calendar/oauth/start`,
    body,
    { ...config, withCredentials: true },
  );
  return response.data;
}

/** `GET …/integrations/:iid/calendars`: a Google account's calendars, for the picker. */
export async function listGoogleCalendars(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  const response = await api.get<ApiSuccessResponse<ListGoogleCalendarsResponseData>>(
    `${integrationPath(workspaceId, integrationId)}/calendars`,
    config,
  );
  return response.data;
}

/** `GET …/integrations/:iid/config` (owner): the non-secret settings, never a credential. */
export async function getIntegrationConfig(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  const response = await api.get<ApiSuccessResponse<GetIntegrationConfigResponseData>>(
    `${integrationPath(workspaceId, integrationId)}/config`,
    config,
  );
  return response.data;
}

/**
 * `POST …/integrations/oauth/:provider/start` (GitHub, Jira, ClickUp, Linear): the provider's
 * authorize URL to send the browser to. Like Google's, it also sets the HttpOnly binding cookie.
 */
export async function startProviderOAuth(
  workspaceId: string,
  provider: OAuthSignInProvider,
  body: StartProviderOAuthRequestBody,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<StartProviderOAuthResponseData>>(
    `${wsPath(workspaceId)}/integrations/oauth/${provider}/start`,
    body,
    { ...config, withCredentials: true },
  );
  return response.data;
}

/** `GET …/integrations/oauth/providers` (owner): which providers can sign in, and the setup guide data. */
export async function listOAuthProviders(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<ListOAuthProvidersResponseData>>(
    `${wsPath(workspaceId)}/integrations/oauth/providers`,
    config,
  );
  return response.data;
}

/** `GET …/integrations/:iid/oauth/resources` (owner): the Jira sites or ClickUp workspaces of a grant. */
export async function listOAuthResources(
  workspaceId: string,
  integrationId: string,
  config?: ApiRequestConfig,
) {
  const response = await api.get<ApiSuccessResponse<ListOAuthResourcesResponseData>>(
    `${integrationPath(workspaceId, integrationId)}/oauth/resources`,
    config,
  );
  return response.data;
}
