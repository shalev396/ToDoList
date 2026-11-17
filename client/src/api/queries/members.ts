import { useStore } from 'react-redux';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import {
  countFormerMemberTodos,
  deleteFormerMemberTodos,
  leaveWorkspace,
  listMembers,
  removeMember,
  updateMember,
} from '@/api/services/memberService';
import type {
  ListMembersResponseData,
  UpdateMemberRequestBody,
  UpdateMemberResponseData,
} from '@api-types/api-contracts';
import type { RootState } from '@/store';

export function useMembers(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.members(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async () => {
      const response = await listMembers(workspaceId);
      return response.data;
    },
  });
}

/** The updated member replaces theirs in the list; not after a workspace switch. */
export function useUpdateMember(workspaceId: string) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: async ({ userId, body }: { userId: string; body: UpdateMemberRequestBody }) => {
      const response = await updateMember(workspaceId, userId, body, { suppressErrorToast: true });
      return response.data;
    },
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (updated: UpdateMemberResponseData) => {
        queryClient.setQueryData<ListMembersResponseData>(queryKeys.members(workspaceId), (list) =>
          list?.map((member) => (member.userId === updated.userId ? updated : member)),
        );
      },
    ),
  });
}

/**
 * Removes a member. `onRemoved` runs before the members list is refetched: the refetch takes the
 * member's row away, and with it the component that called `mutate`, whose own `onSuccess` then
 * never runs (TanStack Query skips the callbacks of an unmounted caller), so its toast came or
 * not depending on which finished first. useDeleteTopic does the same.
 */
export function useRemoveMember(workspaceId: string, onRemoved?: (userId: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await removeMember(workspaceId, userId, { suppressErrorToast: true });
      return userId;
    },
    onSuccess: async (userId) => {
      onRemoved?.(userId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
    },
  });
}

export function useLeaveWorkspace(workspaceId: string) {
  return useMutation({
    mutationFn: async () => {
      await leaveWorkspace(workspaceId, { suppressErrorToast: true });
    },
  });
}

/** Owners: how many private to-dos former members left here (PERMISSIONS-V2 ruling 6). */
export function useFormerMemberTodos(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.formerMemberTodos(workspaceId),
    enabled,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await countFormerMemberTodos(workspaceId, {
        signal,
        suppressErrorToast: true,
      });
      return response.data.count;
    },
  });
}

/** Owners: deletes them without reading them; the count refreshes. */
export function useDeleteFormerMemberTodos(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await deleteFormerMemberTodos(workspaceId, { suppressErrorToast: true })).data.deleted,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.formerMemberTodos(workspaceId) }),
  });
}
