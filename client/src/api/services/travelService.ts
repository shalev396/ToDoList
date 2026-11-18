import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type { ApiSuccessResponse, ItemDetail } from '@api-types/api-contracts';
import type {
  CreatePlaceRequest,
  CreateTravelRuleRequest,
  LegEditRequest,
  MarkItemRequest,
  MarkItemResponse,
  PlacePinRequest,
  PlaceView,
  TravelDaysResponse,
  TravelLinksResponse,
  TravelPreviewRequest,
  TravelPreviewResponse,
  TravelRuleView,
  TravelSettingsResponse,
  UpdatePlaceRequest,
  UpdateTravelRuleRequest,
  UpdateTravelSettingsRequest,
} from '@api-types/travel.ts';

/**
 * The member's own travel (server/src/routes/private/travel.ts): places, rules, settings and
 * default places, and the day panel's days. Editors and owners only; another member's place or
 * rule is a 404. Every setup change, mark and pin makes the member's legs again before it answers.
 */
function travelPath(workspaceId: string, ...rest: string[]): string {
  const tail = rest.map((part) => `/${encodeURIComponent(part)}`).join('');
  return `/private/workspaces/${encodeURIComponent(workspaceId)}/travel${tail}`;
}

// ─── Places ─────────────────────────────────────────────────────────────────

export async function listPlaces(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<PlaceView[]>>(
    travelPath(workspaceId, 'places'),
    config,
  );
  return response.data;
}

/** 201. A name, and an address as typed if any (never looked up). 409 `travel_limit` at the cap. */
export async function createPlace(
  workspaceId: string,
  body: CreatePlaceRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<PlaceView>>(
    travelPath(workspaceId, 'places'),
    body,
    config,
  );
  return response.data;
}

export async function updatePlace(
  workspaceId: string,
  placeId: string,
  body: UpdatePlaceRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<PlaceView>>(
    travelPath(workspaceId, 'places', placeId),
    body,
    config,
  );
  return response.data;
}

/** 204. Rules naming it name none, and default places on it go. */
export async function removePlace(workspaceId: string, placeId: string, config?: ApiRequestConfig) {
  await api.delete(travelPath(workspaceId, 'places', placeId), config);
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export async function listTravelRules(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<TravelRuleView[]>>(
    travelPath(workspaceId, 'rules'),
    config,
  );
  return response.data;
}

export async function createTravelRule(
  workspaceId: string,
  body: CreateTravelRuleRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<TravelRuleView>>(
    travelPath(workspaceId, 'rules'),
    body,
    config,
  );
  return response.data;
}

export async function updateTravelRule(
  workspaceId: string,
  ruleId: string,
  body: UpdateTravelRuleRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<TravelRuleView>>(
    travelPath(workspaceId, 'rules', ruleId),
    body,
    config,
  );
  return response.data;
}

/** 204. Its legs go. */
export async function removeTravelRule(
  workspaceId: string,
  ruleId: string,
  config?: ApiRequestConfig,
) {
  await api.delete(travelPath(workspaceId, 'rules', ruleId), config);
}

// ─── Settings and default places ────────────────────────────────────────────

export async function getTravelSettings(workspaceId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<TravelSettingsResponse>>(
    travelPath(workspaceId, 'settings'),
    config,
  );
  return response.data;
}

export async function updateTravelSettings(
  workspaceId: string,
  body: UpdateTravelSettingsRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<TravelSettingsResponse>>(
    travelPath(workspaceId, 'settings'),
    body,
    config,
  );
  return response.data;
}

/** 204: a calendar's or project's default place; `placeId: null` removes it. */
export async function setContainerPlace(
  workspaceId: string,
  containerId: string,
  body: PlacePinRequest,
  config?: ApiRequestConfig,
) {
  await api.put(travelPath(workspaceId, 'container-places', containerId), body, config);
}

/** 204: an item's place for travel ("set place"); `placeId: null` unpins it. */
export async function pinItemPlace(
  workspaceId: string,
  itemId: string,
  body: PlacePinRequest,
  config?: ApiRequestConfig,
) {
  await api.put(travelPath(workspaceId, 'item-places', itemId), body, config);
}

// ─── Marking an item, and the preview ───────────────────────────────────────

/**
 * Travel to (and from) one timed item: the rule it is marked with, and its legs as they are now
 * (none yet when its place isn't known, or until the next sync). 409 `travel_home_missing`
 * without a Home; 400 `not_an_occurrence`; 400 for an area, a leg or an item with no start.
 */
export async function markItem(
  workspaceId: string,
  itemId: string,
  body: MarkItemRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<MarkItemResponse>>(
    travelPath(workspaceId, 'items', itemId),
    body,
    config,
  );
  return response.data;
}

/** 204: every occurrence's marks (`every`), one occurrence's, or the item's own; 404 when none. */
export async function unmarkItem(
  workspaceId: string,
  itemId: string,
  which: { occurrence?: string; every?: boolean },
  config?: ApiRequestConfig,
) {
  const params = new URLSearchParams();
  if (which.every === true) {
    params.set('every', 'true');
  }
  if (which.occurrence !== undefined) {
    params.set('occurrence', which.occurrence);
  }
  const query = params.toString() === '' ? '' : `?${params.toString()}`;
  await api.delete(`${travelPath(workspaceId, 'items', itemId)}${query}`, config);
}

/** A trip's length as a leg would get it (no leg is made); may spend a routing call. */
export async function previewTravel(
  workspaceId: string,
  body: TravelPreviewRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.post<ApiSuccessResponse<TravelPreviewResponse>>(
    travelPath(workspaceId, 'preview'),
    body,
    config,
  );
  return response.data;
}

// ─── Days ───────────────────────────────────────────────────────────────────

/** Every day from `from` to `to` (`YYYY-MM-DD`, both included, at most 14). */
export async function getTravelDays(
  workspaceId: string,
  from: string,
  to: string,
  config?: ApiRequestConfig,
) {
  const params = new URLSearchParams({ from, to });
  const response = await api.get<ApiSuccessResponse<TravelDaysResponse>>(
    `${travelPath(workspaceId, 'days')}?${params.toString()}`,
    config,
  );
  return response.data;
}

// ─── Legs ───────────────────────────────────────────────────────────────────

/** New times for a leg: one or two of start, end and length (his until he resets it). */
export async function editLeg(
  workspaceId: string,
  legId: string,
  body: LegEditRequest,
  config?: ApiRequestConfig,
) {
  const response = await api.patch<ApiSuccessResponse<ItemDetail>>(
    travelPath(workspaceId, 'legs', legId),
    body,
    config,
  );
  return response.data;
}

/** Skipped for its day: a tombstone with reason `skipped`, until Reset. */
export async function skipLeg(workspaceId: string, legId: string, config?: ApiRequestConfig) {
  await api.post(travelPath(workspaceId, 'legs', legId, 'skip'), {}, config);
}

/** Computed again: a skip undone, his times and the "moved" flag cleared. */
export async function resetLeg(workspaceId: string, legId: string, config?: ApiRequestConfig) {
  const response = await api.post<ApiSuccessResponse<ItemDetail>>(
    travelPath(workspaceId, 'legs', legId, 'reset'),
    {},
    config,
  );
  return response.data;
}

/** The apps that open the trip (its member's only: the links carry coordinates). */
export async function getLegLinks(workspaceId: string, legId: string, config?: ApiRequestConfig) {
  const response = await api.get<ApiSuccessResponse<TravelLinksResponse>>(
    travelPath(workspaceId, 'legs', legId, 'links'),
    config,
  );
  return response.data;
}
