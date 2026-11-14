/**
 * The Google Calendar OAuth client (a Google app separate from sign-in, INTEGRATIONS-SETUP.md §1):
 * its id and secret, and the token client that trades codes and refresh tokens at Google.
 *
 * The id and secret are the app secret `google-calendar-oauth` (services/appSecrets.ts): the keys
 * GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET of `todolist-<stage>-app-secrets`,
 * kept in memory for an hour at most. The secret is never logged, returned or put in an error.
 */
import {
  createReadOnlyClient,
  ProviderHttpError,
  type ReadOnlyClient,
  type Transport,
} from '../sync/http.js';
import { googleEndpoints } from '../sync/providers/googleEndpoints.js';
import { liveTransport } from '../sync/transports/live.js';
import { AppSecretError, getAppSecret } from './appSecrets.js';

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/** Granted with every Google Calendar connection. */
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_LIST_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  'openid',
  'email',
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_LIST_READONLY_SCOPE,
] as const;
/** What the integration needs to work: reading and writing events, and the calendar list. */
export const REQUIRED_CALENDAR_SCOPES = [CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_READONLY_SCOPE];

/**
 * The client id and secret, or null when this server has none configured (no such secret). Any
 * other failure throws a generic error; appSecrets.ts has logged its kind, never the value.
 */
export async function googleOAuthCredentials(): Promise<GoogleOAuthCredentials | null> {
  try {
    const { clientId, clientSecret } =
      await getAppSecret<GoogleOAuthCredentials>('google-calendar-oauth');
    return { clientId, clientSecret };
  } catch (error) {
    if (error instanceof AppSecretError && error.reason === 'missing') return null;
    throw new Error('The Google Calendar OAuth secret could not be read');
  }
}

/**
 * A client for Google's token and revoke endpoints (and GETs such as userinfo), over the live
 * transport unless a test passes its own.
 */
export function googleTokenClient(transport: Transport = liveTransport()): ReadOnlyClient {
  const endpoints = googleEndpoints();
  return createReadOnlyClient({
    provider: 'google_calendar',
    transport,
    tokenExchangeUrl: endpoints.token,
    revokeUrl: endpoints.revoke,
  });
}

/**
 * A fresh access token for `refreshToken`, through `client` (built with the token URL). Kept by
 * the caller in memory for one run or request only. A refresh token that no longer works (revoked,
 * or the 7-day expiry of a Google app in Testing) is `auth_failed`: the owner reconnects. A server
 * without an OAuth client is a plain error (fixing the server fixes it; no reconnect needed).
 */
export async function refreshAccessToken(
  client: ReadOnlyClient,
  refreshToken: string,
): Promise<string> {
  const credentials = await googleOAuthCredentials();
  if (credentials === null) throw new Error('Google Calendar OAuth is not set up on this server');
  if (refreshToken === '') throw new ProviderHttpError('google_calendar', null, 'auth_failed');
  const grant = await client.exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  return grant.accessToken;
}
