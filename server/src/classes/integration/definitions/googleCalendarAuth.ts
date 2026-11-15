/**
 * Google Calendar's auth strategies (its definition's `auth`, definitions/googleCalendar.ts): users
 * connect with Google OAuth 2.0 (a Google app separate from sign-in, the authorization-code flow
 * with PKCE, offline access, a refresh token sealed alone, traded for an access token per
 * session); the demo's fixture-mode calendar reads through a service account. Its own module, with
 * nothing of the calendar's config behind it, so the sync adapter's tests load only this.
 */
import { z } from 'zod';

import { OAuthFailure } from '../../../services/oauth/failure.js';
import type { ReadOnlyClient } from '../../../sync/http.js';
import { CALENDAR_READONLY_SCOPE } from '../auth/googleServiceAccount.js';
import { GOOGLE_ENDPOINTS, googleEndpoints } from '../../../sync/providers/googleEndpoints.js';
import { liveTransport } from '../../../sync/transports/live.js';
import { STEP_CEILING_MS } from '../calendar/TimeBudget.js';
import { OAuthAuth, type OAuthAppOptions } from '../auth/OAuthAuth.js';
import { ServiceAccountAuth, type ServiceAccountAuthOptions } from '../auth/ServiceAccountAuth.js';
import { fakeEmail, fakePrivateKey } from './fake.js';
import { Email, PrivateKeyPem } from './fields.js';

/** `{refreshToken, scope}` (OAuth) or `{clientEmail, privateKey}` (the demo's service account). */
export type GoogleCalendarSecret = Readonly<{
  refreshToken?: string;
  scope?: string;
  clientEmail?: string;
  privateKey?: string;
}>;

/** Granted with every Google Calendar connection. */
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_LIST_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
/**
 * Lets TodoList create calendars of its own and manage only those (the workspace's primary
 * calendar, plan Addendum A2). Asked on every connection, never required: a grant from before
 * it was asked still works, and only `createCalendar` refuses it (409 `scope_missing`).
 */
export const CALENDAR_APP_CREATED_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  'openid',
  'email',
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_LIST_READONLY_SCOPE,
  CALENDAR_APP_CREATED_SCOPE,
] as const;
/** What the integration needs to work: reading and writing events, and the calendar list. */
export const REQUIRED_CALENDAR_SCOPES = [CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_READONLY_SCOPE];

const Account = z.object({
  sub: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  email: z.string().max(254).pipe(z.email()),
});

const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});

/** The account's primary calendar id, the default to read and push to; null if unreadable. */
async function primaryCalendarId(
  client: ReadOnlyClient,
  accessToken: string,
): Promise<string | null> {
  try {
    const url = `${googleEndpoints().calendar}/users/me/calendarList?minAccessRole=writer`;
    const { data } = await client.getJson<{ items?: unknown }>(url, bearer(accessToken));
    const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
    for (const item of items) {
      const { id, primary } = (item ?? {}) as { id?: unknown; primary?: unknown };
      if (primary === true && typeof id === 'string' && /^\S{1,255}$/.test(id)) return id;
    }
  } catch {
    // The owner picks the calendars instead.
  }
  return null;
}

const googleApp: OAuthAppOptions = {
  provider: 'google_calendar',
  secretName: 'google-calendar-oauth',
  endpoints: {
    authorize: GOOGLE_ENDPOINTS.authorize,
    token: GOOGLE_ENDPOINTS.token,
    revoke: GOOGLE_ENDPOINTS.revoke,
    api: GOOGLE_ENDPOINTS.calendar,
  },
  liveEndpoints: () => {
    const endpoints = googleEndpoints();
    return {
      authorize: endpoints.authorize,
      token: endpoints.token,
      revoke: endpoints.revoke,
      api: endpoints.calendar,
    };
  },
  callbackPath: '/api/public/oauth/google-calendar/callback',
  scopes: GOOGLE_CALENDAR_OAUTH_SCOPES,
  requiredScopes: REQUIRED_CALENDAR_SCOPES,
  pkce: true,
  sendResponseType: true,
  authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  loginHint: true,
  refresh: 'per_call',
  consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  // A token exchange or revoke takes one call's longest time at most (STEP_CEILING_MS), so it fits
  // a request's TimeBudget like every Calendar API call.
  transport: () => liveTransport({ timeoutMs: STEP_CEILING_MS }),
  messages: {
    unavailable: 'Connecting with Google is not set up on this server',
    notReconnectable: 'integrationId: not a Google Calendar connected with Google',
    notSetUp: 'Google Calendar OAuth is not set up on this server',
    secretUnreadable: 'The Google Calendar OAuth secret could not be read',
  },
  async identify(client, accessToken) {
    const { data } = await client.getJson<unknown>(googleEndpoints().userinfo, bearer(accessToken));
    const account = Account.safeParse(data);
    if (!account.success) throw new OAuthFailure('oauth_failed');
    const primary = await primaryCalendarId(client, accessToken);
    return {
      accountId: account.data.sub,
      label: account.data.email,
      config: primary === null ? { calendars: [] } : { calendars: [{ id: primary, mode: 'read' }] },
      topicSlug: 'personal',
    };
  },
};

export const GOOGLE_CALENDAR_OAUTH = new OAuthAuth<GoogleCalendarSecret>(googleApp);

/** The demo's fixture-mode calendar: a service account (nobody connects this way). */
const serviceAccount: ServiceAccountAuthOptions = {
  provider: 'google_calendar',
  scope: CALENDAR_READONLY_SCOPE,
  credential: {
    schema: z.strictObject({ clientEmail: Email, privateKey: PrivateKeyPem }),
    fake: (name) => ({
      clientEmail: fakeEmail(name, 'todolist-demo.iam.gserviceaccount.com'),
      privateKey: fakePrivateKey(name),
    }),
  },
};

export const GOOGLE_SERVICE_ACCOUNT = new ServiceAccountAuth<GoogleCalendarSecret>(serviceAccount);

/** How Google Calendar connects: its OAuth grant, or the demo's service account. */
export const GOOGLE_CALENDAR_AUTH = {
  oauth: GOOGLE_CALENDAR_OAUTH,
  serviceAccount: GOOGLE_SERVICE_ACCOUNT,
} as const;
