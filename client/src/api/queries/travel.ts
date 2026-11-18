import { useStore } from 'react-redux';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import {
  createPlace,
  createTravelRule,
  getTravelDays,
  getTravelSettings,
  listPlaces,
  listTravelRules,
  removePlace,
  removeTravelRule,
  setContainerPlace,
  updatePlace,
  updateTravelRule,
  updateTravelSettings,
} from '@/api/services/travelService';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { RootState } from '@/store';
import type {
  CreatePlaceRequest,
  CreateTravelRuleRequest,
  TravelSettingsResponse,
  UpdatePlaceRequest,
  UpdateTravelRuleRequest,
  UpdateTravelSettingsRequest,
} from '@api-types/travel.ts';

/**
 * My own travel: places, rules, settings and default places, and the days of legs. Every change
 * makes my legs again on the server before it answers, so after one my travel and every block
 * that shows items (calendar, clock, timeline, agenda) are read again.
 */
function refreshAfterChange(queryClient: QueryClient, workspaceId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.travel(workspaceId) });
  void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[2] === 'block' });
}

function useTravelChange<V, R>(workspaceId: string, call: (variables: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      refreshAfterChange(queryClient, workspaceId);
    },
  });
}

// ─── Places ─────────────────────────────────────────────────────────────────

export function usePlaces(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.travelPlaces(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listPlaces(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** A new place (no `id`), or a change to one. */
export type SavePlaceVariables =
  | { id?: undefined; body: CreatePlaceRequest }
  | { id: string; body: UpdatePlaceRequest };

export function useSavePlace(workspaceId: string) {
  return useTravelChange(workspaceId, async ({ id, body }: SavePlaceVariables) => {
    const config = { suppressErrorToast: true };
    const response =
      id === undefined
        ? await createPlace(workspaceId, body, config)
        : await updatePlace(workspaceId, id, body, config);
    return response.data;
  });
}

export function useRemovePlace(workspaceId: string) {
  return useTravelChange(workspaceId, (placeId: string) =>
    removePlace(workspaceId, placeId, { suppressErrorToast: true }),
  );
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export function useTravelRules(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.travelRules(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await listTravelRules(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** A new rule (no `id`), or a change to one. */
export type SaveTravelRuleVariables =
  | { id?: undefined; body: CreateTravelRuleRequest }
  | { id: string; body: UpdateTravelRuleRequest };

export function useSaveTravelRule(workspaceId: string) {
  return useTravelChange(workspaceId, async ({ id, body }: SaveTravelRuleVariables) => {
    const config = { suppressErrorToast: true };
    const response =
      id === undefined
        ? await createTravelRule(workspaceId, body, config)
        : await updateTravelRule(workspaceId, id, body, config);
    return response.data;
  });
}

export function useRemoveTravelRule(workspaceId: string) {
  return useTravelChange(workspaceId, (ruleId: string) =>
    removeTravelRule(workspaceId, ruleId, { suppressErrorToast: true }),
  );
}

// ─── Settings and default places ────────────────────────────────────────────

export function useTravelSettings(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.travelSettings(workspaceId),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getTravelSettings(workspaceId, { signal, suppressErrorToast: true });
      return response.data;
    },
  });
}

/** Any part of the settings; the answer (the settings as saved) replaces the cached ones. */
export function useSaveTravelSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: async (body: UpdateTravelSettingsRequest) => {
      const response = await updateTravelSettings(workspaceId, body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (saved: TravelSettingsResponse) => {
        queryClient.setQueryData(queryKeys.travelSettings(workspaceId), saved);
        refreshAfterChange(queryClient, workspaceId);
      },
    ),
  });
}

/** A calendar's or project's default place; `placeId: null` removes it. */
export function useSetContainerPlace(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    ({ containerId, placeId }: { containerId: string; placeId: string | null }) =>
      setContainerPlace(workspaceId, containerId, { placeId }, { suppressErrorToast: true }),
  );
}

// ─── Days ───────────────────────────────────────────────────────────────────

/**
 * My travel in the current workspace from `from` to `to` (`YYYY-MM-DD`, both included, at most
 * 14 days): each day's legs and what was removed, and why. Travel is for editors and owners, so a
 * viewer reads nothing.
 */
export function useTravelDays(from: string, to: string) {
  const { workspace, role } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? '';
  return useQuery({
    queryKey: queryKeys.travelDays(workspaceId, from, to),
    enabled: workspace !== null && (role === 'owner' || role === 'editor'),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getTravelDays(workspaceId, from, to, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
}
