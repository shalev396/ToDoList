import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { listAgentKeys, revokeAgentKey } from '@/api/services/agentKeyService';

/** Keys without their secret. Creating one is not a mutation here: its answer holds the raw key. */
export function useAgentKeys(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.agentKeys(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listAgentKeys(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

export function useRefreshAgentKeys(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.agentKeys(workspaceId) });
}

export function useRevokeAgentKey(workspaceId: string) {
  const refresh = useRefreshAgentKeys(workspaceId);
  return useMutation({
    mutationFn: (keyId: string) => revokeAgentKey(workspaceId, keyId, { suppressErrorToast: true }),
    onSuccess: refresh,
  });
}
