import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type {
  ApiSuccessResponse,
  ApplyOpsRequestBody,
  ApplyOpsResponseData,
  CreateDashboardRequestBody,
  CreateDashboardResponseData,
  GetDashboardResponseData,
  ListDashboardsQuery,
  ListDashboardsResponseData,
  ListDashboardVersionsResponseData,
  PublishDashboardResponseData,
  RedoDashboardRequestBody,
  RedoDashboardResponseData,
  UndoDashboardRequestBody,
  UndoDashboardResponseData,
  UpdateLayoutRequestBody,
  UpdateLayoutResponseData,
} from '@api-types/api-contracts';
import type { DashboardCopy } from '@api-types/dashboards';

/**
 * Dashboards (server/src/routes/private/dashboards.ts). Writes carry `expectedVersion`; a stale one
 * answers 409 `{message, currentVersion}`. An owner's writes publish at once, anyone else's wait.
 */
function dashboardsPath(workspaceId: string): string {
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/dashboards`;
}

function dashboardPath(workspaceId: string, dashboardId: string): string {
  return `${dashboardsPath(workspaceId)}/${encodeURIComponent(dashboardId)}`;
}

/** Oldest first. `topic: 'main'` lists the main dashboards. */
export async function listDashboards(
  workspaceId: string,
  filter: ListDashboardsQuery,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListDashboardsResponseData>> {
  const params = new URLSearchParams();
  if (filter.topic !== undefined) {
    params.set('topic', filter.topic);
  }
  if (filter.page !== undefined) {
    params.set('page', filter.page);
  }
  const query = params.toString();
  const response = await api.get<ApiSuccessResponse<ListDashboardsResponseData>>(
    query === '' ? dashboardsPath(workspaceId) : `${dashboardsPath(workspaceId)}?${query}`,
    config,
  );
  return response.data;
}

/** Viewers always get the published copy, whatever `as` says. */
export async function getDashboard(
  workspaceId: string,
  dashboardId: string,
  as: DashboardCopy,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<GetDashboardResponseData>> {
  const response = await api.get<ApiSuccessResponse<GetDashboardResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}?as=${as}`,
    config,
  );
  return response.data;
}

/** 201, at version 1. `fromTemplate` + `language` start it from a template. */
export async function createDashboard(
  workspaceId: string,
  body: CreateDashboardRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<CreateDashboardResponseData>> {
  const response = await api.post<ApiSuccessResponse<CreateDashboardResponseData>>(
    dashboardsPath(workspaceId),
    body,
    config,
  );
  return response.data;
}

/** Block positions per breakpoint; blocks not listed keep theirs. */
export async function updateDashboardLayout(
  workspaceId: string,
  dashboardId: string,
  body: UpdateLayoutRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<UpdateLayoutResponseData>> {
  const response = await api.put<ApiSuccessResponse<UpdateLayoutResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}/layout`,
    body,
    config,
  );
  return response.data;
}

/** Builder ops (`remove_block`, …) applied as one version, or a dry run. */
export async function applyDashboardOps(
  workspaceId: string,
  dashboardId: string,
  body: ApplyOpsRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ApplyOpsResponseData>> {
  const response = await api.post<ApiSuccessResponse<ApplyOpsResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}/ops`,
    body,
    config,
  );
  return response.data;
}

/** Newest first. Editors and owners. */
export async function listDashboardVersions(
  workspaceId: string,
  dashboardId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<ListDashboardVersionsResponseData>> {
  const response = await api.get<ApiSuccessResponse<ListDashboardVersionsResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}/versions`,
    config,
  );
  return response.data;
}

/** 409 without `currentVersion` when there is nothing to undo. */
export async function undoDashboard(
  workspaceId: string,
  dashboardId: string,
  body: UndoDashboardRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<UndoDashboardResponseData>> {
  const response = await api.post<ApiSuccessResponse<UndoDashboardResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}/undo`,
    body,
    config,
  );
  return response.data;
}

/** Only right after an undo; otherwise 409 without `currentVersion`. */
export async function redoDashboard(
  workspaceId: string,
  dashboardId: string,
  body: RedoDashboardRequestBody,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<RedoDashboardResponseData>> {
  const response = await api.post<ApiSuccessResponse<RedoDashboardResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}/redo`,
    body,
    config,
  );
  return response.data;
}

/** Owners: viewers see the current draft from now on. */
export async function publishDashboard(
  workspaceId: string,
  dashboardId: string,
  config?: ApiRequestConfig,
): Promise<ApiSuccessResponse<PublishDashboardResponseData>> {
  const response = await api.post<ApiSuccessResponse<PublishDashboardResponseData>>(
    `${dashboardPath(workspaceId, dashboardId)}/publish`,
    undefined,
    config,
  );
  return response.data;
}
