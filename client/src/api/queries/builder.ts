import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import {
  getBuilderCatalog,
  instantiatePersona,
  listPersonas,
  listTemplates,
  listViewTemplates,
} from '@/api/services/builderService';

/** The Logic Bridge's catalog: block types, fields and their operators, presets, caps. */
export function useBuilderCatalog(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.catalog(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getBuilderCatalog(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** The template gallery. */
export function useTemplates(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.templates(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled,
    queryFn: async ({ signal }) => {
      const response = await listTemplates(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** The view templates "+ Add view" offers. */
export function useViewTemplates(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.viewTemplates(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled,
    queryFn: async ({ signal }) => {
      const response = await listViewTemplates(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** The persona templates, smallest first. */
export function usePersonas(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.personas(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled,
    queryFn: async ({ signal }) => {
      const response = await listPersonas(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/**
 * Makes a persona's topics, pages, views and blocks. Idempotent per topic slug, so a retry is
 * safe. Refreshes the topics (the sidebar), the dashboards and what is shared.
 */
export function useInstantiatePersona(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      key: string;
      language: 'en' | 'he';
      shareIntegrations: boolean;
    }) => {
      const response = await instantiatePersona(
        workspaceId,
        input.key,
        { language: input.language, shareIntegrations: input.shareIntegrations },
        { suppressErrorToast: true },
      );
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.topics(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.integrationSharing(workspaceId) });
    },
  });
}
