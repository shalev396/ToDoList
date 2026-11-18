import { useStore } from 'react-redux';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiErrorStatus } from '@/api/errors';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import {
  refreshAfterChange,
  storeRemovedPlace,
  storeRemovedRule,
  storeSavedPlace,
  storeSavedRule,
  travelChangeOptions,
} from '@/api/queries/travelCache';
import {
  createPlace,
  createTravelRule,
  editLeg,
  getLegLinks,
  getTravelDays,
  getTravelSettings,
  listPlaces,
  listTravelRules,
  markItem,
  pinItemPlace,
  previewTravel,
  removePlace,
  removeTravelRule,
  resetLeg,
  setContainerPlace,
  skipLeg,
  unmarkItem,
  updatePlace,
  updateTravelRule,
  updateTravelSettings,
} from '@/api/services/travelService';
import { useDebounced } from '@/features/editor/useDebounced';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { RootState } from '@/store';
import type { ItemDetail } from '@api-types/api-contracts';
import type {
  CreatePlaceRequest,
  CreateTravelRuleRequest,
  LegEditRequest,
  MarkItemRequest,
  TravelPreviewRequest,
  TravelSettingsResponse,
  UpdatePlaceRequest,
  UpdateTravelRuleRequest,
  UpdateTravelSettingsRequest,
} from '@api-types/travel.ts';

/**
 * My own travel: places, rules, settings and default places, and the days of legs. A change's
 * answer goes into the cache at once (`store`), then my travel and the blocks are read again
 * (travelCache.ts).
 */
function useTravelChange<V, R>(
  workspaceId: string,
  call: (variables: V) => Promise<R>,
  store?: (queryClient: QueryClient, data: R, variables: V) => void,
) {
  const queryClient = useQueryClient();
  const redux = useStore<RootState>();
  return useMutation(
    travelChangeOptions(
      queryClient,
      () => redux.getState().workspace.generation,
      workspaceId,
      call,
      store === undefined
        ? undefined
        : (data: R, variables: V) => {
            store(queryClient, data, variables);
          },
    ),
  );
}

// ─── Places ─────────────────────────────────────────────────────────────────

/** `enabled: false` reads nothing yet (a form that may never use travel). */
export function usePlaces(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.travelPlaces(workspaceId),
    enabled: enabled && workspaceId !== '',
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

/** The saved place (the server's answer) replaces its old copy in the cache at once. */
export function useSavePlace(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    async ({ id, body }: SavePlaceVariables) => {
      const config = { suppressErrorToast: true };
      const response =
        id === undefined
          ? await createPlace(workspaceId, body, config)
          : await updatePlace(workspaceId, id, body, config);
      return response.data;
    },
    (queryClient, saved) => {
      storeSavedPlace(queryClient, workspaceId, saved);
    },
  );
}

/** The removed place leaves the cached list at once. */
export function useRemovePlace(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    (placeId: string) => removePlace(workspaceId, placeId, { suppressErrorToast: true }),
    (queryClient, _done, placeId) => {
      storeRemovedPlace(queryClient, workspaceId, placeId);
    },
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

/**
 * The saved rule (the server's answer) replaces its old copy in the cache at once, so a rule card
 * never shows its old values between Save and the read again.
 */
export function useSaveTravelRule(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    async ({ id, body }: SaveTravelRuleVariables) => {
      const config = { suppressErrorToast: true };
      const response =
        id === undefined
          ? await createTravelRule(workspaceId, body, config)
          : await updateTravelRule(workspaceId, id, body, config);
      return response.data;
    },
    (queryClient, saved) => {
      storeSavedRule(queryClient, workspaceId, saved);
    },
  );
}

/** The removed rule leaves the cached list at once. */
export function useRemoveTravelRule(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    (ruleId: string) => removeTravelRule(workspaceId, ruleId, { suppressErrorToast: true }),
    (queryClient, _done, ruleId) => {
      storeRemovedRule(queryClient, workspaceId, ruleId);
    },
  );
}

// ─── Settings and default places ────────────────────────────────────────────

export function useTravelSettings(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.travelSettings(workspaceId),
    enabled: enabled && workspaceId !== '',
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

/** An item's place for travel ("set place"); `placeId: null` finds it from its location again. */
export function usePinItemPlace(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    ({ itemId, placeId }: { itemId: string; placeId: string | null }) =>
      pinItemPlace(workspaceId, itemId, { placeId }, { suppressErrorToast: true }),
  );
}

// ─── Marking an item, and the preview ───────────────────────────────────────

/** A preview is asked once the trip stops changing for this long (each may spend quota). */
export const TRAVEL_PREVIEW_DEBOUNCE_MS = 400;

/** How long a trip's preview is kept: the same trip isn't asked again in that time. */
const TRAVEL_PREVIEW_STALE_MS = 10 * 60_000;

/**
 * Travel to one timed item (every occurrence, one, or the item): answers the rule and the item's
 * legs as they are now, which may be none yet.
 */
export function useMarkItem(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    async ({ itemId, body }: { itemId: string; body: MarkItemRequest }) => {
      const response = await markItem(workspaceId, itemId, body, { suppressErrorToast: true });
      return response.data;
    },
  );
}

/**
 * Travel to an item no more: every occurrence's marks, one occurrence's, or the item's own. No
 * such mark (404) is taken as removed already.
 */
export function useUnmarkItem(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    async ({ itemId, ...which }: { itemId: string; occurrence?: string; every?: boolean }) => {
      try {
        await unmarkItem(workspaceId, itemId, which, { suppressErrorToast: true });
      } catch (error) {
        if (apiErrorStatus(error) !== 404) {
          throw error;
        }
      }
    },
  );
}

/**
 * A trip's length for the travel panel's preview line: asked TRAVEL_PREVIEW_DEBOUNCE_MS after the
 * trip (mode and places) stops changing, and once per trip for TRAVEL_PREVIEW_STALE_MS, never
 * per key press: each may spend a call of the routing quota every TodoList user shares. `null`
 * asks nothing. `settling` is true while a changed trip waits to be asked.
 */
export function useTravelPreview(workspaceId: string, request: TravelPreviewRequest | null) {
  const trip = request === null ? null : JSON.stringify(request);
  const settled = useDebounced(trip, TRAVEL_PREVIEW_DEBOUNCE_MS);
  const asked = settled !== null && settled === trip ? settled : null;
  const query = useQuery({
    queryKey: queryKeys.travelPreview(workspaceId, asked ?? ''),
    enabled: asked !== null && workspaceId !== '',
    staleTime: TRAVEL_PREVIEW_STALE_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const body = JSON.parse(asked ?? 'null') as TravelPreviewRequest;
      const response = await previewTravel(workspaceId, body, {
        signal,
        suppressErrorToast: true,
      });
      return response.data;
    },
  });
  return { ...query, settling: trip !== null && asked === null };
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

// ─── One leg ────────────────────────────────────────────────────────────────

/** The answer is the leg as it is now: it replaces the cached item at once. */
function storeLeg(queryClient: QueryClient, workspaceId: string, leg: ItemDetail): void {
  queryClient.setQueryData(queryKeys.item(workspaceId, leg.id), leg);
}

/** New times for a leg: one or two of start, end and length. Hand edits stay until Reset. */
export function useEditLeg(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    async ({ legId, body }: { legId: string; body: LegEditRequest }) => {
      const response = await editLeg(workspaceId, legId, body, { suppressErrorToast: true });
      return response.data;
    },
    (queryClient, leg) => {
      storeLeg(queryClient, workspaceId, leg);
    },
  );
}

/** Computed again: his times and the "moved" flag are cleared, and a skipped trip is back. */
export function useResetLeg(workspaceId: string) {
  return useTravelChange(
    workspaceId,
    async (legId: string) => {
      const response = await resetLeg(workspaceId, legId, { suppressErrorToast: true });
      return response.data;
    },
    (queryClient, leg) => {
      storeLeg(queryClient, workspaceId, leg);
    },
  );
}

/** Skipped for its day (a tombstone until Reset): the days and the blocks are read again. */
export function useSkipLeg(workspaceId: string) {
  return useTravelChange(workspaceId, (legId: string) =>
    skipLeg(workspaceId, legId, { suppressErrorToast: true }),
  );
}

/** The apps that open the trip. Read when the sheet opens; never cached long (they carry places). */
export function useLegLinks(workspaceId: string, legId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.travelLegLinks(workspaceId, legId),
    enabled: enabled && workspaceId !== '' && legId !== '',
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    queryFn: async ({ signal }) => {
      const response = await getLegLinks(workspaceId, legId, { signal, suppressErrorToast: true });
      return response.data.links;
    },
  });
}
