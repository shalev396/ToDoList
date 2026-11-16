/**
 * Google Calendar (GoogleCalendarIntegration's definition). Users connect with Google OAuth 2.0: a
 * Google app separate from sign-in, the authorization-code flow with PKCE, offline access, a
 * refresh token sealed alone (`{refreshToken, scope}`; every session trades it for an access token
 * kept in memory). The demo's fixture-mode calendar reads through a service account instead.
 */
import { z } from 'zod';

import { googleCalendarAdapter } from '../../../sync/providers/google_calendar.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { ServiceAccountAuth } from '../auth/ServiceAccountAuth.js';
import { CalendarId } from './fields.js';
import { GOOGLE_CALENDAR_AUTH, type GoogleCalendarSecret } from './googleCalendarAuth.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

export {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_LIST_READONLY_SCOPE,
  GOOGLE_CALENDAR_AUTH,
  GOOGLE_CALENDAR_OAUTH,
  GOOGLE_CALENDAR_OAUTH_SCOPES,
  GOOGLE_SERVICE_ACCOUNT,
  REQUIRED_CALENDAR_SCOPES,
  type GoogleCalendarSecret,
} from './googleCalendarAuth.js';

/** The most calendars TodoList records as its own on one connection. */
const MAX_APP_CREATED_CALENDARS = 50;

/**
 * The settings a connection stored before the workspace's primary calendar (plan Addendum A2)
 * decided where the push goes: still read (an older client, a document the migration has not
 * reached), never kept.
 */
const RETIRED_KEYS: readonly string[] = ['targetCalendarId', 'pushFilter'];

const uniqueIds = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

const googleCalendar: DefinitionSpec<
  GoogleCalendarSecret,
  {
    oauth: OAuthAuth<GoogleCalendarSecret>;
    serviceAccount: ServiceAccountAuth<GoogleCalendarSecret>;
  }
> = {
  provider: 'google_calendar',
  auth: GOOGLE_CALENDAR_AUTH,
  config: () =>
    z.strictObject({
      calendars: z
        .array(z.strictObject({ id: CalendarId, mode: z.enum(['two_way', 'read']) }))
        .max(50)
        .refine(
          (calendars) => new Set(calendars.map(({ id }) => id)).size === calendars.length,
          'Calendar ids must differ',
        ),
      /** Kept by the server (GoogleCalendarIntegration#checkSelection): a sent value is ignored. */
      appCreatedCalendars: z
        .array(CalendarId)
        .max(MAX_APP_CREATED_CALENDARS)
        .refine(uniqueIds, 'Calendar ids must differ')
        .optional(),
      /** Retired (RETIRED_KEYS): read, then dropped by normalizeConfig. */
      targetCalendarId: CalendarId.optional(),
      pushFilter: z.unknown().optional(),
      horizonDays: z.int().min(1).max(365).optional(),
      maxOpsPerRun: z.int().min(1).max(200).optional(),
    }),
  normalizeConfig: (config) =>
    Object.fromEntries(Object.entries(config).filter(([key]) => !RETIRED_KEYS.includes(key))),
  connection: { topic: () => 'personal', accountId: () => null, label: () => null },
  adapter: googleCalendarAdapter,
  create: {
    steps: ['calendar'],
    // Calendar events need the user's OAuth grant (the demo's service account only reads).
    authKinds: ['oauth'],
    linkAllowed: (host) => host === 'google.com' || host.endsWith('.google.com'),
    forbiddenWithOAuth: 'rejected',
  },
  // A pulled event's title and time (startAt, endAt, with allDay): updateEvent, in the item's own
  // names (EventEdit). Its description is written there too, but an item keeps none. No status.
  write: { fields: ['title', 'startAt', 'endAt'], kinds: ['event'], statuses: [] },
  picker: 'calendars',
};

export const GOOGLE_CALENDAR = new IntegrationDefinition(googleCalendar);
