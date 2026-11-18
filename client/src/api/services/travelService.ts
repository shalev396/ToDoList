import { api } from '@/api/instance';
import type { ApiRequestConfig } from '@/types';
import type { ApiSuccessResponse } from '@api-types/api-contracts';
import type {
  CreatePlaceRequest,
  CreateTravelRuleRequest,
  PlacePinRequest,
  PlaceView,
  TravelDaysResponse,
  TravelRuleView,
  TravelSettingsResponse,
  UpdatePlaceRequest,
  UpdateTravelRuleRequest,
  UpdateTravelSettingsRequest,
} from '@api-types/travel.ts';

/**
 * The member's own travel (server/src/routes/private/travel.ts): places, rules, settings and
 * default places, and the day panel's days. Editors and owners only; another member's place or
 * rule is a 404. Every setup change makes the member's legs again before it answers.
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

/** 201. An address is looked up: 400 `place_not_found`, 503 `provider_unreachable`. */
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
