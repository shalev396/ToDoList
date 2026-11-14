import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  BuilderCatalogResponseData,
  InstantiatePersonaRequestBody,
  InstantiatePersonaResponseData,
  ListPersonasResponseData,
  ListTemplatesResponseData,
  ListViewTemplatesResponseData,
  TemplateSharesRequestBody,
  TemplateSharesResponseData,
  ValidateDraftRequestBody,
  ValidateDraftResponseData,
} from '@api-types/api-contracts';

/** The Logic Bridge's catalog and templates (server/src/routes/private/builder.ts). */
function builderPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/builder`;
}

/** Block types, fields with their operators, date presets, caps and JSON Schemas. */
export async function getBuilderCatalog(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<BuilderCatalogResponseData>> {
  const response = await api.get<ApiSuccessResponse<BuilderCatalogResponseData>>(
    `${builderPath(workspaceId)}/catalog`,
    config,
  );
  return response.data;
}

/** The template gallery: keys, titles in both languages and block types. */
export async function listTemplates(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListTemplatesResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListTemplatesResponseData>>(
    `${builderPath(workspaceId)}/templates`,
    config,
  );
  return response.data;
}

/** The view templates "+ Add view" offers. */
export async function listViewTemplates(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListViewTemplatesResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListViewTemplatesResponseData>>(
    `${builderPath(workspaceId)}/view-templates`,
    config,
  );
  return response.data;
}

/** The persona templates, smallest first. */
export async function listPersonas(
  workspaceId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListPersonasResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListPersonasResponseData>>(
    `${builderPath(workspaceId)}/personas`,
    config,
  );
  return response.data;
}

/** Makes a persona's topics, pages, views and blocks (idempotent per topic slug). */
export async function instantiatePersona(
  workspaceId: string,
  key: string,
  body: InstantiatePersonaRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<InstantiatePersonaResponseData>> {
  const response = await api.post<ApiSuccessResponse<InstantiatePersonaResponseData>>(
    `${builderPath(workspaceId)}/personas/${encodeURIComponent(key)}/instantiate`,
    body,
    config,
  );
  return response.data;
}

/** A whole dashboard draft, checked as a save would check it (lint warnings included); no write. */
export async function validateDraft(
  workspaceId: string,
  body: ValidateDraftRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ValidateDraftResponseData>> {
  const response = await api.post<ApiSuccessResponse<ValidateDraftResponseData>>(
    `${builderPath(workspaceId)}/validate`,
    body,
    config,
  );
  return response.data;
}

/**
 * What instantiating these templates would share: the caller's own integrations a template would
 * attach that no block holds yet (empty: nothing to ask). No write.
 */
export async function getTemplateShares(
  workspaceId: string,
  body: TemplateSharesRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<TemplateSharesResponseData>> {
  const response = await api.post<ApiSuccessResponse<TemplateSharesResponseData>>(
    `${builderPath(workspaceId)}/template-shares`,
    body,
    config,
  );
  return response.data;
}
