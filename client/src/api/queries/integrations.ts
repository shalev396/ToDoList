import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import {
  createIntegration,
  deleteIntegration,
  getIntegrationConfig,
  clearPrimaryCalendar,
  getIntegrationSharing,
  getPrimaryCalendar,
  listGoogleCalendars,
  listIntegrations,
  listOAuthProviders,
  listOAuthResources,
  setPrimaryCalendar,
  stopSharingIntegration,
  syncIntegration,
  testIntegration,
  updateIntegration,
} from '@/api/services/integrationService';
import { listSyncRuns } from '@/api/services/itemService';
import { anyRunActive, syncPollInterval } from '@/features/integrations/status';
import { workspaceKey } from '@/features/workspaces/switching';
import type {
  CreateIntegrationRequestBody,
  SetPrimaryCalendarRequestBody,
  UpdateIntegrationRequestBody,
} from '@api-types/api-contracts';
import type { SyncRunView } from '@api-types/integrations';

/** Integrations as `{id, provider, accountLabel, status, expiresAt, lastSyncAt}`, nothing else. */
export function useIntegrations(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.integrations(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listIntegrations(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/**
 * Which of my integrations are shared (a connector on some block), as a set of ids. A block write
 * and Stop sharing refresh it.
 */
export function useIntegrationSharing(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.integrationSharing(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getIntegrationSharing(workspaceId, {
        signal,
        suppressErrorToast: true,
      });
      const shared: ReadonlySet<string> = new Set(response.data.shared);
      return shared;
    },
  });
}

/**
 * Sync runs, polled every 3 s only while one is queued or running. When the last active run
 * finishes, the cards refresh too: a finished sync moves `lastSyncAt`.
 */
export function useIntegrationSyncRuns(workspaceId: string) {
  const queryClient = useQueryClient();
  const query = useQuery<SyncRunView[]>({
    queryKey: queryKeys.syncRuns(workspaceId),
    refetchInterval: (current) => syncPollInterval(current.state.data),
    queryFn: async ({ signal }) => {
      const response = await listSyncRuns(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
  const active = anyRunActive(query.data);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.integrations(workspaceId) });
    }
    wasActive.current = active;
  }, [active, queryClient, workspaceId]);
  return query;
}

/** Refreshes the cards and the runs: after any write, and after a credential is saved. */
export function useRefreshIntegrations(workspaceId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.syncRuns(workspaceId) }),
    ]);
}

export function useCreateIntegration(workspaceId: string) {
  const refresh = useRefreshIntegrations(workspaceId);
  return useMutation({
    mutationFn: async (body: CreateIntegrationRequestBody) =>
      (await createIntegration(workspaceId, body, { suppressErrorToast: true })).data,
    onSuccess: refresh,
  });
}

export function useTestIntegration(workspaceId: string) {
  const refresh = useRefreshIntegrations(workspaceId);
  return useMutation({
    mutationFn: async (integrationId: string) =>
      (await testIntegration(workspaceId, integrationId, { suppressErrorToast: true })).data,
    onSettled: refresh,
  });
}

export function useSyncIntegration(workspaceId: string) {
  const refresh = useRefreshIntegrations(workspaceId);
  return useMutation({
    mutationFn: async (integrationId: string) =>
      (await syncIntegration(workspaceId, integrationId, { suppressErrorToast: true })).data,
    onSettled: refresh,
  });
}

export function useUpdateIntegration(workspaceId: string) {
  const refresh = useRefreshIntegrations(workspaceId);
  return useMutation({
    mutationFn: async (input: { id: string; body: UpdateIntegrationRequestBody }) =>
      (await updateIntegration(workspaceId, input.id, input.body, { suppressErrorToast: true }))
        .data,
    onSuccess: refresh,
  });
}

export function useDisconnectIntegration(workspaceId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshIntegrations(workspaceId);
  return useMutation({
    mutationFn: (input: string | { id: string; removeAdded?: boolean }) => {
      const { id, removeAdded } = typeof input === 'string' ? { id: input } : input;
      return deleteIntegration(workspaceId, id, removeAdded === undefined ? {} : { removeAdded }, {
        suppressErrorToast: true,
      });
    },
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: queryKeys.primaryCalendar(workspaceId) });
    },
  });
}

/** The workspace's primary calendar (any member): state, why it is suspended, whether it is mine. */
export function usePrimaryCalendar(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.primaryCalendar(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    enabled: workspaceId !== '',
    queryFn: async ({ signal }) => {
      const response = await getPrimaryCalendar(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** After a change of the primary calendar: it, the cards and the integration settings refresh. */
function useRefreshPrimaryCalendar(workspaceId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshIntegrations(workspaceId);
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.primaryCalendar(workspaceId) }),
      refresh(),
    ]);
  };
}

export function useSetPrimaryCalendar(workspaceId: string) {
  const refresh = useRefreshPrimaryCalendar(workspaceId);
  return useMutation({
    mutationFn: async (body: SetPrimaryCalendarRequestBody) =>
      (await setPrimaryCalendar(workspaceId, body, { suppressErrorToast: true })).data,
    onSuccess: refresh,
  });
}

export function useClearPrimaryCalendar(workspaceId: string) {
  const refresh = useRefreshPrimaryCalendar(workspaceId);
  return useMutation({
    mutationFn: async () =>
      (await clearPrimaryCalendar(workspaceId, { suppressErrorToast: true })).data,
    onSuccess: refresh,
  });
}

/**
 * "Stop sharing" (PERMISSIONS-V2): the integration comes off every block, so every dashboard and
 * every block result of the workspace may change: they are all refetched.
 */
export function useStopSharing(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (integrationId: string) =>
      (await stopSharingIntegration(workspaceId, integrationId, { suppressErrorToast: true })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKey(workspaceId) }),
  });
}

/** A Google account's calendars (connected with Google), fetched when the picker opens. */
export function useGoogleCalendars(workspaceId: string, integrationId: string) {
  return useQuery({
    queryKey: [...queryKeys.integrations(workspaceId), integrationId, 'calendars'],
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await listGoogleCalendars(workspaceId, integrationId, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** An integration's non-secret settings (owner), for an editor that must keep the others. */
export function useIntegrationConfig(workspaceId: string, integrationId: string) {
  return useQuery({
    queryKey: [...queryKeys.integrations(workspaceId), integrationId, 'config'],
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await getIntegrationConfig(workspaceId, integrationId, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}

/** Which providers can sign in on this server, with the setup guide data (owners only). */
export function useOAuthProviders(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.integrations(workspaceId), 'oauth-providers'],
    enabled,
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await listOAuthProviders(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** The Jira sites or ClickUp workspaces a grant can read, fetched when the picker opens. */
export function useOAuthResources(workspaceId: string, integrationId: string) {
  return useQuery({
    queryKey: [...queryKeys.integrations(workspaceId), integrationId, 'oauth-resources'],
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await listOAuthResources(workspaceId, integrationId, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}
