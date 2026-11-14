import { useStore } from 'react-redux';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys, type DashboardsFilter } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import {
  applyDashboardOps,
  createDashboard,
  getDashboard,
  listDashboards,
  listDashboardVersions,
  publishDashboard,
  redoDashboard,
  undoDashboard,
  updateDashboardLayout,
} from '@/api/services/dashboardService';
import type {
  ApplyOpsRequestBody,
  CreateDashboardRequestBody,
  ListDashboardsQuery,
  ListDashboardsResponseData,
  RedoDashboardRequestBody,
  UndoDashboardRequestBody,
  UpdateLayoutRequestBody,
} from '@api-types/api-contracts';
import type { DashboardCopy, DashboardSummary, DashboardView } from '@api-types/dashboards';
import type { RootState } from '@/store';

/**
 * Dashboards. Reads report their own failures (the page shows an error state, not a toast); writes
 * leave theirs to the caller, which knows what a 409 means there.
 */

/** A dashboard as the lists show it. */
export function dashboardSummary(view: DashboardView): DashboardSummary {
  return {
    id: view.id,
    title: view.title,
    scope: view.scope,
    templateKey: view.templateKey,
    visibility: view.visibility,
    version: view.version,
    publishedVersion: view.publishedVersion,
    updatedAt: view.updatedAt,
  };
}

/** Oldest first. Viewers only get published dashboards. */
export function useDashboards(workspaceId: string, filter: ListDashboardsQuery) {
  return useQuery({
    queryKey: queryKeys.dashboards(workspaceId, filter),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listDashboards(workspaceId, filter, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** The draft (editors and owners) or the published copy (everyone; viewers always get it). */
export function useDashboard(workspaceId: string, dashboardId: string, as: DashboardCopy) {
  return useQuery({
    queryKey: queryKeys.dashboard(workspaceId, dashboardId, as),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getDashboard(workspaceId, dashboardId, as, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** The history, newest first (editors and owners): what Undo and Redo can do. */
export function useDashboardVersions(workspaceId: string, dashboardId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.dashboardVersions(workspaceId, dashboardId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled,
    queryFn: async ({ signal }) => {
      const response = await listDashboardVersions(workspaceId, dashboardId, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/**
 * Creates a dashboard (from a template). The new one goes into the list it was made for at once,
 * so the page shows it without a round trip, and every list is refreshed behind it; not after an
 * workspace switch (sameWorkspace).
 */
export function useCreateDashboard(workspaceId: string) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: async ({
      body,
    }: {
      body: CreateDashboardRequestBody;
      filter: DashboardsFilter;
    }) => {
      const response = await createDashboard(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (created: DashboardView, { filter }: { filter: DashboardsFilter }) => {
        queryClient.setQueryData(queryKeys.dashboard(workspaceId, created.id, 'draft'), created);
        queryClient.setQueryData<ListDashboardsResponseData>(
          queryKeys.dashboards(workspaceId, filter),
          (list) => [
            ...(list ?? []).filter((entry) => entry.id !== created.id),
            dashboardSummary(created),
          ],
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards(workspaceId) });
        // A template may have attached (shared) integrations.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.integrationSharing(workspaceId),
        });
      },
    ),
  });
}

/** After a write that may add or remove a block's connectors: what is shared may have changed. */
function useRefreshSharing(workspaceId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.integrationSharing(workspaceId) });
  };
}

/** `PUT …/layout`: block positions per breakpoint, against `expectedVersion`. */
export function useUpdateDashboardLayout(workspaceId: string, dashboardId: string) {
  return useMutation({
    mutationFn: async (body: UpdateLayoutRequestBody) => {
      const response = await updateDashboardLayout(workspaceId, dashboardId, body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** `POST …/ops`: builder ops (`remove_block`, …) as one version, or a dry run. */
export function useApplyDashboardOps(workspaceId: string, dashboardId: string) {
  const refreshSharing = useRefreshSharing(workspaceId);
  return useMutation({
    mutationFn: async (body: ApplyOpsRequestBody) => {
      const response = await applyDashboardOps(workspaceId, dashboardId, body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    onSuccess: refreshSharing,
  });
}

export function useUndoDashboard(workspaceId: string, dashboardId: string) {
  const refreshSharing = useRefreshSharing(workspaceId);
  return useMutation({
    mutationFn: async (body: UndoDashboardRequestBody) => {
      const response = await undoDashboard(workspaceId, dashboardId, body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    onSuccess: refreshSharing,
  });
}

export function useRedoDashboard(workspaceId: string, dashboardId: string) {
  const refreshSharing = useRefreshSharing(workspaceId);
  return useMutation({
    mutationFn: async (body: RedoDashboardRequestBody) => {
      const response = await redoDashboard(workspaceId, dashboardId, body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    onSuccess: refreshSharing,
  });
}

/** Owners: viewers see the current draft from now on. */
export function usePublishDashboard(workspaceId: string, dashboardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await publishDashboard(workspaceId, dashboardId, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardCopies(workspaceId, dashboardId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards(workspaceId) });
    },
  });
}
