/**
 * The OAuth routes' request bodies and the pickers behind them. The sign-in itself, start to
 * callback, is OAuthFlow's (classes/integration/OAuthFlow.ts), the same for every provider; what a
 * grant lets its owner pick is the integration's (ResourcePicker: Jira sites, ClickUp workspaces,
 * Google calendars). Errors keep their fixed texts: a provider that refused the grant is 409
 * (reconnect), one that did not answer is 502, and the log has a class name at most.
 */
import { z } from 'zod';

import { Actor } from '../../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../../classes/base/Caller.js';
import {
  GoogleCalendarIntegration,
  Integration,
  IntegrationRegistry,
  picksFrom,
  type GoogleCalendarEntry,
  type OAuthIntegrationClass,
} from '../../classes/integration/index.js';
import { AppError } from '../../errors/AppError.js';
import { ProviderHttpError } from '../../sync/http.js';
import { isOAuthProviderId, type OAuthProviderId } from '../../sync/providers/oauthEndpoints.js';
import type {
  OAuthProviderInfo,
  OAuthProvidersResponse,
  OAuthResource,
} from '../../types/integrations.js';
import { logger } from '../logger.js';
import { OAUTH_LANGUAGES } from './common.js';

export type { OAuthProviderInfo, OAuthProvidersResponse, OAuthResource };

/** `POST …/integrations/google-calendar/oauth/start`. */
export const StartOAuthBody = z.strictObject({
  /** Reconnect: the integration it started from (a Google Calendar connected with Google). */
  integrationId: z.string().min(1).max(100).optional(),
  lng: z.enum(OAUTH_LANGUAGES).optional(),
});
export type StartOAuthInput = z.infer<typeof StartOAuthBody>;

/** `POST …/integrations/oauth/:provider/start`. */
export const StartProviderOAuthBody = z.strictObject({
  /** Reconnect: the integration it started from. */
  integrationId: z.string().min(1).max(100).optional(),
  lng: z.enum(OAUTH_LANGUAGES).optional(),
  /**
   * H5: also ask for the provider's write scope (Jira `write:jira-work`, Linear `write`),
   * so the user can create to-dos there. Used for the consent a create asked for; read stays the
   * default of every connection.
   */
  includeWrite: z.boolean().optional(),
});
export type StartProviderOAuthInput = z.infer<typeof StartProviderOAuthBody>;

/** The provider class of a shared OAuth route's `:provider` (GitHub, Jira, ClickUp, Linear). */
export function oauthClassOf(provider: OAuthProviderId): OAuthIntegrationClass {
  const cls = IntegrationRegistry.instance.classOf(provider);
  // Every OAuth provider has its class (the definitions test): a missing one is a wiring mistake.
  if (cls === null) throw new Error(`No integration class is registered for ${provider}`);
  return cls;
}

/** Google Calendar's own OAuth routes. */
export const GOOGLE_CALENDAR_OAUTH_CLASS: OAuthIntegrationClass = GoogleCalendarIntegration;

/** The `:provider` of a shared OAuth route, or null for anything else. */
export function asOAuthProvider(value: string): OAuthProviderId | null {
  return isOAuthProviderId(value) ? value : null;
}

/**
 * Its owner only: what a Jira (sites) or ClickUp (workspaces) grant can read, live from the
 * provider, for them to pick from. 404 for another member's; 409 for another kind of integration,
 * or when the provider refused the grant (reconnect); 502 when it does not answer.
 */
export async function listOAuthResources(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<OAuthResource[]> {
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  const integration = await Integration.findOwn(caller, integrationId);
  const { provider } = integration;
  if (!picksFrom(integration, 'sites') && !picksFrom(integration, 'workspaces')) {
    throw new AppError(409, 'Only a Jira or ClickUp connected with OAuth lists its resources');
  }
  try {
    return await integration.pickerResources(caller);
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, `${provider} refused the connection: reconnect it`);
    }
    logger.warn('OAuth resources could not be listed', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, `${provider} did not answer. Try again in a moment.`);
  }
}

/**
 * Its owner only: the calendars of a Google Calendar connected with Google, from Google
 * (calendarList), for the picker. 404 for another member's; 409 for another kind of integration,
 * or when Google refuses the grant (reconnect); 502 when Google does not answer.
 */
export async function listGoogleCalendars(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<GoogleCalendarEntry[]> {
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  const integration = await Integration.findOwn(caller, integrationId);
  if (!picksFrom(integration, 'calendars')) {
    throw new AppError(409, 'Only a Google Calendar connected with Google lists its calendars');
  }
  try {
    return await integration.pickerResources(caller);
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, 'Google refused the connection: reconnect Google Calendar');
    }
    logger.warn('Google calendars could not be listed', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, 'Google Calendar did not answer. Try again in a moment.');
  }
}
