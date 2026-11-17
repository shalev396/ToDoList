import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace,
} from '@/api/services/workspaceService';
import { selectIsAuthenticated } from '@/store/userSlice';
import type {
  CreateWorkspaceRequestBody,
  ListWorkspacesResponseData,
  UpdateWorkspaceRequestBody,
} from '@api-types/api-contracts';

/** My workspaces with my role and area scope, oldest membership first. */
export function useWorkspaces() {
  const isAuthenticated = useSelector(selectIsAuthenticated);
  return useQuery({
    queryKey: queryKeys.workspaces,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    // Back in the tab: a removal or a deleted workspace is noticed (useWorkspaceReconciler).
    refetchOnWindowFocus: 'always',
    enabled: isAuthenticated,
    queryFn: async () => {
      const response = await listWorkspaces();
      return response.data;
    },
  });
}

/**
 * Errors are left to the form (the slug and the workspace cap answer 409). The new
 * workspace goes into the cached list at once, so switching to it never meets a list without it.
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateWorkspaceRequestBody) => {
      const response = await createWorkspace(body, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: (created) => {
      queryClient.setQueryData<ListWorkspacesResponseData>(queryKeys.workspaces, (list) => [
        ...(list ?? []).filter((entry) => entry.workspace.id !== created.id),
        { workspace: created, role: 'owner' },
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

/**
 * After I left or deleted a workspace: it leaves my cached list (and the list is refetched).
 * useWorkspaceReconciler then sees the current workspace gone and runs the one reset every
 * workspace change uses: in-flight fetches cancelled, cached workspace data dropped, pages
 * remounted, my oldest workspace's dashboard, or onboarding when none is left.
 */
export function useDropWorkspace(): (workspaceId: string) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (workspaceId: string) => {
      queryClient.setQueryData<ListWorkspacesResponseData>(queryKeys.workspaces, (list) =>
        list?.filter((entry) => entry.workspace.id !== workspaceId),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
    [queryClient],
  );
}

/** Owner only. The list is patched in place, so the sidebar and switcher update at once. */
export function useUpdateWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateWorkspaceRequestBody) => {
      const response = await updateWorkspace(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ListWorkspacesResponseData>(queryKeys.workspaces, (list) =>
        list?.map((entry) =>
          entry.workspace.id === updated.id ? { ...entry, workspace: updated } : entry,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useDeleteWorkspace(workspaceId: string) {
  return useMutation({
    mutationFn: async () => {
      await deleteWorkspace(workspaceId, { suppressErrorToast: true });
    },
  });
}
