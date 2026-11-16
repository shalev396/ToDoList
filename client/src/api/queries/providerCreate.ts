import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import {
  createCopy,
  createItem,
  getCreateOptions,
  getCreateTargets,
  type CreateItemBody,
} from '@/api/services/providerCreateService';
import type { CreateCopyRequestBody, CreateOptionsQuery } from '@api-types/providerCreate.ts';

/** The caller's own integrations that can create items, one chip each (editors and up). */
export function useCreateTargets(workspaceId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.createTargets(workspaceId ?? ''),
    enabled: workspaceId !== null && enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const response = await getCreateTargets(workspaceId ?? '', {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** One funnel step's choices; asked only once its parents are answered (`query` not null). */
export function useCreateOptions(
  workspaceId: string,
  integrationId: string,
  query: CreateOptionsQuery | null,
) {
  return useQuery({
    queryKey: queryKeys.createOptions(workspaceId, integrationId, query),
    enabled: query !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (query === null) {
        throw new Error('The step has no question yet');
      }
      const response = await getCreateOptions(workspaceId, integrationId, query, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** A new local to-do; the list blocks refetch. */
export function useCreateLocalItem(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateItemBody) => {
      const response = await createItem(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'block' }),
  });
}

/** One provider copy of a to-do; the blocks refetch (the row's chips change). */
export function useCreateCopy(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { itemId: string; body: CreateCopyRequestBody }) => {
      const response = await createCopy(workspaceId, input.itemId, input.body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    onSettled: () => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[2] === 'block' }),
  });
}
