import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { getView, listViews } from '@/api/services/viewService';

/** Saved views (a named query + viz), by title. */
export function useViews(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.views(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listViews(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

export function useView(workspaceId: string, viewId: string) {
  return useQuery({
    queryKey: queryKeys.view(workspaceId, viewId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getView(workspaceId, viewId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}
