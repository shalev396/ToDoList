import { useStore } from 'react-redux';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import { createTopic, deleteTopic, listTopics, updateTopic } from '@/api/services/topicService';
import type {
  CreateTopicRequestBody,
  CreateTopicResponseData,
  ListTopicsResponseData,
  UpdateTopicRequestBody,
  UpdateTopicResponseData,
} from '@api-types/api-contracts';
import type { RootState } from '@/store';

const NO_WORKSPACE = '';

/** The workspace's topics (its pages), in sidebar order. Idle without a workspace. */
export function useTopics(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.topics(workspaceId ?? NO_WORKSPACE),
    enabled: workspaceId !== null,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async () => {
      const response = await listTopics(workspaceId ?? NO_WORKSPACE);
      return response.data;
    },
  });
}

/**
 * "+ Add page": the new topic joins the list at once; the dashboards are fetched again (its first
 * page is one). Nothing is written to the cache after a workspace switch.
 */
export function useCreateTopic(workspaceId: string) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: async (body: CreateTopicRequestBody) => {
      const response = await createTopic(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (created: CreateTopicResponseData) => {
        queryClient.setQueryData<ListTopicsResponseData>(queryKeys.topics(workspaceId), (list) => [
          ...(list ?? []).filter((topic) => topic.id !== created.topic.id),
          created.topic,
        ]);
        void queryClient.invalidateQueries({ queryKey: queryKeys.topics(workspaceId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboards(workspaceId) });
      },
    ),
  });
}

/** Rename (or recolour, move): the topic replaces its old self in the list. */
export function useUpdateTopic(workspaceId: string) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: async ({ topicId, body }: { topicId: string; body: UpdateTopicRequestBody }) => {
      const response = await updateTopic(workspaceId, topicId, body, { suppressErrorToast: true });
      return response.data;
    },
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (updated: UpdateTopicResponseData) => {
        queryClient.setQueryData<ListTopicsResponseData>(queryKeys.topics(workspaceId), (list) =>
          list?.map((topic) => (topic.id === updated.id ? updated : topic)),
        );
      },
    ),
  });
}

/**
 * Delete: the topic leaves the list; its pages go, and its items stay as Unsorted, so the
 * dashboards, blocks, items and facets are fetched again. `onDeleted` runs first, before the topic
 * leaves the list: whatever shows the topic (its sidebar row, its menu, its page) is gone right
 * after, so the caller leaves its page and says so there, not in a callback of `mutate`, which
 * would never run once its component is gone.
 */
export function useDeleteTopic(workspaceId: string, onDeleted?: (topicId: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (topicId: string) => {
      await deleteTopic(workspaceId, topicId, { suppressErrorToast: true });
      return topicId;
    },
    onSuccess: async (topicId) => {
      onDeleted?.(topicId);
      queryClient.setQueryData<ListTopicsResponseData>(queryKeys.topics(workspaceId), (list) =>
        list?.filter((topic) => topic.id !== topicId),
      );
      await Promise.all(
        [
          queryKeys.topics(workspaceId),
          queryKeys.dashboards(workspaceId),
          queryKeys.facets(workspaceId),
          queryKeys.workspaces,
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}
