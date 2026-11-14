import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import {
  acceptInvite,
  acceptJoinLink,
  createInvite,
  getJoinLink,
  listInvites,
  listMyInvites,
  resetJoinLink,
  revokeInvite,
  setJoinLink,
} from '@/api/services/inviteService';
import { selectIsAuthenticated } from '@/store/userSlice';
import type {
  CreateInviteRequestBody,
  JoinLinkView,
  SetJoinLinkRequestBody,
} from '@api-types/api-contracts';

/** Owner only: the server answers 403 to others, so only owners ask. */
export function useInvites(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invites(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled,
    queryFn: async () => {
      const response = await listInvites(workspaceId);
      return response.data;
    },
  });
}

/**
 * The result holds the invite link with its one-time token: it is returned to the caller, which
 * shows it once, and is never written to the query cache. Errors (409 at the member cap or for a
 * member, 429) are left to the form.
 */
export function useCreateInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // The mutation cache would keep the result (with the link) for minutes after the page
    // unmounts; drop it at once.
    gcTime: 0,
    mutationFn: async (body: CreateInviteRequestBody) => {
      const response = await createInvite(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites(workspaceId) });
    },
  });
}

export function useRevokeInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await revokeInvite(workspaceId, inviteId, { suppressErrorToast: true });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites(workspaceId) });
    },
  });
}

/** Pending invites sent to my email (onboarding). */
export function useMyInvites() {
  const isAuthenticated = useSelector(selectIsAuthenticated);
  return useQuery({
    queryKey: queryKeys.myInvites,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled: isAuthenticated,
    queryFn: async () => {
      const response = await listMyInvites();
      return response.data;
    },
  });
}

/** Errors are shown on the accept page (403, 404, 409, 410), never as a toast. */
export function useAcceptInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    // Its variables are the raw token: never kept in the mutation cache.
    gcTime: 0,
    mutationFn: async (token: string) => {
      const response = await acceptInvite(token, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: async () => {
      // `type: 'all'`: the list is fetched again even if no page shows it now, so the dashboard
      // that opens next already knows the new workspace.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: queryKeys.workspaces, type: 'all' }),
        queryClient.invalidateQueries({ queryKey: queryKeys.myInvites }),
      ]);
    },
  });
}

/**
 * Owner: whether "anyone with the link" is on, and its link. The link holds a token, so the
 * result lives only while the Share dialog shows it (gcTime 0).
 */
export function useJoinLink(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.joinLink(workspaceId),
    gcTime: 0,
    staleTime: 0,
    enabled,
    queryFn: async () => {
      const response = await getJoinLink(workspaceId);
      return response.data;
    },
  });
}

/** Turn "anyone with the link" on or off, or change its role. The new state replaces the cache. */
export function useSetJoinLink(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (body: SetJoinLinkRequestBody) => {
      const response = await setJoinLink(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: (data: JoinLinkView) => {
      queryClient.setQueryData(queryKeys.joinLink(workspaceId), data);
    },
  });
}

/** A new link; the old one stops working. */
export function useResetJoinLink(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const response = await resetJoinLink(workspaceId, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: (data: JoinLinkView) => {
      queryClient.setQueryData(queryKeys.joinLink(workspaceId), data);
    },
  });
}

/** Errors are shown on the join page, never as a toast. The variables are the raw token. */
export function useAcceptJoinLink() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (token: string) => {
      const response = await acceptJoinLink(token, { suppressErrorToast: true });
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.workspaces, type: 'all' });
    },
  });
}
