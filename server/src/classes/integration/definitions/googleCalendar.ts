/**
 * Google Calendar (GoogleCalendarIntegration's definition). Users connect with Google OAuth 2.0: a
 * Google app separate from sign-in, the authorization-code flow with PKCE, offline access, a
 * refresh token sealed alone (`{refreshToken, scope}`; every session trades it for an access token
 * kept in memory). The demo's fixture-mode calendar reads through a service account instead.
 */
import { z } from 'zod';

import { compileQuery, parseQuery } from '../../../builder/compile.js';
import { QueryValidationError } from '../../../builder/errors.js';
import { validationContext } from '../../../builder/validate.js';
import { AppError } from '../../../errors/AppError.js';
import { googleCalendarAdapter } from '../../../sync/providers/google_calendar.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { ServiceAccountAuth } from '../auth/ServiceAccountAuth.js';
import { CalendarId } from './fields.js';
import { GOOGLE_CALENDAR_AUTH, type GoogleCalendarSecret } from './googleCalendarAuth.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

export {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_LIST_READONLY_SCOPE,
  GOOGLE_CALENDAR_AUTH,
  GOOGLE_CALENDAR_OAUTH,
  GOOGLE_CALENDAR_OAUTH_SCOPES,
  GOOGLE_SERVICE_ACCOUNT,
  REQUIRED_CALENDAR_SCOPES,
  type GoogleCalendarSecret,
} from './googleCalendarAuth.js';

/** The push filter as the Logic Bridge parses it, compiled against the whitelist (never run). */
function pushFilterQuery(input: unknown): unknown {
  try {
    const query = parseQuery(input);
    compileQuery(query, validationContext());
    return query;
  } catch (error) {
    if (error instanceof QueryValidationError) {
      throw new AppError(400, `config.pushFilter${error.pointer}: ${error.reason}`);
    }
    throw error;
  }
}

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
      targetCalendarId: CalendarId.optional(),
      /** A builder query, checked by the Logic Bridge (pushFilterQuery). */
      pushFilter: z.unknown().optional(),
      horizonDays: z.int().min(1).max(365).optional(),
      maxOpsPerRun: z.int().min(1).max(200).optional(),
    }),
  normalizeConfig: (config) =>
    config['pushFilter'] === undefined
      ? config
      : { ...config, pushFilter: pushFilterQuery(config['pushFilter']) },
  connection: { topic: () => 'personal', accountId: () => null, label: () => null },
  adapter: googleCalendarAdapter,
  create: {
    steps: ['calendar'],
    // Calendar events need the user's OAuth grant (the demo's service account only reads).
    authKinds: ['oauth'],
    linkAllowed: (host) => host === 'google.com' || host.endsWith('.google.com'),
    forbiddenWithOAuth: 'rejected',
  },
  picker: 'calendars',
};

export const GOOGLE_CALENDAR = new IntegrationDefinition(googleCalendar);
