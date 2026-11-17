import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import {
  createAttribute,
  deleteAttribute,
  listAttributes,
  updateAttribute,
} from '@/api/services/attributeService';
import type {
  CreateAttributeRequestBody,
  UpdateAttributeRequestBody,
} from '@api-types/api-contracts';

const NO_WORKSPACE = '';

/** The workspace's custom attributes (the built-in Importance first). Idle without a workspace. */
export function useAttributes(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.attributes(workspaceId ?? NO_WORKSPACE),
    enabled: workspaceId !== null,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listAttributes(workspaceId ?? NO_WORKSPACE, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** A definition changed: the list, the catalog (attr.<key> fields) and block results are stale. */
function useRefreshAttributes(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.attributes(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog(workspaceId) });
  };
}

export function useCreateAttribute(workspaceId: string) {
  const refresh = useRefreshAttributes(workspaceId);
  return useMutation({
    mutationFn: async (body: CreateAttributeRequestBody) =>
      (await createAttribute(workspaceId, body, { suppressErrorToast: true })).data,
    onSuccess: refresh,
  });
}

export function useUpdateAttribute(workspaceId: string) {
  const refresh = useRefreshAttributes(workspaceId);
  return useMutation({
    mutationFn: async ({ key, body }: { key: string; body: UpdateAttributeRequestBody }) =>
      (await updateAttribute(workspaceId, key, body, { suppressErrorToast: true })).data,
    onSuccess: refresh,
  });
}

export function useDeleteAttribute(workspaceId: string) {
  const refresh = useRefreshAttributes(workspaceId);
  return useMutation({
    mutationFn: async (key: string) =>
      (await deleteAttribute(workspaceId, key, { suppressErrorToast: true })).data,
    onSuccess: refresh,
  });
}
