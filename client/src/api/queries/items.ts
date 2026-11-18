import { useStore } from 'react-redux';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import {
  deleteItem,
  getFacets,
  getItem,
  listSyncRuns,
  syncNow,
  updateItem,
  updateOverlay,
} from '@/api/services/itemService';
import type { RootState } from '@/store';
import type {
  ItemDetail,
  UpdateItemRequestBody,
  UpdateOverlayRequestBody,
} from '@api-types/api-contracts';

/** What is present in the workspace, inside my access: the only source of filter options. */
/** The facets the viewer may see; `connectors` narrows them to those sources (ruling 13). */
export function useFacets(workspaceId: string | null, connectors?: readonly string[]) {
  return useQuery({
    queryKey:
      connectors === undefined
        ? queryKeys.facets(workspaceId ?? '')
        : [...queryKeys.facets(workspaceId ?? ''), connectors.join(',')],
    enabled: workspaceId !== null,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getFacets(
        workspaceId ?? '',
        { signal, suppressErrorToast: true },
        connectors,
      );
      return response.data;
    },
  });
}

export function useItem(workspaceId: string | null, itemId: string | null) {
  return useQuery({
    queryKey: queryKeys.item(workspaceId ?? '', itemId ?? ''),
    enabled: workspaceId !== null && itemId !== null,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getItem(workspaceId ?? '', itemId ?? '', {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** An edit or overlay change answers the updated item: it replaces the cached one. */
function useItemWrite<V>(
  workspaceId: string,
  itemId: string,
  call: (body: V) => Promise<ItemDetail>,
) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: call,
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (updated: ItemDetail) => {
        queryClient.setQueryData(queryKeys.item(workspaceId, itemId), updated);
        // Rows in blocks show the title, status and overlay: refetch them.
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'block' });
      },
    ),
  });
}

/** Local items only (a mirrored item answers 409 `{message, openIn}`). */
export function useUpdateItem(workspaceId: string, itemId: string) {
  return useItemWrite(workspaceId, itemId, async (body: UpdateItemRequestBody) => {
    const response = await updateItem(workspaceId, itemId, body, { suppressErrorToast: true });
    return response.data;
  });
}

/** The overlay: pin, note, hide, topic override. Any item; never written to the provider. */
export function useUpdateOverlay(workspaceId: string, itemId: string) {
  return useItemWrite(workspaceId, itemId, async (body: UpdateOverlayRequestBody) => {
    const response = await updateOverlay(workspaceId, itemId, body, { suppressErrorToast: true });
    return response.data;
  });
}

/**
 * Deletes an item (a to-do, a time block or an area) by id; the blocks' data refetch. The caller
 * closes its sheet (its detail, read again, would be gone). Skipped when the workspace changed in
 * flight.
 */
export function useDeleteItem(workspaceId: string) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: (itemId: string) => deleteItem(workspaceId, itemId, { suppressErrorToast: true }),
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      () => {
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'block' });
      },
    ),
  });
}

/** "Sync now": 202 with run ids. */
export function useSyncNow(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await syncNow(workspaceId, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.syncRuns(workspaceId) }),
  });
}

/** The newest sync runs; polls every 3 s while `poll` is true. */
export function useSyncRuns(workspaceId: string | null, poll: boolean) {
  return useQuery({
    queryKey: queryKeys.syncRuns(workspaceId ?? ''),
    enabled: workspaceId !== null,
    refetchInterval: poll ? 3000 : false,
    queryFn: async ({ signal }) => {
      const response = await listSyncRuns(workspaceId ?? '', { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}
