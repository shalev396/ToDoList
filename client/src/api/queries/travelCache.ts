/**
 * Writing a travel change's answer into the cached lists at once, so a saved place or rule shows
 * as saved (and a removed one goes) before the lists are read again: nothing flickers back to its
 * old values in between. A list that isn't cached stays uncached.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { PlaceView, TravelRuleView } from '@api-types/travel.ts';
import { queryKeys } from './keys.ts';
import { sameWorkspace } from './sameWorkspace.ts';

/**
 * Every travel change makes my legs again on the server before it answers, so after one my
 * travel and every block that shows items (calendar, clock, timeline, agenda) are read again.
 */
export function refreshAfterChange(queryClient: QueryClient, workspaceId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.travel(workspaceId) });
  void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[2] === 'block' });
}

/**
 * A travel change's mutation options: on success, `store` first writes the answer into the cache
 * (so nothing shows its old values until the read again), then everything travel is read again.
 * Skipped when the workspace changed while it ran (`generation`).
 */
export function travelChangeOptions<V, R>(
  queryClient: QueryClient,
  generation: () => number,
  workspaceId: string,
  call: (variables: V) => Promise<R>,
  store?: (data: R, variables: V) => void,
) {
  return {
    mutationFn: call,
    ...sameWorkspace(generation, (data: R, variables: V) => {
      store?.(data, variables);
      refreshAfterChange(queryClient, workspaceId);
    }),
  };
}

/** The list with `saved` in place of its old copy, or added at its end when it is new. */
export function withSaved<T extends { id: string }>(
  list: readonly T[] | undefined,
  saved: T,
): T[] | undefined {
  if (list === undefined) {
    return undefined;
  }
  return list.some((entry) => entry.id === saved.id)
    ? list.map((entry) => (entry.id === saved.id ? saved : entry))
    : [...list, saved];
}

/** The list without the entry with this id. */
export function without<T extends { id: string }>(
  list: readonly T[] | undefined,
  id: string,
): T[] | undefined {
  return list?.filter((entry) => entry.id !== id);
}

/** A saved place in the cached places. A new Home makes the old one a plain place, as stored. */
export function storeSavedPlace(
  queryClient: QueryClient,
  workspaceId: string,
  saved: PlaceView,
): void {
  queryClient.setQueryData<PlaceView[]>(queryKeys.travelPlaces(workspaceId), (places) => {
    const next = withSaved(places, saved);
    return saved.home
      ? next?.map((place) => (place.id === saved.id ? place : { ...place, home: false }))
      : next;
  });
}

export function storeRemovedPlace(
  queryClient: QueryClient,
  workspaceId: string,
  placeId: string,
): void {
  queryClient.setQueryData<PlaceView[]>(queryKeys.travelPlaces(workspaceId), (places) =>
    without(places, placeId),
  );
}

/** A saved rule (the server's answer) in the cached rules: in its place, or at the end. */
export function storeSavedRule(
  queryClient: QueryClient,
  workspaceId: string,
  saved: TravelRuleView,
): void {
  queryClient.setQueryData<TravelRuleView[]>(queryKeys.travelRules(workspaceId), (rules) =>
    withSaved(rules, saved),
  );
}

export function storeRemovedRule(
  queryClient: QueryClient,
  workspaceId: string,
  ruleId: string,
): void {
  queryClient.setQueryData<TravelRuleView[]>(queryKeys.travelRules(workspaceId), (rules) =>
    without(rules, ruleId),
  );
}
